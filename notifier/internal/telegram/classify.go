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
// Ordering rule (mirrors damm-thatsrekt-relayer/internal/classifier):
// infrastructure/transient patterns are checked BEFORE generic-permanent
// patterns, so a 429 with an unusual description string never falls through
// to Permanent.
package telegram

import "strings"

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
	// network hiccup). The caller should count the attempt and retry on the
	// next poll cycle.
	SendTransient
)

// ClassifySendError maps a SendMessage error to a SendClassification.
// err must be the error returned directly by Bot.SendMessage (not wrapped by
// the caller). A nil err is classified as SendPermanent to guard against
// accidental misuse.
//
// Infra/transient patterns are checked BEFORE parse-entity and generic-
// permanent patterns (relayer ordering rule).
func ClassifySendError(err error) SendClassification {
	if err == nil {
		return SendPermanent
	}
	msg := strings.ToLower(err.Error())

	// ── Infrastructure / transient patterns — checked FIRST ────────────────
	// Keep these exhaustive: any error that may self-heal belongs here.
	transientPatterns := []string{
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"connection refused",
		"connection reset",
		"dial tcp",
		"eof",
		"broken pipe",
		"timeout",
		"deadline exceeded",
		"context deadline",
		"i/o timeout",
		"temporary failure",
		// json unmarshal failure on the response body is a proxy for a
		// non-JSON (e.g. HTML gateway) response from an upstream 5xx.
		"unmarshal sendmessage",
	}
	for _, pat := range transientPatterns {
		if strings.Contains(msg, pat) {
			return SendTransient
		}
	}

	// ── Parse-entity error — specific permanent ─────────────────────────────
	// Telegram returns this when the HTML markup is syntactically invalid.
	// The exact string observed in the ethereum-38 incident (issue #262):
	//   "Bad Request: can't parse entities: Empty attribute name in the tag
	//    \"a\" at byte offset 824"
	if strings.Contains(msg, "can't parse entities") {
		return SendParseError
	}

	// ── Unknown / other 400 — permanent ────────────────────────────────────
	// Unlike the relayer (which defaults to Transient to avoid silent loss via
	// DLQ), the notifier has an attempt counter as the safety net. Unknown
	// Telegram 4xx errors are almost always permanent content issues.
	return SendPermanent
}

// IsParseError reports whether err is a Telegram "can't parse entities"
// rejection. It is a convenience wrapper around ClassifySendError for
// callers that only need to branch on the parse-error case.
func IsParseError(err error) bool {
	return ClassifySendError(err) == SendParseError
}
