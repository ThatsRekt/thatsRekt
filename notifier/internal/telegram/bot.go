// Package telegram — minimal Bot API client.
//
// Bot API only — no MTProto. We need exactly two operations:
//
//	sendMessage      → drop a new alert in the channel
//	editMessageText  → update an existing message in place (amendments + retracts)
//
// All requests go to https://api.telegram.org/bot<TOKEN>/<method> as JSON.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const apiBase = "https://api.telegram.org"

type Bot struct {
	Token string
	// APIBase overrides the Telegram API base URL. Leave empty for production
	// (defaults to https://api.telegram.org). Set in tests to point at an
	// httptest.Server so classification can be tested without network access.
	APIBase string
	HTTP    *http.Client
}

func NewBot(token string) *Bot {
	return &Bot{
		Token: token,
		// Bot API supports long-polling up to 50s — give the http client
		// enough headroom on top of that.
		HTTP: &http.Client{Timeout: 70 * time.Second},
	}
}

// --- send + edit -----------------------------------------------------------

type InlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
	URL          string `json:"url,omitempty"`
}

type InlineKeyboardMarkup struct {
	InlineKeyboard [][]InlineKeyboardButton `json:"inline_keyboard"`
}

type sendMessageReq struct {
	ChatID    string `json:"chat_id"`
	Text      string `json:"text"`
	ParseMode string `json:"parse_mode,omitempty"`
	// DisableWebPagePreview is false by default. The OG card rendered at
	// `/post/:chain/:postId` is now informative (title, byline,
	// attacker/victim counts, brand strip — see mesh/src/og.ts), so
	// Telegram's link preview adds signal rather than noise. Flip back
	// to true if the OG renderer regresses.
	DisableWebPagePreview bool                  `json:"disable_web_page_preview"`
	ReplyMarkup           *InlineKeyboardMarkup `json:"reply_markup,omitempty"`
}

type sendMessageResp struct {
	OK     bool `json:"ok"`
	Result struct {
		MessageID int64 `json:"message_id"`
	} `json:"result"`
	Description string `json:"description,omitempty"`
}

// SendMessage posts to a chat (channel @username or numeric -100… id) and
// returns the resulting message id.
//
// parseMode controls Telegram's text parser:
//   - "HTML"  — enables <b>, <i>, <a href="…">, etc.
//   - ""      — plain text; all characters treated literally, no entities parsed.
//
// Pass "HTML" for the normal formatted alert. Pass "" for the plain-text
// fallback when Telegram has rejected the HTML message with a parse error.
//
// Web-page preview is enabled. Mesh renders an informative OG card at
// `/post/:chain/:postId` (title + byline + attacker/victim counts +
// brand strip — see mesh/src/og.ts), so Telegram's link preview now
// adds signal. Flip DisableWebPagePreview back to true if the renderer
// regresses or if a particular notification needs to suppress it.
func (b *Bot) SendMessage(ctx context.Context, chatID, text, parseMode string, kb *InlineKeyboardMarkup) (int64, error) {
	body, _ := json.Marshal(sendMessageReq{
		ChatID:                chatID,
		Text:                  text,
		ParseMode:             parseMode,
		DisableWebPagePreview: false,
		ReplyMarkup:           kb,
	})
	var out sendMessageResp
	if err := b.call(ctx, "sendMessage", body, &out); err != nil {
		return 0, err
	}
	if !out.OK {
		return 0, fmt.Errorf("sendMessage: %s", out.Description)
	}
	return out.Result.MessageID, nil
}

type editMessageTextReq struct {
	ChatID      string                `json:"chat_id"`
	MessageID   int64                 `json:"message_id"`
	Text        string                `json:"text"`
	ParseMode   string                `json:"parse_mode,omitempty"`
	ReplyMarkup *InlineKeyboardMarkup `json:"reply_markup,omitempty"`
}

// ErrTerminalEdit is returned by EditMessageText when the Telegram API indicates
// the failure is permanent: retrying the same request will not succeed.
//
// MessageGone distinguishes two distinct recovery paths:
//
//   - MessageGone=true ("message to edit not found", "MESSAGE_ID_INVALID"):
//     The message no longer exists in the channel. For retracts, MarkRetracted
//     is safe — there is nothing publicly visible to retract. For amendments,
//     advancing the snapshot stops the retry loop (cosmetic loss only).
//
//   - MessageGone=false ("message can't be edited", "not enough rights to edit message"):
//     The message EXISTS and is still publicly visible, but the bot cannot edit
//     it (edit window expired, or admin rights revoked). For retracts, do NOT
//     call MarkRetracted — that would permanently silence the retry and leave a
//     live false accusation marked "done". Log at ERROR and let a human retract
//     manually. For amendments, advancing the snapshot still makes sense (the
//     content is stale, not a safety issue).
//
// Transient conditions (rate-limit 429, 5xx server errors) are NOT wrapped
// in this type — they propagate as plain errors so the caller's retry-on-
// next-poll behaviour applies correctly.
//
// Callers detect this type via errors.As and must branch on MessageGone.
type ErrTerminalEdit struct {
	Description string
	// MessageGone is true when the Telegram message no longer exists.
	// See the type-level comment for recovery action per value.
	MessageGone bool
}

func (e *ErrTerminalEdit) Error() string {
	return "editMessageText (terminal): " + e.Description
}

// classifyTerminalEdit checks whether a Telegram Bot API error description is a
// known-permanent edit failure, and if so, whether the message is gone vs. still
// visible but uneditable.
//
// The exact error strings are verified against the live Telegram Bot API. Word
// order matters — "message can't be edited" NOT "can't edit message". Tests in
// bot_test.go pin each string to guard against future drift.
func classifyTerminalEdit(desc string) (isTerminal bool, messageGone bool) {
	// --- message is GONE — MarkRetracted is safe ---
	if strings.Contains(desc, "message to edit not found") {
		return true, true
	}
	if strings.Contains(desc, "MESSAGE_ID_INVALID") {
		return true, true
	}
	// --- message EXISTS but bot cannot edit it — do NOT MarkRetracted ---
	if strings.Contains(desc, "message can't be edited") {
		return true, false
	}
	if strings.Contains(desc, "not enough rights to edit message") {
		return true, false
	}
	return false, false
}

// EditMessageText replaces the text of an existing message in place. Used
// for amendment handling: when a post the notifier has already published is
// amended on-chain, we call this instead of sending a new message so
// channel subscribers see the update in place without duplicate noise.
//
// Telegram returns 400 "message is not modified" when the new text is
// identical to the current one; we treat that as a no-op.
//
// Terminal errors (message deleted, too old, etc.) are returned as
// *ErrTerminalEdit. Callers should use errors.As to distinguish terminal from
// transient failures: terminal → record outcome and move on; transient →
// retry on next poll.
func (b *Bot) EditMessageText(ctx context.Context, chatID string, messageID int64, text string, kb *InlineKeyboardMarkup) error {
	body, _ := json.Marshal(editMessageTextReq{
		ChatID:      chatID,
		MessageID:   messageID,
		Text:        text,
		ParseMode:   "HTML",
		ReplyMarkup: kb,
	})
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	if err := b.call(ctx, "editMessageText", body, &out); err != nil {
		return err
	}
	if !out.OK {
		// "message is not modified" — no-op; idempotent by Telegram spec.
		// Telegram historically returns this with and without the
		// "Bad Request:" prefix — use substring match for robustness.
		if strings.Contains(out.Description, "message is not modified") {
			return nil
		}
		// Classify terminal vs transient. Terminal errors cannot succeed on
		// retry; the caller must branch on MessageGone and record the outcome.
		if isTerminal, messageGone := classifyTerminalEdit(out.Description); isTerminal {
			return &ErrTerminalEdit{Description: out.Description, MessageGone: messageGone}
		}
		return fmt.Errorf("editMessageText: %s", out.Description)
	}
	return nil
}

// --- HTTP plumbing ---------------------------------------------------------

func (b *Bot) call(ctx context.Context, method string, body []byte, out any) error {
	base := b.APIBase
	if base == "" {
		base = apiBase
	}
	url := fmt.Sprintf("%s/bot%s/%s", base, b.Token, method)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("do %s: %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("unmarshal %s: %w (body: %s)", method, err, truncate(string(raw), 200))
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
