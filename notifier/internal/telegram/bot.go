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
	HTTP  *http.Client
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
// returns the resulting message id. ParseMode is "HTML" so we can use
// `<b>`, `<a href="…">` etc. without escaping every emoji-looking thing.
//
// Web-page preview is enabled. Mesh renders an informative OG card at
// `/post/:chain/:postId` (title + byline + attacker/victim counts +
// brand strip — see mesh/src/og.ts), so Telegram's link preview now
// adds signal. Flip DisableWebPagePreview back to true if the renderer
// regresses or if a particular notification needs to suppress it.
func (b *Bot) SendMessage(ctx context.Context, chatID, text string, kb *InlineKeyboardMarkup) (int64, error) {
	body, _ := json.Marshal(sendMessageReq{
		ChatID:                chatID,
		Text:                  text,
		ParseMode:             "HTML",
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
// Known terminal conditions (matched by isTerminalEditError below):
//   - "message to edit not found" — message was deleted from the channel.
//   - "can't edit message" — message too old (>48 h) or bot lost edit rights.
//   - "MESSAGE_ID_INVALID" — Telegram MTProto error forwarded to the Bot API.
//
// Transient conditions (rate-limit 429, 5xx server errors) are NOT wrapped
// in this type — they propagate as plain errors so the caller's retry-on-
// next-poll behaviour applies correctly.
//
// Callers detect this type via errors.As and should record the terminal
// outcome in state (advance the snapshot, or mark retracted) rather than
// retrying on the next poll.
type ErrTerminalEdit struct {
	Description string
}

func (e *ErrTerminalEdit) Error() string {
	return "editMessageText (terminal): " + e.Description
}

// isTerminalEditError reports whether the Telegram Bot API error description
// indicates a permanent failure that retrying cannot resolve.
func isTerminalEditError(desc string) bool {
	return strings.Contains(desc, "message to edit not found") ||
		strings.Contains(desc, "can't edit message") ||
		strings.Contains(desc, "MESSAGE_ID_INVALID")
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
		// retry; the caller must record the outcome and move on.
		if isTerminalEditError(out.Description) {
			return &ErrTerminalEdit{Description: out.Description}
		}
		return fmt.Errorf("editMessageText: %s", out.Description)
	}
	return nil
}

// --- HTTP plumbing ---------------------------------------------------------

func (b *Bot) call(ctx context.Context, method string, body []byte, out any) error {
	url := fmt.Sprintf("%s/bot%s/%s", apiBase, b.Token, method)
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
