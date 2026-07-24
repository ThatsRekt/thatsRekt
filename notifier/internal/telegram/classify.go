// Package telegram — minimal Bot API client and error classifier.
//
// This file provides error classification for SendMessage failures so callers
// can distinguish between:
//
//   - ParseError: Telegram rejected the HTML markup ("can't parse entities").
//     The same payload will fail on every retry. The correct recovery is to
//     strip markup and retry exactly once with plain text.
//
//   - Transient: rate-limit (429), server error (5xx), or network failure.
//     The error may self-heal on the next poll cycle.
//
//   - Permanent: any other deterministic Telegram error (wrong chat_id, bot
//     blocked, etc.). Retrying will not help.
//
// Classification strategy (issue #262 review, PR #265 blocker 3):
//
// A real Telegram API failure — Bot.SendMessage got an HTTP response and
// decoded it as JSON with ok=false — surfaces as *SendAPIError, carrying the
// parsed HTTP status and Telegram's own error_code field. Classification for
// that case is purely numeric (classifyAPIError): parse-entity errors are
// detected via a whole-phrase description match, and rate-limit/server-error
// codes are matched against the structured, already-parsed status code —
// never against a formatted string. This is what actually closes blocker 3:
// the previous implementation matched bare digit substrings ("429", "500",
// "502", "503") against the ENTIRE lowercased error string, which collided
// with byte offsets embedded in the parse-error description itself (16 of
// the 4097 possible offsets in Telegram's message-length range contain one
// of those digit sequences and were silently misclassified as transient —
// which, after the classification result started being consumed, would have
// meant an unbounded retry loop, exactly the bug issue #262 exists to kill).
//
// Any error that is NOT a *SendAPIError — a transport failure before a
// response was ever parsed (dial/timeout/connection reset), or a body that
// didn't even decode as JSON (e.g. an upstream gateway's HTML error page) —
// is not a structured Telegram response telling us the payload itself is
// invalid. It is symptomatic of infrastructure trouble that may self-heal.
// Default to SendTransient (mirrors damm-thatsrekt-relayer/internal/classifier:
// unknown ⇒ Transient, so the operator sees repeated retries in the logs
// rather than a silently dropped alert).
package telegram

import (
	"errors"
	"strings"
)

// SendClassification describes how the caller should handle a failed
// SendMessage call.
type SendClassification int

const (
	// SendPermanent means the error is deterministic — retrying the same
	// payload will not succeed. The caller should give up on this message
	// after any available fallback is exhausted.
	SendPermanent SendClassification = iota

	// SendParseError is a sub-class of permanent: Telegram rejected the text
	// because the HTML markup is invalid ("can't parse entities"). The caller
	// SHOULD retry exactly once with markup stripped; retrying the same HTML
	// will fail identically every time.
	SendParseError

	// SendTransient means the error may self-heal (rate limit, server error,
	// network hiccup). The caller must NOT count this against a bounded
	// attempt budget — see notifier.Service, issue #262 review blocker 1.
	SendTransient
)

// ClassifySendError maps a SendMessage error to a SendClassification. err
// must be the error returned directly by Bot.SendMessage (not wrapped by the
// caller, though errors.As traversal means one extra layer of fmt.Errorf
// %w-wrapping is still handled correctly). A nil err is classified as
// SendPermanent to guard against accidental misuse.
//
// See the package comment for the full classification strategy.
func ClassifySendError(err error) SendClassification {
	if err == nil {
		return SendPermanent
	}

	var apiErr *SendAPIError
	if errors.As(err, &apiErr) {
		return classifyAPIError(apiErr)
	}

	// Not a structured API response — see package comment.
	return SendTransient
}

// classifyAPIError classifies a structured Telegram Bot API error response.
// The parse-entity check runs FIRST — a parse error is never transient
// regardless of what byte offset or other digits happen to appear in its
// description (relayer ordering rule; see the package comment).
func classifyAPIError(e *SendAPIError) SendClassification {
	if strings.Contains(strings.ToLower(e.Description), "can't parse entities") {
		return SendParseError
	}
	if isTransientCode(e.ErrorCode) || isTransientCode(e.StatusCode) {
		return SendTransient
	}
	return SendPermanent
}

// isTransientCode reports whether an HTTP/Telegram error_code is one that
// commonly self-heals: rate-limit (429) or upstream server trouble (5xx
// gateway family). Telegram's error_code mirrors the HTTP status in
// practice; SendAPIError keeps both fields and this is checked against each
// independently in case they ever diverge.
func isTransientCode(code int) bool {
	switch code {
	case 429, 500, 502, 503:
		return true
	default:
		return false
	}
}

// IsParseError reports whether err is a Telegram "can't parse entities"
// rejection. It is a convenience wrapper around ClassifySendError for
// callers that only need to branch on the parse-error case.
func IsParseError(err error) bool {
	return ClassifySendError(err) == SendParseError
}
