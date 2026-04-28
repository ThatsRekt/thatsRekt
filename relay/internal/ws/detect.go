package ws

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// detectMaxBodyBytes caps the size of a single /detect request body.
// The body is the raw tweet content (X caps tweets at 280 chars for
// most accounts, ~10K for premium long-form). 64 KiB is a generous
// ceiling that rejects accidental abuse without ever clipping a real
// tweet.
const detectMaxBodyBytes = 64 * 1024

// titleMaxBytesPreflight mirrors the contract's MAX_TITLE_LENGTH so we
// can short-circuit obviously-doomed posts before burning a tx.
const titleMaxBytesPreflight = 200

// detectHeaderKey constants. Defined here so tests + clients use the
// same literals; mismatches between the workflow and the relay are a
// silent failure mode we want to avoid.
const (
	HdrIdempotencyKey = "X-Idempotency-Key"
	HdrTweetURL       = "X-Tweet-URL"
	HdrTweetAccount   = "X-Tweet-Account"
	HdrTweetTimestamp = "X-Tweet-Timestamp"
	HdrChain          = "X-Chain"
	HdrProtocol       = "X-Protocol"
	// Optional. Otomato emits the X trigger's `images` array as a string
	// representation in the header value; the relay parses defensively
	// (JSON array → comma-split → empty fallback) so the workflow
	// doesn't have to know which form Otomato chose.
	HdrTweetImages = "X-Tweet-Images"
)

// HandleDetect is the http.HandlerFunc for the /detect endpoint —
// purpose-built for the Otomato workflow whose AI block emits a plain
// boolean ("true"/"false") and whose HTTP_REQUEST action does dumb
// variable substitution on body strings.
//
// The shape is **plain-text body, metadata in headers**:
//
//	POST /detect
//	Authorization: Bearer <token>
//	Content-Type: text/plain (anything; ignored)
//	X-Idempotency-Key: <stable id, e.g. tweetId>
//	X-Tweet-URL:       <tweetURL>
//	X-Tweet-Account:   <handle>
//	X-Tweet-Timestamp: <ISO 8601 OR unix seconds>
//	X-Chain:           <one of relay's configured chains>
//	X-Protocol:        <protocol name, e.g. "Aave">
//
//	body: <raw tweet text>
//
// The relay synthesizes the on-chain title server-side from the
// protocol header + a sanitized tweet snippet. attackers[]/victims[]
// are empty for v1 (a future enhancement is regex-extraction of
// 0x-prefixed 40-hex-char strings from the tweet body — but only as a
// future thing; relay-side address extraction is risky and we'd
// rather post a clean title-only alert than guess).
//
// Status codes:
//
//	200 OK            — submitted (or replayed from dedup cache)
//	400 Bad Request   — header missing, body empty, chain not configured
//	401 Unauthorized  — missing or wrong bearer
//	405 Method        — non-POST
//	413 Payload Too Large — body > detectMaxBodyBytes
//	502 Bad Gateway   — submission failed downstream
func (s *Server) HandleDetect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(r) {
		s.logger.Warn("detect rejected: bad auth", "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Header validation first — cheaper than body read; lets a misuse
	// bail out without ever allocating bytes for the body.
	idemKey := strings.TrimSpace(r.Header.Get(HdrIdempotencyKey))
	tweetURL := strings.TrimSpace(r.Header.Get(HdrTweetURL))
	tweetAccount := strings.TrimSpace(r.Header.Get(HdrTweetAccount))
	tweetTSRaw := strings.TrimSpace(r.Header.Get(HdrTweetTimestamp))
	chain := strings.TrimSpace(r.Header.Get(HdrChain))
	protocol := strings.TrimSpace(r.Header.Get(HdrProtocol))

	if idemKey == "" {
		writeDetectError(w, http.StatusBadRequest, "", "missing "+HdrIdempotencyKey)
		return
	}
	if tweetURL == "" {
		writeDetectError(w, http.StatusBadRequest, idemKey, "missing "+HdrTweetURL)
		return
	}
	if tweetTSRaw == "" {
		writeDetectError(w, http.StatusBadRequest, idemKey, "missing "+HdrTweetTimestamp)
		return
	}
	if chain == "" {
		writeDetectError(w, http.StatusBadRequest, idemKey, "missing "+HdrChain)
		return
	}
	if protocol == "" {
		writeDetectError(w, http.StatusBadRequest, idemKey, "missing "+HdrProtocol)
		return
	}
	if !s.submitter.HasChain(chain) {
		writeDetectError(w, http.StatusBadRequest, idemKey, "chain not configured: "+chain)
		return
	}

	attackedAt, err := parseAttackedAt(tweetTSRaw)
	if err != nil {
		writeDetectError(w, http.StatusBadRequest, idemKey,
			fmt.Sprintf("%s parse: %v", HdrTweetTimestamp, err))
		return
	}

	// Body — capped + read as raw text. No structural validation —
	// tweets are free-form text and may include any unicode, emoji,
	// quotes, etc.
	r.Body = http.MaxBytesReader(w, r.Body, detectMaxBodyBytes)
	defer func() { _ = r.Body.Close() }()
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			s.logger.Warn("detect body too large", "limit", detectMaxBodyBytes, "msg_id", idemKey)
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		writeDetectError(w, http.StatusBadRequest, idemKey, "body read failed")
		return
	}
	tweetContent := strings.TrimSpace(string(raw))
	if tweetContent == "" {
		writeDetectError(w, http.StatusBadRequest, idemKey, "body is empty")
		return
	}

	// Optional: parse the images header. Otomato may serialize the
	// array as JSON (`["url1","url2"]`) or comma-separated; we accept
	// either. Empty / unparseable → no images, log and continue.
	imageURLs := parseImagesHeader(r.Header.Get(HdrTweetImages))

	title := buildSynthesizedTitle(protocol, tweetContent)
	note := buildNote(tweetContent, tweetURL, imageURLs)

	envelope := Envelope{
		Type:      TypePostCreate,
		ID:        idemKey,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	payload := PostCreatePayload{
		Chains:     []string{chain},
		Title:      title,
		Attackers:  []string{},
		Victims:    []string{},
		Note:       note,
		AttackedAt: attackedAt,
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		s.logger.Error("detect payload marshal failed", "err", err)
		writeDetectError(w, http.StatusInternalServerError, idemKey, "internal marshal error")
		return
	}
	envelope.Payload = payloadJSON

	envJSON, err := json.Marshal(envelope)
	if err != nil {
		s.logger.Error("detect envelope marshal failed", "err", err)
		writeDetectError(w, http.StatusInternalServerError, idemKey, "internal marshal error")
		return
	}

	s.logger.Info("detect received",
		"msg_id", idemKey, "protocol", protocol, "chain", chain,
		"account", tweetAccount, "tweet_url", tweetURL,
		"title_bytes", len(title), "tweet_bytes", len(tweetContent),
	)

	resp := s.ProcessEnvelope(r.Context(), envJSON)

	status := http.StatusOK
	switch resp.Type {
	case TypeAck:
		status = http.StatusOK
	case TypeNack:
		// /detect uses the same convention as /post: validation failure
		// → 400, submission failure → 502. We pre-validated above, so
		// most nacks here are submission-side.
		if len(resp.Results) == 0 {
			status = http.StatusBadRequest
		} else {
			status = http.StatusBadGateway
		}
	default:
		status = http.StatusInternalServerError
	}

	body, err := EncodeResponse(resp)
	if err != nil {
		s.logger.Error("detect response encode failed", "err", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"type":"nack","error":"response encode failed"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// buildSynthesizedTitle composes the on-chain title from the protocol
// name plus a sanitized tweet snippet. Format: `<Protocol> — <snippet>`.
//
// The snippet is the tweet text with control chars + newlines collapsed
// to spaces, then truncated to fit the contract's MAX_TITLE_LENGTH
// (200 bytes). UTF-8 boundaries are respected: we never split a multi-
// byte rune mid-sequence.
func buildSynthesizedTitle(protocol, tweet string) string {
	const sep = " — "
	cleaned := collapseWhitespace(tweet)

	prefix := protocol + sep
	// Reserve at least one rune of body. If the protocol name alone is
	// already too long, truncate the protocol header (rare — we
	// reject outright at the next layer).
	if utf8.RuneCountInString(prefix) >= titleMaxBytesPreflight {
		return truncateUTF8(protocol, titleMaxBytesPreflight)
	}

	budget := titleMaxBytesPreflight - len(prefix)
	if budget <= 0 {
		return truncateUTF8(prefix, titleMaxBytesPreflight)
	}
	body := truncateUTF8(cleaned, budget)
	return prefix + body
}

// buildNote returns the on-chain note: tweet content, tweet URL, and
// any image URLs, each separated by a newline. The note has no relay-
// side cap; the contract has no per-note size limit beyond gas. The
// frontend renders the note verbatim and detects image URLs by file
// extension.
func buildNote(tweet, url string, imageURLs []string) string {
	parts := []string{strings.TrimSpace(tweet), url}
	for _, img := range imageURLs {
		if img != "" {
			parts = append(parts, img)
		}
	}
	return strings.Join(parts, "\n")
}

// parseImagesHeader extracts a list of image URLs from the
// `X-Tweet-Images` header. Otomato's runtime serialization of an array
// in a header value isn't documented, so we accept multiple forms:
//
//   - JSON array string: `["url1","url2"]`
//   - Comma-separated:   `url1,url2`
//   - Empty / whitespace: returns an empty slice
//
// Each candidate is trimmed; entries that don't look like URLs (no
// scheme, no host) are dropped. The relay does NOT fetch or download
// images — it simply forwards the URL strings into the on-chain note
// for the frontend to render.
func parseImagesHeader(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	// Try JSON array first.
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		var parsed []string
		if err := jsonUnmarshalString(raw, &parsed); err == nil {
			return filterImageURLs(parsed)
		}
		// Fall through to comma-split if JSON parsing fails — Otomato
		// may have serialized as `[url, url]` without quotes.
	}
	// Strip enclosing brackets if any survived.
	raw = strings.TrimPrefix(raw, "[")
	raw = strings.TrimSuffix(raw, "]")
	parts := strings.Split(raw, ",")
	for i, p := range parts {
		parts[i] = strings.TrimSpace(strings.Trim(p, `"`))
	}
	return filterImageURLs(parts)
}

// filterImageURLs drops empty strings and entries that don't begin
// with `http://` or `https://`. We don't validate further (e.g. file
// extension) — many tweet-image CDN URLs don't have a `.jpg` suffix.
func filterImageURLs(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
			continue
		}
		out = append(out, s)
	}
	return out
}

// jsonUnmarshalString is a small wrapper that exists so test files can
// avoid importing encoding/json just to parse a header in setup. (No
// real reason — kept for symmetry with parseImagesHeader being the
// public API.)
func jsonUnmarshalString(raw string, out *[]string) error {
	return json.Unmarshal([]byte(raw), out)
}

// collapseWhitespace replaces runs of whitespace (including newlines,
// tabs, control chars) with a single space. Used for title synthesis
// where we want a single-line summary, not a paragraph.
var whitespaceRun = regexp.MustCompile(`[\s\x00-\x1f\x7f]+`)

func collapseWhitespace(s string) string {
	return strings.TrimSpace(whitespaceRun.ReplaceAllString(s, " "))
}

// truncateUTF8 cuts s to at most n bytes, never splitting a multi-byte
// UTF-8 sequence. Returns the longest valid prefix that fits.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Walk back from byte n until we land on a rune start.
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// parseAttackedAt accepts either an RFC3339 timestamp ("2026-04-28T00:00:00Z")
// or a bare unix-seconds integer ("1777340000"). Otomato's X trigger
// emits ISO 8601 today; some integrators may prefer to send unix
// seconds; supporting both keeps the contract flexible without us
// inventing a third format.
//
// Returns unix seconds. Rejects 0 (mirrors contract's revert) and
// future timestamps tolerantly — anything > now+5min is rejected so
// a clock-skewed sender can't poison attacked_at.
func parseAttackedAt(raw string) (uint64, error) {
	if raw == "" {
		return 0, errors.New("empty")
	}
	if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
		return validateAttackedAt(n)
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return 0, fmt.Errorf("not RFC3339 or unix seconds: %v", err)
	}
	return validateAttackedAt(t.Unix())
}

// validateAttackedAt enforces the temporal invariants. Future timestamps
// (with a 5min skew tolerance) are rejected to mirror the contract,
// which reverts on attackedAt > block.timestamp.
func validateAttackedAt(secs int64) (uint64, error) {
	if secs <= 0 {
		return 0, errors.New("must be > 0")
	}
	const skewSeconds = 5 * 60
	if secs > time.Now().Unix()+skewSeconds {
		return 0, errors.New("more than 5 minutes in the future")
	}
	return uint64(secs), nil
}

// writeDetectError emits a JSON nack with the appropriate status code.
func writeDetectError(w http.ResponseWriter, status int, msgID, errStr string) {
	resp := Response{Type: TypeNack, MsgID: msgID, Error: errStr}
	body, _ := EncodeResponse(resp)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
