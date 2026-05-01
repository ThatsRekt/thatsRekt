// Package telegram — minimal Bot API client.
//
// Bot API only — no MTProto. We need exactly four operations:
//   sendMessage      → drop a new alert in the channel
//   editMessageReplyMarkup → update the inline keyboard counts after a vote
//   getUpdates       → long-poll for callback_query (button-press) events
//   answerCallbackQuery → ack the press so the user's client stops spinning
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
	// DisableWebPagePreview is true by default for all SendMessage calls.
	// The OG card we render server-side at `/post/:chain/:postId` is
	// currently sparse (top stripe + empty body) and duplicates the
	// message body — net visual noise. Re-enable when the OG renderer is
	// improved (mesh/src/og.ts).
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
// Web-page preview is disabled by default. The OG card we render
// server-side at `/post/:chain/:postId` is currently sparse (top stripe +
// empty body) and duplicates the message body — net visual noise.
// Re-enable when the OG renderer is improved (mesh/src/og.ts).
func (b *Bot) SendMessage(ctx context.Context, chatID, text string, kb *InlineKeyboardMarkup) (int64, error) {
	body, _ := json.Marshal(sendMessageReq{
		ChatID:                chatID,
		Text:                  text,
		ParseMode:             "HTML",
		DisableWebPagePreview: true,
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

type editReplyMarkupReq struct {
	ChatID      string                `json:"chat_id"`
	MessageID   int64                 `json:"message_id"`
	ReplyMarkup *InlineKeyboardMarkup `json:"reply_markup"`
}

// EditReplyMarkup updates the inline keyboard on an existing message —
// used after a vote to reflect the new counts. Telegram returns 400 if
// the new markup is identical to the old one; we treat that as a no-op.
func (b *Bot) EditReplyMarkup(ctx context.Context, chatID string, messageID int64, kb *InlineKeyboardMarkup) error {
	body, _ := json.Marshal(editReplyMarkupReq{
		ChatID:      chatID,
		MessageID:   messageID,
		ReplyMarkup: kb,
	})
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	if err := b.call(ctx, "editMessageReplyMarkup", body, &out); err != nil {
		return err
	}
	if !out.OK {
		// 400 with "message is not modified" is benign — return nil so
		// the caller doesn't spam logs on idempotent re-presses.
		if out.Description == "Bad Request: message is not modified" {
			return nil
		}
		return fmt.Errorf("editMessageReplyMarkup: %s", out.Description)
	}
	return nil
}

// --- callbacks -------------------------------------------------------------

type Update struct {
	UpdateID      int64          `json:"update_id"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

type CallbackQuery struct {
	ID   string `json:"id"`
	From struct {
		ID int64 `json:"id"`
	} `json:"from"`
	Message struct {
		MessageID int64 `json:"message_id"`
	} `json:"message"`
	Data string `json:"data"`
}

type getUpdatesReq struct {
	Offset         int64    `json:"offset,omitempty"`
	Timeout        int      `json:"timeout"`
	AllowedUpdates []string `json:"allowed_updates"`
}

type getUpdatesResp struct {
	OK          bool     `json:"ok"`
	Result      []Update `json:"result"`
	Description string   `json:"description,omitempty"`
}

// GetUpdates long-polls for new updates after `offset`. We only ask for
// callback_query events — channel posts the bot itself sends are not
// echoed back via this endpoint anyway, so the filter is mostly to skip
// any future "message" / "edited_message" updates we don't care about.
func (b *Bot) GetUpdates(ctx context.Context, offset int64, timeout time.Duration) ([]Update, error) {
	body, _ := json.Marshal(getUpdatesReq{
		Offset:         offset,
		Timeout:        int(timeout.Seconds()),
		AllowedUpdates: []string{"callback_query"},
	})
	var out getUpdatesResp
	if err := b.call(ctx, "getUpdates", body, &out); err != nil {
		return nil, err
	}
	if !out.OK {
		return nil, fmt.Errorf("getUpdates: %s", out.Description)
	}
	return out.Result, nil
}

type answerCallbackReq struct {
	CallbackQueryID string `json:"callback_query_id"`
	Text            string `json:"text,omitempty"`
	ShowAlert       bool   `json:"show_alert,omitempty"`
}

// AnswerCallback acknowledges a button press — Telegram requires this
// within 15s or the user's client shows an indefinite spinner. Optional
// text shows as a toast over the chat.
func (b *Bot) AnswerCallback(ctx context.Context, queryID, text string) error {
	body, _ := json.Marshal(answerCallbackReq{
		CallbackQueryID: queryID,
		Text:            text,
	})
	var out struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	return b.call(ctx, "answerCallbackQuery", body, &out)
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
