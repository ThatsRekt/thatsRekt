package telegram

import (
	"fmt"
	"strings"

	"github.com/JeronimoHoulin/thatsRekt/notifier/internal/graphql"
)

// FormatPostMessage builds the HTML body for a new-post Telegram message.
//
// We deliberately keep the body short and let Telegram's link preview do
// the heavy lifting — the OG card we render server-side at
// `/post/:chain/:postId` already includes title, description, attacker /
// victim count, and a default image. The message body is just the headline
// + a few key facts so the alert reads sensibly even if previews are off.
func FormatPostMessage(p graphql.Post, siteURL string) string {
	postPath := postPath(p)
	url := strings.TrimRight(siteURL, "/") + postPath

	chainName := p.Chain.Name
	if chainName == "" {
		chainName = strings.ToUpper(p.Chain.Slug)
	}

	title := strings.TrimSpace(p.Title)
	if title == "" {
		title = "(untitled alert)"
	}

	var b strings.Builder
	fmt.Fprintf(&b, "🚨 <b>%s</b> · %s\n", html(title), strings.ToLower(chainName))

	// TODO(ens): resolve to primary name where one is set on mainnet. Needs
	// an ETH RPC client + on-disk cache; out of scope for the immediate
	// "show who posted" fix.
	if poster := strings.TrimSpace(p.Poster); poster != "" {
		fmt.Fprintf(&b, "by <code>%s</code>\n", html(truncateAddr(poster)))
	}

	if note := strings.TrimSpace(p.Note); note != "" {
		// Cap the note to avoid overflowing Telegram's 4096-char limit
		// after we add buttons + URL preview. 280 is plenty.
		if len(note) > 280 {
			note = note[:277] + "…"
		}
		fmt.Fprintf(&b, "\n%s\n", html(note))
	}

	parts := []string{}
	if n := len(p.Attackers); n > 0 {
		parts = append(parts, fmt.Sprintf("%d attacker%s", n, plural(n)))
	}
	if n := len(p.Victims); n > 0 {
		parts = append(parts, fmt.Sprintf("%d victim%s", n, plural(n)))
	}
	if p.Confirmations > 0 || p.Disconfirmations > 0 {
		parts = append(parts, fmt.Sprintf("%d ✓ / %d ✗ on-chain", p.Confirmations, p.Disconfirmations))
	}
	if len(parts) > 0 {
		fmt.Fprintf(&b, "\n<i>%s</i>\n", html(strings.Join(parts, " · ")))
	}

	fmt.Fprintf(&b, "\n<a href=\"%s\">full post on thatsrekt →</a>", url)

	return b.String()
}

// VoteKeyboard builds the cosmetic ✓/✗ inline keyboard. The callback_data
// payload is `vote:{up|down}:{postId}` so the press handler can identify
// which post + direction without needing a separate lookup table.
//
// These counts are TELEGRAM-side only — they do NOT affect the on-chain
// confirm/disconfirm state. The OG-card preview shows the on-chain numbers
// for canonical truth; the buttons are a low-effort engagement signal for
// chat readers who don't have a wallet handy.
func VoteKeyboard(postID string, up, down int) *InlineKeyboardMarkup {
	return &InlineKeyboardMarkup{
		InlineKeyboard: [][]InlineKeyboardButton{
			{
				{Text: fmt.Sprintf("✓  %d", up), CallbackData: "vote:up:" + postID},
				{Text: fmt.Sprintf("✗  %d", down), CallbackData: "vote:down:" + postID},
			},
		},
	}
}

// postPath turns a unified post into the OG-card-friendly URL path.
// Format must match the frontend's BrowserRouter route + the Mesh OG
// route: `/post/:chainSlug/:onchainId`.
func postPath(p graphql.Post) string {
	// Composite id is `{slug}-{onchainId}`. Split on the LAST `-` because
	// some chain slugs (e.g. `op-mainnet`) contain hyphens themselves.
	idx := strings.LastIndex(p.ID, "-")
	if idx < 0 || idx == len(p.ID)-1 {
		// Malformed id — use the chain slug + raw id. Mesh's OG handler
		// returns a graceful 404 with a generic OG card if the lookup
		// fails, so this won't crash the channel.
		return "/post/" + p.Chain.Slug + "/" + p.ID
	}
	onchainID := p.ID[idx+1:]
	return "/post/" + p.Chain.Slug + "/" + onchainID
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// truncateAddr renders a hex address as `0xda1b…7f45` (first 6 chars +
// last 4, with a Unicode middle ellipsis). Non-address-shaped inputs
// (anything shorter than 12 chars) are returned unchanged so we don't
// produce nonsense for malformed posters.
func truncateAddr(addr string) string {
	if len(addr) < 12 {
		return addr
	}
	return addr[:6] + "…" + addr[len(addr)-4:]
}

// html escapes the four characters Telegram's HTML parse mode treats
// specially: `<`, `>`, `&`, `"`. (The Bot API parses HTML strictly enough
// that an un-escaped `<` in a poster's note will fail the entire message
// with `can't parse entities`.)
func html(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"\"", "&quot;",
	)
	return r.Replace(s)
}
