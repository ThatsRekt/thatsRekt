// Regression tests for issue #262: every value interpolated into the Telegram
// HTML payload must be escaped.
//
// Context. The notifier wedged in prod on post ethereum-38, retrying every ~10s
// indefinitely with:
//
//	WARN fallback publish failed post_id=ethereum-38
//	     err="send message: sendMessage: Bad Request: can't parse entities:
//	          Empty attribute name in the tag \"a\" at byte offset 824"
//
// "Empty attribute name in the tag a" is what Telegram reports when an <a>
// tag's href attribute is terminated early — i.e. the interpolated URL
// contained a double quote. explorerLink() built its anchor with a raw
// Sprintf and escaped neither the url nor the label, while every other
// insertion point in this file goes through html().
//
// Attacker/victim addresses and tx hashes are not guaranteed to be well-formed
// hex: exploit tx hashes and sources are parsed out of the post's free-form
// on-chain note, so they are attacker-influenced text, not validated addresses.
package telegram_test

import (
	"strings"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// hostileQuote is the minimal payload that reproduces the prod failure: a
// double quote closes href="…" early, leaving Telegram parsing what looks like
// an attribute with no name.
const hostileQuote = `0xdead"onmouseover=x`

// assertNoBrokenAnchor fails when the rendered message contains an <a> tag
// whose href attribute is not a single well-formed quoted string.
func assertNoBrokenAnchor(t *testing.T, msg string) {
	t.Helper()
	for _, seg := range strings.Split(msg, "<a href=")[1:] {
		// After `<a href=` we expect: "  …  "  >  — exactly two quotes before '>'.
		end := strings.Index(seg, ">")
		if end < 0 {
			t.Fatalf("unterminated <a href= in message:\n%s", msg)
		}
		if got := strings.Count(seg[:end], `"`); got != 2 {
			t.Fatalf("malformed anchor: expected exactly 2 quotes in href, got %d\n"+
				"segment: %q\nfull message:\n%s", got, seg[:end], msg)
		}
	}
}

func TestFormatPostMessage_HostileTxHashDoesNotBreakAnchor(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Bridge drained",
		note:        v2Note("summary text", "8453", hostileQuote, ""),
		actionCount: 1,
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessage(p)

	assertNoBrokenAnchor(t, msg)
	if strings.Contains(msg, `"onmouseover`) {
		t.Fatalf("raw double quote survived into the payload — Telegram will "+
			"reject this message:\n%s", msg)
	}
}

func TestFormatPostMessage_HostileAttackerAddressIsEscaped(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Bridge drained",
		note:        v2Note("summary text", "8453", "", ""),
		actionCount: 1,
		attackers:   []string{hostileQuote},
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessage(p)

	assertNoBrokenAnchor(t, msg)
	if strings.Contains(msg, `"onmouseover`) {
		t.Fatalf("unescaped quote from attacker address:\n%s", msg)
	}
}

// A raw '<' anywhere fails the whole message with `can't parse entities`, which
// is the documented reason html() exists. The label side of the anchor and the
// bare abbreviation printed next to it must both be escaped.
func TestFormatPostMessage_AngleBracketsInVictimAreEscaped(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Bridge drained",
		note:        v2Note("summary text", "8453", "", ""),
		actionCount: 1,
		victims:     []string{"<b>0xnotanaddress</b>"},
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessage(p)

	if strings.Contains(msg, "<b>0xnotanaddress") {
		t.Fatalf("raw <b> from victim field survived — Telegram will reject "+
			"the message:\n%s", msg)
	}
}

// Guard against over-escaping: legitimate hex values must still render as
// working links, otherwise the fix would silently break every normal alert.
func TestFormatPostMessage_WellFormedValuesStillLinkCorrectly(t *testing.T) {
	addr := "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Bridge drained",
		note:        v2Note("summary text", "8453", "", ""),
		actionCount: 1,
		attackers:   []string{addr},
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessage(p)

	assertNoBrokenAnchor(t, msg)
	if !strings.Contains(msg, "basescan.org/address/"+addr) {
		t.Fatalf("well-formed address should still produce a working explorer "+
			"link:\n%s", msg)
	}
	if strings.Contains(msg, "&amp;amp;") {
		t.Fatalf("double-escaping detected:\n%s", msg)
	}
}
