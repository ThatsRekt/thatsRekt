package telegram_test

// Tests for ClassifySendError and IsParseError.
//
// Test strategy:
//   - All classification tests route through an httptest.Server returning
//     genuine Telegram-shaped JSON bodies. We do NOT test ClassifySendError
//     directly on hand-crafted error strings — that would test our own mock
//     rather than the actual error path through Bot.SendMessage.
//   - The exact incident body (ethereum-38, issue #262) is pinned to guard
//     against future Telegram API description-string drift.
//   - Helpers (serveTelegramError, newTestBot) are defined in bot_test.go and
//     shared across this package's test files.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// --- parse-entity tests ---

// TestSendMessage_ParseError_ExactIncidentBody pins the exact Telegram error
// body observed during the ethereum-38 incident (issue #262). The body must be
// classified as SendParseError so the plain-text fallback is triggered.
//
// Mutation evidence (expected test failure when guard is removed):
//
//	Sabotage: return SendPermanent from the can't-parse-entities branch.
//	Result:   IsParseError returns false → plain-text fallback never fires.
//	          TestFallback_ParseErrorTriggersPlainText goes RED.
func TestSendMessage_ParseError_ExactIncidentBody(t *testing.T) {
	// The exact JSON body Telegram returned for ethereum-38.
	srv := serveTelegramError(t, 400,
		`Bad Request: can't parse entities: Empty attribute name in the tag "a" at byte offset 824`)
	bot := newTestBot(t, srv)

	_, err := bot.SendMessage(context.Background(), "@testchan", "<b>hello</b>", "HTML", nil)
	if err == nil {
		t.Fatal("expected error from Telegram parse-entity rejection")
	}
	if !telegram.IsParseError(err) {
		t.Errorf("expected IsParseError=true for parse-entity 400, got false\nerr: %v", err)
	}
	if telegram.ClassifySendError(err) != telegram.SendParseError {
		t.Errorf("expected SendParseError, got %v", telegram.ClassifySendError(err))
	}
}

// TestSendMessage_ParseError_GenericBody covers any "can't parse entities"
// description string, not just the byte-offset variant from the incident.
func TestSendMessage_ParseError_GenericBody(t *testing.T) {
	srv := serveTelegramError(t, 400, "Bad Request: can't parse entities")
	_, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "text", "HTML", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !telegram.IsParseError(err) {
		t.Errorf("expected IsParseError=true, got false: %v", err)
	}
}

// --- rate-limit (429) tests ---

// TestSendMessage_RateLimit_IsTransient verifies that a Telegram 429
// "Too Many Requests" response is classified as SendTransient.
//
// Mutation evidence:
//
//	Sabotage: remove "too many requests" from the transient patterns in
//	          ClassifySendError.
//	Result:   ClassifySendError returns SendPermanent → service gives up
//	          immediately on a rate-limit instead of retrying.
//	          TestPoisonPill_TransientError goes RED.
func TestSendMessage_RateLimit_IsTransient(t *testing.T) {
	srv := serveTelegramError(t, 429, "Too Many Requests: retry after 30")
	_, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "text", "HTML", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if telegram.ClassifySendError(err) != telegram.SendTransient {
		t.Errorf("expected SendTransient for 429, got %v\nerr: %v", telegram.ClassifySendError(err), err)
	}
	if telegram.IsParseError(err) {
		t.Errorf("IsParseError must be false for 429")
	}
}

// --- 5xx server-error tests ---

// TestSendMessage_ServerError_NonJSON_IsTransient verifies that a non-JSON
// 5xx response (e.g. an upstream gateway HTML error page) is classified as
// SendTransient. The Bot.call method returns an unmarshal error in this case.
func TestSendMessage_ServerError_NonJSON_IsTransient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("<html><body>502 Bad Gateway</body></html>"))
	}))
	t.Cleanup(srv.Close)

	_, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "text", "HTML", nil)
	if err == nil {
		t.Fatal("expected error from non-JSON server response")
	}
	if telegram.ClassifySendError(err) != telegram.SendTransient {
		t.Errorf("expected SendTransient for non-JSON 5xx, got %v\nerr: %v", telegram.ClassifySendError(err), err)
	}
}

// TestSendMessage_PermanentChatError_IsPermanent verifies that a generic
// Telegram 400 error that is NOT a parse-entity error is classified as
// SendPermanent (e.g. "Bad Request: chat not found").
func TestSendMessage_PermanentChatError_IsPermanent(t *testing.T) {
	srv := serveTelegramError(t, 400, "Bad Request: chat not found")
	_, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "text", "HTML", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if telegram.ClassifySendError(err) != telegram.SendPermanent {
		t.Errorf("expected SendPermanent for 'chat not found', got %v", telegram.ClassifySendError(err))
	}
	if telegram.IsParseError(err) {
		t.Errorf("IsParseError must be false for 'chat not found'")
	}
}

// TestSendMessage_Success_NoError confirms the happy path: a 200 ok=true
// response does not produce any error.
func TestSendMessage_Success_NoError(t *testing.T) {
	srv := serveTelegramSuccess(t)
	msgID, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "hello", "HTML", nil)
	if err != nil {
		t.Fatalf("unexpected error on success: %v", err)
	}
	// serveTelegramSuccess returns message_id=0 (zero-value) but OK=true.
	// We just check there's no error and a non-negative ID.
	if msgID < 0 {
		t.Errorf("unexpected negative message_id: %d", msgID)
	}
}

// --- review blocker 3 (issue #262 follow-up): byte-offset collision ---

// TestSendMessage_ParseError_ByteOffsetCollisions is the required
// reproduction for review blocker 3: Telegram's parse-error description
// embeds an arbitrary byte offset ("... at byte offset N"). The old
// implementation matched bare digit substrings ("429", "500", "502", "503")
// against the ENTIRE lowercased error string, so any offset that happens to
// contain one of those digit sequences was misclassified as SendTransient
// instead of SendParseError — silently skipping the plain-text fallback.
//
// Every offset below is a real collision (16 of the 4097 offsets in
// Telegram's 0-4096 message-length range).
func TestSendMessage_ParseError_ByteOffsetCollisions(t *testing.T) {
	collidingOffsets := []int{429, 500, 502, 503, 1429, 1500, 1502, 1503, 2429, 2500, 2502, 2503, 3429, 3500, 3502, 3503}

	for _, offset := range collidingOffsets {
		offset := offset
		t.Run(fmt.Sprintf("offset_%d", offset), func(t *testing.T) {
			desc := fmt.Sprintf(`Bad Request: can't parse entities: Empty attribute name in the tag "a" at byte offset %d`, offset)
			srv := serveTelegramError(t, 400, desc)
			_, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "<b>x</b>", "HTML", nil)
			if err == nil {
				t.Fatal("expected error")
			}
			if !telegram.IsParseError(err) {
				t.Errorf("offset=%d: expected IsParseError=true, got false (err: %v)", offset, err)
			}
			if got := telegram.ClassifySendError(err); got != telegram.SendParseError {
				t.Errorf("offset=%d: expected SendParseError, got %v", offset, got)
			}
		})
	}
}

// TestSendMessage_PlainText_NoParseMode verifies that SendMessage with
// parseMode="" sends a request without a parse_mode field (Telegram accepts
// the text as plain text). The test inspects the request body.
func TestSendMessage_PlainText_NoParseMode(t *testing.T) {
	var receivedParseMode string
	var parseModePresent bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
			if pm, ok := body["parse_mode"]; ok {
				parseModePresent = true
				receivedParseMode, _ = pm.(string)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":77}}`))
	}))
	t.Cleanup(srv.Close)

	msgID, err := newTestBot(t, srv).SendMessage(context.Background(), "@chan", "plain text", "", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msgID != 77 {
		t.Errorf("expected message_id=77, got %d", msgID)
	}
	// parse_mode must be ABSENT from the JSON body when parseMode="", because
	// sendMessageReq.ParseMode has `json:"parse_mode,omitempty"`.
	if parseModePresent {
		t.Errorf("expected parse_mode to be absent from request body (omitempty), got %q", receivedParseMode)
	}
}
