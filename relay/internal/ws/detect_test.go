package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newDetectTestServer mirrors newTestServer but additionally wires
// /detect onto the same mux. Returns the test server, the /detect URL,
// and the /post URL (used by cross-transport dedup tests).
func newDetectTestServer(t *testing.T, sub Submitter) (*httptest.Server, string, string) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(ServerConfig{
		Logger:      logger,
		Submitter:   sub,
		AuthToken:   "dev-secret",
		DedupWindow: time.Minute,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/post", srv.HandleHTTP)
	mux.HandleFunc("/detect", srv.HandleDetect)
	httpSrv := httptest.NewServer(mux)
	t.Cleanup(httpSrv.Close)
	return httpSrv, httpSrv.URL + "/detect", httpSrv.URL + "/post"
}

// validHeaders returns a set of standard headers for a happy-path
// /detect request. Tests mutate as needed.
func validHeaders(idemKey, chain string) map[string]string {
	now := time.Now().UTC().Format(time.RFC3339)
	return map[string]string{
		"Authorization":     "Bearer dev-secret",
		"Content-Type":      "text/plain",
		HdrIdempotencyKey:   idemKey,
		HdrTweetURL:         "https://x.com/test/status/" + idemKey,
		HdrTweetAccount:     "test_account",
		HdrTweetTimestamp:   now,
		HdrChain:            chain,
		HdrProtocol:         "Aave",
	}
}

func defaultBody() []byte {
	return []byte("Aave V3 pool drained via flashloan exploit. Funds at risk.")
}

// postDetect performs an HTTP POST against url with the given headers
// and body, returning status + parsed Response + raw bytes.
func postDetect(t *testing.T, url string, headers map[string]string, body []byte) (int, Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	var parsed Response
	_ = json.Unmarshal(respBody, &parsed)
	return resp.StatusCode, parsed, respBody
}

func TestDetect_RejectsGET(t *testing.T) {
	_, detectURL, _ := newDetectTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	req, _ := http.NewRequest(http.MethodGet, detectURL, nil)
	req.Header.Set("Authorization", "Bearer dev-secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status: %d", resp.StatusCode)
	}
}

func TestDetect_RejectsBadAuth(t *testing.T) {
	_, detectURL, _ := newDetectTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	headers := validHeaders("a", "base")
	headers["Authorization"] = "Bearer wrong"
	status, _, _ := postDetect(t, detectURL, headers, defaultBody())
	if status != http.StatusUnauthorized {
		t.Fatalf("status: %d", status)
	}
}

func TestDetect_HappyPath_Submits(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, detectURL, _ := newDetectTestServer(t, sub)
	status, resp, body := postDetect(t, detectURL, validHeaders("tweet-1", "base"), defaultBody())
	if status != http.StatusOK {
		t.Fatalf("status: %d body=%s", status, body)
	}
	if resp.Type != TypeAck {
		t.Fatalf("type: %q err=%q", resp.Type, resp.Error)
	}
	if resp.MsgID != "tweet-1" {
		t.Fatalf("msg_id: %q", resp.MsgID)
	}
	if sub.calls.Load() != 1 {
		t.Fatalf("submitter calls: %d", sub.calls.Load())
	}
}

func TestDetect_RejectsEmptyBody(t *testing.T) {
	_, detectURL, _ := newDetectTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	status, resp, _ := postDetect(t, detectURL, validHeaders("a", "base"), []byte("   \n\t  "))
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if !strings.Contains(strings.ToLower(resp.Error), "body") || !strings.Contains(strings.ToLower(resp.Error), "empty") {
		t.Fatalf("error: %q", resp.Error)
	}
}

func TestDetect_RejectsUnknownChain(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, detectURL, _ := newDetectTestServer(t, sub)
	status, resp, _ := postDetect(t, detectURL, validHeaders("a", "ethereum"), defaultBody())
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if !strings.Contains(resp.Error, "chain") {
		t.Fatalf("error: %q", resp.Error)
	}
	if sub.calls.Load() != 0 {
		t.Fatalf("submitter must not be called: %d", sub.calls.Load())
	}
}

func TestDetect_RejectsMissingHeaders(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, detectURL, _ := newDetectTestServer(t, sub)

	cases := []struct {
		name     string
		stripKey string
	}{
		{"no idempotency key", HdrIdempotencyKey},
		{"no tweet url", HdrTweetURL},
		{"no tweet timestamp", HdrTweetTimestamp},
		{"no chain", HdrChain},
		{"no protocol", HdrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := validHeaders("a", "base")
			delete(h, tc.stripKey)
			status, resp, _ := postDetect(t, detectURL, h, defaultBody())
			if status != http.StatusBadRequest {
				t.Fatalf("status: %d", status)
			}
			if !strings.Contains(resp.Error, tc.stripKey) {
				t.Fatalf("error should mention %s, got %q", tc.stripKey, resp.Error)
			}
		})
	}
}

func TestDetect_AcceptsUnixSecondsTimestamp(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, detectURL, _ := newDetectTestServer(t, sub)
	h := validHeaders("a", "base")
	h[HdrTweetTimestamp] = "1777340000" // unix seconds
	status, resp, _ := postDetect(t, detectURL, h, defaultBody())
	if status != http.StatusOK {
		t.Fatalf("status: %d err=%q", status, resp.Error)
	}
}

func TestDetect_RejectsFutureTimestamp(t *testing.T) {
	_, detectURL, _ := newDetectTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	h := validHeaders("a", "base")
	h[HdrTweetTimestamp] = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	status, resp, _ := postDetect(t, detectURL, h, defaultBody())
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if !strings.Contains(resp.Error, "future") {
		t.Fatalf("error: %q", resp.Error)
	}
}

func TestDetect_RejectsZeroTimestamp(t *testing.T) {
	_, detectURL, _ := newDetectTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	h := validHeaders("a", "base")
	h[HdrTweetTimestamp] = "0"
	status, resp, _ := postDetect(t, detectURL, h, defaultBody())
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if !strings.Contains(resp.Error, "0") && !strings.Contains(resp.Error, "must") {
		t.Fatalf("error: %q", resp.Error)
	}
}

func TestDetect_DedupReplay(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, detectURL, _ := newDetectTestServer(t, sub)

	first, _, _ := postDetect(t, detectURL, validHeaders("dup", "base"), defaultBody())
	if first != http.StatusOK {
		t.Fatalf("first: %d", first)
	}
	second, resp, _ := postDetect(t, detectURL, validHeaders("dup", "base"), defaultBody())
	if second != http.StatusOK {
		t.Fatalf("second: %d", second)
	}
	if resp.Type != TypeAck {
		t.Fatalf("type: %q", resp.Type)
	}
	if got := sub.calls.Load(); got != 1 {
		t.Fatalf("submitter must run exactly once, got %d", got)
	}
}

// TestDetect_DedupSharesCacheWithPost — same idempotency key over /detect
// then /post must replay the cached response. Proves the dedup ring is
// transport-agnostic.
func TestDetect_DedupSharesCacheWithPost(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, detectURL, postURL := newDetectTestServer(t, sub)

	status, _, _ := postDetect(t, detectURL, validHeaders("cross", "base"), defaultBody())
	if status != http.StatusOK {
		t.Fatalf("first: %d", status)
	}

	// /post with the same id. Should be cached replay — submitter
	// must NOT be called twice.
	envelope := map[string]any{
		"type":      "post.create",
		"id":        "cross",
		"timestamp": "t",
		"payload": map[string]any{
			"chains":      []string{"base"},
			"title":       "different",
			"attackers":   []string{},
			"victims":     []string{},
			"note":        "different",
			"attacked_at": 1,
		},
	}
	envBody, _ := json.Marshal(envelope)
	req, _ := http.NewRequest(http.MethodPost, postURL, bytes.NewReader(envBody))
	req.Header.Set("Authorization", "Bearer dev-secret")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if got := sub.calls.Load(); got != 1 {
		t.Fatalf("cross-transport: submitter must run once, got %d", got)
	}
}

func TestDetect_BodyTooLarge(t *testing.T) {
	_, detectURL, _ := newDetectTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	huge := bytes.Repeat([]byte("x"), detectMaxBodyBytes+1024)
	status, _, _ := postDetect(t, detectURL, validHeaders("a", "base"), huge)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status: %d", status)
	}
}

// Title synthesis tests — the relay generates the on-chain title from
// X-Protocol + a sanitized snippet of the tweet body.

func TestBuildSynthesizedTitle_ShortTweet(t *testing.T) {
	got := buildSynthesizedTitle("Aave", "flashloan exploit drains pool")
	want := "Aave — flashloan exploit drains pool"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuildSynthesizedTitle_CollapsesWhitespace(t *testing.T) {
	got := buildSynthesizedTitle("Lido", "\n\nstETH\tdepeg\r\nat 0.95")
	want := "Lido — stETH depeg at 0.95"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestBuildSynthesizedTitle_TruncatesToCap(t *testing.T) {
	long := strings.Repeat("A", 500)
	got := buildSynthesizedTitle("Aave", long)
	if len(got) > titleMaxBytesPreflight {
		t.Fatalf("title is %d bytes, max %d: %q", len(got), titleMaxBytesPreflight, got)
	}
	if !strings.HasPrefix(got, "Aave — ") {
		t.Fatalf("missing prefix: %q", got)
	}
}

func TestBuildSynthesizedTitle_RespectsUTF8(t *testing.T) {
	// 30 copies of a 4-byte rune = 120 bytes. With the "Aave — " prefix
	// (8 bytes ASCII), total = 128 — under the cap. Just sanity-check
	// no rune is split. Use a longer string to actually trigger
	// truncation.
	rune4 := "🚀" // 4 UTF-8 bytes
	longEmoji := strings.Repeat(rune4, 200) // 800 bytes
	got := buildSynthesizedTitle("Aave", longEmoji)
	if !utf8ValidLen(got) {
		t.Fatalf("title contains an invalid UTF-8 sequence: %q (bytes=%d)", got, len(got))
	}
	if len(got) > titleMaxBytesPreflight {
		t.Fatalf("over cap: %d", len(got))
	}
}

func utf8ValidLen(s string) bool {
	for i := 0; i < len(s); {
		_, size := decodeRune(s[i:])
		if size == 0 {
			return false
		}
		i += size
	}
	return true
}

// decodeRune avoids importing unicode/utf8 in the test file just to
// re-export DecodeRuneInString. We could but this is fine.
func decodeRune(s string) (rune, int) {
	if len(s) == 0 {
		return 0, 0
	}
	b := s[0]
	switch {
	case b < 0x80:
		return rune(b), 1
	case b < 0xC2:
		return 0, 0 // invalid lead byte
	case b < 0xE0:
		if len(s) < 2 {
			return 0, 0
		}
		return rune(b&0x1F)<<6 | rune(s[1]&0x3F), 2
	case b < 0xF0:
		if len(s) < 3 {
			return 0, 0
		}
		return rune(b&0x0F)<<12 | rune(s[1]&0x3F)<<6 | rune(s[2]&0x3F), 3
	default:
		if len(s) < 4 {
			return 0, 0
		}
		return rune(b&0x07)<<18 | rune(s[1]&0x3F)<<12 | rune(s[2]&0x3F)<<6 | rune(s[3]&0x3F), 4
	}
}

func TestParseImagesHeader(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", nil},
		{"whitespace", "   ", nil},
		{"single url", "https://pbs.twimg.com/media/abc.jpg", []string{"https://pbs.twimg.com/media/abc.jpg"}},
		{
			"json array",
			`["https://pbs.twimg.com/media/a.jpg","https://pbs.twimg.com/media/b.jpg"]`,
			[]string{"https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"},
		},
		{
			"comma separated",
			"https://pbs.twimg.com/media/a.jpg,https://pbs.twimg.com/media/b.jpg",
			[]string{"https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"},
		},
		{
			"unquoted bracket form",
			"[https://pbs.twimg.com/media/a.jpg, https://pbs.twimg.com/media/b.jpg]",
			[]string{"https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"},
		},
		{"non-url entries dropped", `["not-a-url", "https://x.com/img"]`, []string{"https://x.com/img"}},
		{"no scheme rejected", "pbs.twimg.com/img.jpg", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseImagesHeader(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("got[%d]=%q, want %q", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestDetect_AppendsImagesToNote(t *testing.T) {
	// We can't easily inspect the note from the HTTP layer without
	// instrumenting the submitter, so we use a recording fakeSubmitter
	// that captures the payload it sees.
	rec := &recordingSubmitter{chains: map[string]bool{"base": true}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(ServerConfig{
		Logger:      logger,
		Submitter:   rec,
		AuthToken:   "dev-secret",
		DedupWindow: time.Minute,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/detect", srv.HandleDetect)
	httpSrv := httptest.NewServer(mux)
	t.Cleanup(httpSrv.Close)

	headers := validHeaders("img-1", "base")
	headers[HdrTweetImages] = `["https://pbs.twimg.com/media/a.jpg","https://pbs.twimg.com/media/b.jpg"]`
	status, _, _ := postDetect(t, httpSrv.URL+"/detect", headers, []byte("Aave drained"))
	if status != http.StatusOK {
		t.Fatalf("status: %d", status)
	}
	if rec.lastPayload.Note == "" {
		t.Fatal("payload note empty")
	}
	if !strings.Contains(rec.lastPayload.Note, "https://pbs.twimg.com/media/a.jpg") {
		t.Errorf("note missing image a: %q", rec.lastPayload.Note)
	}
	if !strings.Contains(rec.lastPayload.Note, "https://pbs.twimg.com/media/b.jpg") {
		t.Errorf("note missing image b: %q", rec.lastPayload.Note)
	}
}

func TestDetect_OmitsImagesIfHeaderMissing(t *testing.T) {
	rec := &recordingSubmitter{chains: map[string]bool{"base": true}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(ServerConfig{
		Logger:      logger,
		Submitter:   rec,
		AuthToken:   "dev-secret",
		DedupWindow: time.Minute,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/detect", srv.HandleDetect)
	httpSrv := httptest.NewServer(mux)
	t.Cleanup(httpSrv.Close)

	// validHeaders does not set HdrTweetImages — image forwarding is
	// optional. Note should contain just tweet + URL, no extra lines.
	status, _, _ := postDetect(t, httpSrv.URL+"/detect", validHeaders("img-noimg", "base"), []byte("Aave drained"))
	if status != http.StatusOK {
		t.Fatalf("status: %d", status)
	}
	if c := strings.Count(rec.lastPayload.Note, "\n"); c != 1 {
		t.Errorf("note should have exactly 1 newline (tweet\\nurl), got %d. Note: %q", c, rec.lastPayload.Note)
	}
}

// recordingSubmitter captures the most recent payload it sees.
type recordingSubmitter struct {
	chains      map[string]bool
	lastPayload PostCreatePayload
}

func (r *recordingSubmitter) SubmitPostCreate(_ context.Context, payload PostCreatePayload) []SubmissionResult {
	r.lastPayload = payload
	out := make([]SubmissionResult, len(payload.Chains))
	for i, c := range payload.Chains {
		out[i] = SubmissionResult{Chain: c, Status: "submitted", TxHash: "0xtx", PostID: "1"}
	}
	return out
}

func (r *recordingSubmitter) HasChain(name string) bool { return r.chains[name] }

func TestParseAttackedAt_RFC3339(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	got, err := parseAttackedAt(now)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got == 0 {
		t.Fatal("zero")
	}
}

func TestParseAttackedAt_UnixSeconds(t *testing.T) {
	got, err := parseAttackedAt("1777340000")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != 1777340000 {
		t.Fatalf("got: %d", got)
	}
}

func TestParseAttackedAt_RejectsZero(t *testing.T) {
	if _, err := parseAttackedAt("0"); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseAttackedAt_RejectsFuture(t *testing.T) {
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if _, err := parseAttackedAt(future); err == nil {
		t.Fatal("expected error")
	}
}
