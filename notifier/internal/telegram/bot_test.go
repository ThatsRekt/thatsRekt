// Package telegram_test — integration-level tests for Bot.EditMessageText
// error classification.
//
// These tests use httptest.NewServer to serve the exact Telegram Bot API
// error responses observed in production, and assert that EditMessageText
// returns the correct ErrTerminalEdit variant (or a plain error for transient
// failures).
//
// Why real strings matter: classifyTerminalEdit uses substring matching on
// the Telegram-supplied description field. Word order is significant — the
// live API sends "message can't be edited" NOT "can't edit message" (the
// previous string, which silently never matched). These tests pin the exact
// strings so a future refactor can't re-introduce the mismatch silently.
//
// Mutation evidence (sabotage classifyTerminalEdit to always return false):
//
//	--- FAIL: TestEditMessageText_TerminalClassification/message_to_edit_not_found
//	    bot_test.go:NN: expected *ErrTerminalEdit, got: editMessageText: Bad Request: message to edit not found
//	--- FAIL: TestEditMessageText_TerminalClassification/message_cant_be_edited
//	    bot_test.go:NN: expected *ErrTerminalEdit, got: editMessageText: Bad Request: message can't be edited
package telegram_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// telegramResp is the shape of a Telegram Bot API error response.
type telegramResp struct {
	OK          bool   `json:"ok"`
	ErrorCode   int    `json:"error_code"`
	Description string `json:"description"`
}

// serveTelegramError returns an httptest.Server that replies to every POST
// with a Telegram Bot API error envelope carrying the given description and
// HTTP status code.
func serveTelegramError(t *testing.T, httpStatus int, description string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		_ = json.NewEncoder(w).Encode(telegramResp{
			OK:          false,
			ErrorCode:   httpStatus,
			Description: description,
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// serveTelegramSuccess returns an httptest.Server that replies with ok=true and
// result.message_id=1 — simulates a successful sendMessage or editMessageText.
func serveTelegramSuccess(t *testing.T) *httptest.Server {
	t.Helper()
	type successResp struct {
		OK     bool `json:"ok"`
		Result struct {
			MessageID int64 `json:"message_id"`
		} `json:"result"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(successResp{OK: true})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newTestBot creates a Bot pointing at srv.URL so calls never reach the real
// Telegram API.
func newTestBot(t *testing.T, srv *httptest.Server) *telegram.Bot {
	t.Helper()
	bot := telegram.NewBot("test-token")
	bot.APIBase = srv.URL
	bot.HTTP = srv.Client()
	return bot
}

func TestEditMessageText_TerminalClassification(t *testing.T) {
	type tc struct {
		name        string
		description string
		httpStatus  int
		wantGone    bool   // expected ErrTerminalEdit.MessageGone
		wantTermErr bool   // expected errors.As(*ErrTerminalEdit)
		wantNilErr  bool   // expected nil error (success or "not modified")
	}

	cases := []tc{
		{
			// Message was deleted or never existed.
			name:        "message_to_edit_not_found",
			description: "Bad Request: message to edit not found",
			httpStatus:  400,
			wantTermErr: true,
			wantGone:    true,
		},
		{
			// MTProto error forwarded to Bot API — message does not exist.
			name:        "MESSAGE_ID_INVALID",
			description: "Bad Request: MESSAGE_ID_INVALID",
			httpStatus:  400,
			wantTermErr: true,
			wantGone:    true,
		},
		{
			// Message exists but edit window has expired (>48 h). NOT gone.
			// The bot cannot edit; a human must retract manually.
			// CORRECT Telegram string: "message can't be edited" — NOT
			// "can't edit message" (the previous, broken substring).
			name:        "message_cant_be_edited",
			description: "Bad Request: message can't be edited",
			httpStatus:  400,
			wantTermErr: true,
			wantGone:    false, // message still exists, still visible
		},
		{
			// Bot was demoted and lost the "Edit Messages" admin right.
			name:        "not_enough_rights_to_edit",
			description: "Bad Request: not enough rights to edit message",
			httpStatus:  400,
			wantTermErr: true,
			wantGone:    false, // message still exists, still visible
		},
		{
			// New text identical to current text — treated as success (no-op).
			name:        "message_is_not_modified",
			description: "Bad Request: message is not modified",
			httpStatus:  400,
			wantNilErr:  true,
		},
		{
			// Rate-limit — transient, must not be classified as terminal.
			name:        "too_many_requests",
			description: "Too Many Requests: retry after 30",
			httpStatus:  429,
			wantTermErr: false,
			wantNilErr:  false,
		},
		{
			// Successful edit — nil error.
			name:       "success",
			httpStatus: 200,
			wantNilErr: true,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			var srv *httptest.Server
			if tc.httpStatus == 200 {
				srv = serveTelegramSuccess(t)
			} else {
				srv = serveTelegramError(t, tc.httpStatus, tc.description)
			}
			bot := newTestBot(t, srv)

			err := bot.EditMessageText(context.Background(), "@chan", 1, "text", nil)

			if tc.wantNilErr {
				if err != nil {
					t.Errorf("expected nil error, got: %v", err)
				}
				return
			}

			var termErr *telegram.ErrTerminalEdit
			isTerminal := errors.As(err, &termErr)

			if tc.wantTermErr {
				if !isTerminal {
					t.Errorf("expected *ErrTerminalEdit, got: %v", err)
					return
				}
				if termErr.MessageGone != tc.wantGone {
					t.Errorf("ErrTerminalEdit.MessageGone: got %v, want %v (description: %q)",
						termErr.MessageGone, tc.wantGone, termErr.Description)
				}
			} else {
				if isTerminal {
					t.Errorf("expected non-terminal error, got *ErrTerminalEdit: %v", termErr)
				}
				if err == nil {
					t.Errorf("expected non-nil error, got nil")
				}
			}
		})
	}
}

// TestEditMessageText_SuccessfulEdit is a sanity check that a 200 OK response
// with ok=true propagates as nil.
func TestEditMessageText_SuccessfulEdit(t *testing.T) {
	srv := serveTelegramSuccess(t)
	bot := newTestBot(t, srv)
	if err := bot.EditMessageText(context.Background(), "@chan", 42, "hello", nil); err != nil {
		t.Errorf("expected nil error for successful edit, got: %v", err)
	}
}
