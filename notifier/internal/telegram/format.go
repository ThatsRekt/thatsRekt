package telegram

import (
	"fmt"
	"strings"
	"time"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/note"
)

// FormatPostMessage renders the uniform v2 Telegram message for any on-chain
// post — createPost or amendment — built purely from on-chain data.
// It calls FormatPostMessageAt with the current wall-clock time.
func FormatPostMessage(p graphql.Post) string {
	return FormatPostMessageAt(p, time.Now())
}

// FormatPostMessageAt is the testable core of FormatPostMessage. Callers pass
// in an explicit `now` so tests can exercise relative-time rendering without
// depending on wall-clock time.
//
// Target format:
//
//	🚨 HACK VERIFIED
//	<relative time> on <attacked-chain set>
//	updated · rev <N>
//
//	<summary>
//
//	Attackers:
//	  <addr> (<explorer link>)
//
//	[Victims:
//	  <addr> (<explorer link>)]
//
//	Tx:
//	  <txHash> (<explorer link>)
//	  ...
//
//	Source: @<handle>
//	<source url>
//
// Rules:
//   - All content is sourced from the self-describing on-chain note. The
//     formatter parses the note for summary, attacked-chain set, exploit tx
//     hashes, and sources.
//   - Line 2 renders the relative time from p.LastUpdatedAt (e.g. "2h ago").
//     Falls back to "just now" when the timestamp is absent or unparseable.
//   - `rev N` is derived from p.ActionCount (1 createPost + N-1 amendments).
//     If ActionCount is 0 (indexer not yet upgraded), falls back to rev 1.
//   - No confidence/score is shown.
//   - Victims section is rendered the same way as Attackers when present;
//     omitted entirely when p.Victims is empty.
//   - Addresses and tx hashes are abbreviated (first 6 + last 4 chars) with
//     an HTML anchor pointing to the appropriate block explorer.
//   - Source tokens from the note are rendered one per line: @handle tokens
//     are prefixed "Source:", URL tokens appear on their own line.
//   - All user-supplied text is HTML-escaped before insertion.
func FormatPostMessageAt(p graphql.Post, now time.Time) string {
	parsed := note.ParseNote(p.Note)

	chainName := chainDisplayName(p.Chain)

	rev := p.ActionCount
	if rev < 1 {
		rev = 1
	}

	// Line 2: relative time computed from LastUpdatedAt relative to now.
	relTime := relativeTime(p.LastUpdatedAt, now)

	// The "on <chains>" part uses the full attacked-chain set from the
	// self-describing note (which may span multiple chains). Fall back to
	// the posting chain when the note carries no chains.
	chains := strings.Join(parsed.AttackedChains, ", ")
	if chains == "" {
		chains = chainName
	}

	var b strings.Builder

	// Header
	fmt.Fprintf(&b, "🚨 <b>HACK VERIFIED</b>\n")
	fmt.Fprintf(&b, "%s on %s\n", html(relTime), html(chains))
	fmt.Fprintf(&b, "updated · rev %d\n", rev)

	// Summary from parsed note
	if summary := strings.TrimSpace(parsed.Summary); summary != "" {
		fmt.Fprintf(&b, "\n%s\n", html(summary))
	}

	// Attackers
	if len(p.Attackers) > 0 {
		fmt.Fprintf(&b, "\nAttackers:\n")
		for _, addr := range p.Attackers {
			link := explorerAddrURL(p.Chain, addr)
			fmt.Fprintf(&b, "  %s (%s)\n", addrAbbrev(addr), explorerLink(link, addrAbbrev(addr)))
		}
	}

	// Victims (only when present)
	if len(p.Victims) > 0 {
		fmt.Fprintf(&b, "\nVictims:\n")
		for _, addr := range p.Victims {
			link := explorerAddrURL(p.Chain, addr)
			fmt.Fprintf(&b, "  %s (%s)\n", addrAbbrev(addr), explorerLink(link, addrAbbrev(addr)))
		}
	}

	// Exploit tx hashes from parsed note
	if len(parsed.ExploitTxHashes) > 0 {
		fmt.Fprintf(&b, "\nTx:\n")
		for _, txHash := range parsed.ExploitTxHashes {
			link := explorerTxURL(p.Chain, txHash)
			fmt.Fprintf(&b, "  %s (%s)\n", txAbbrev(txHash), explorerLink(link, txAbbrev(txHash)))
		}
	}

	// Sources from parsed note — @handle tokens are labelled "Source:",
	// URL tokens appear on their own line. Spec target format:
	//   Source: @<handle>
	//   <source url>
	if len(parsed.Sources) > 0 {
		for _, src := range parsed.Sources {
			if strings.HasPrefix(src, "@") {
				fmt.Fprintf(&b, "\nSource: %s\n", html(src))
			} else {
				fmt.Fprintf(&b, "%s\n", html(src))
			}
		}
	}

	return strings.TrimRight(b.String(), "\n")
}

// FormatRetractedMessage renders the struck-through RETRACTED state for a post
// that has been removed on-chain. It replaces the live message in place — the
// channel stays auditable (no delete) but the message visually signals that
// the post has been retracted.
//
// Format:
//
//	⚠️ <s>RETRACTED</s>
//	<s><title></s>
//	<s>This post has been retracted on-chain.</s>
//
// The title is HTML-escaped and wrapped in <s>…</s> (Telegram HTML struck-through).
// No summary, attackers, tx hashes, or sources are rendered — the retraction
// supersedes the original content.
//
// title is the post title from postById (the per-chain query that is the
// only data path for retracted posts). The full post struct is not needed here.
func FormatRetractedMessage(title string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "⚠️ <s><b>RETRACTED</b></s>\n")
	if title != "" {
		fmt.Fprintf(&b, "<s>%s</s>\n", html(title))
	}
	fmt.Fprintf(&b, "<s>This post has been retracted on-chain.</s>")
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

// --- time helpers ---

// relativeTime converts an ISO-8601 UTC timestamp string to a human-readable
// relative duration (e.g. "2h ago", "5m ago", "just now"), computed against
// the supplied `now`. Returns "just now" when ts is empty or cannot be parsed
// — this keeps line 2 of the message readable even when LastUpdatedAt is
// absent from the response.
func relativeTime(ts string, now time.Time) string {
	if ts == "" {
		return "just now"
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		// Also try without timezone suffix for tolerance.
		t, err = time.Parse("2006-01-02T15:04:05", ts)
		if err != nil {
			return "just now"
		}
	}
	d := now.Sub(t)
	if d < 0 {
		d = -d
	}
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// --- explorer URL helpers ---

// explorerAddrURL builds the block explorer URL for an address given the
// post's chain. Returns an empty string for unknown chains, in which case
// the link is omitted and only the abbreviated address is shown.
func explorerAddrURL(c graphql.Chain, addr string) string {
	base := explorerBase(c)
	if base == "" {
		return ""
	}
	return base + "/address/" + addr
}

// explorerTxURL builds the block explorer URL for a transaction hash.
func explorerTxURL(c graphql.Chain, txHash string) string {
	base := explorerBase(c)
	if base == "" {
		return ""
	}
	return base + "/tx/" + txHash
}

// explorerBase returns the block explorer base URL for a chain. Returns an
// empty string for unknown chains.
func explorerBase(c graphql.Chain) string {
	switch c.ChainID {
	case 1:
		return "https://etherscan.io"
	case 10:
		return "https://optimistic.etherscan.io"
	case 56:
		return "https://bscscan.com"
	case 100:
		return "https://gnosisscan.io"
	case 137:
		return "https://polygonscan.com"
	case 8453:
		return "https://basescan.org"
	case 42161:
		return "https://arbiscan.io"
	case 43114:
		return "https://snowtrace.io"
	default:
		return ""
	}
}

// explorerLink wraps label in an HTML anchor when url is non-empty;
// returns the label unchanged otherwise.
func explorerLink(url, label string) string {
	if url == "" {
		return label
	}
	return fmt.Sprintf(`<a href="%s">%s</a>`, url, label)
}

// --- abbreviation helpers ---

// addrAbbrev renders a hex address or tx hash as `0x1234…abcd`
// (first 6 chars + last 4). Inputs shorter than 10 chars are returned as-is.
func addrAbbrev(addr string) string {
	if len(addr) < 10 {
		return addr
	}
	return addr[:6] + "…" + addr[len(addr)-4:]
}

// txAbbrev is an alias for addrAbbrev — tx hashes use the same abbreviation.
func txAbbrev(txHash string) string {
	return addrAbbrev(txHash)
}

// chainDisplayName returns a human-readable chain name, falling back to the
// uppercased slug when Name is empty.
func chainDisplayName(c graphql.Chain) string {
	if c.Name != "" {
		return c.Name
	}
	return strings.ToUpper(c.Slug)
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
