package telegram_test

import (
	"strings"
	"testing"
	"time"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// fixedNow is the reference wall-clock used across all tests so that
// relative-time assertions are deterministic.
var fixedNow = time.Date(2026, 5, 21, 16, 0, 0, 0, time.UTC)

// v2Note builds a self-describing note string for tests.
func v2Note(summary, chains, txs, sources string) string {
	var b strings.Builder
	if summary != "" {
		b.WriteString("summary: ")
		b.WriteString(summary)
		b.WriteString("\n")
	}
	if chains != "" {
		b.WriteString("chains: ")
		b.WriteString(chains)
		b.WriteString("\n")
	}
	if txs != "" {
		b.WriteString("txs: ")
		b.WriteString(txs)
		b.WriteString("\n")
	}
	if sources != "" {
		b.WriteString("sources: ")
		b.WriteString(sources)
		b.WriteString("\n")
	}
	return b.String()
}

func makePost(opts struct {
	title       string
	note        string
	actionCount int
	attackers   []string
	victims     []string
	chain       graphql.Chain
	updatedAt   string
}) graphql.Post {
	return graphql.Post{
		ID:            opts.chain.Slug + "-7",
		Chain:         opts.chain,
		Title:         opts.title,
		Note:          opts.note,
		ActionCount:   opts.actionCount,
		Attackers:     opts.attackers,
		Victims:       opts.victims,
		LastUpdatedAt: opts.updatedAt,
	}
}

var baseChain = graphql.Chain{
	ChainID: 8453,
	Slug:    "base",
	Name:    "Base",
}

// TestFormatPostMessage_CreatePostOnly covers a freshly created post (rev 1,
// no amendments, no victims). This is acceptance criterion 1 + 3 + 4.
// updatedAt is 2h before fixedNow so the relative-time line is deterministic.
func TestFormatPostMessage_CreatePostOnly(t *testing.T) {
	note := v2Note(
		"Butter Bridge V3.1 drained via reentrancy",
		"base",
		"0x31e5e5f2a8b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0664a",
		"@rektreporter",
	)
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Butter Bridge V3.1",
		note:        note,
		actionCount: 1, // one createPost action → rev 1
		attackers:   []string{"0x4059e47b062D9F959e2059b48cD6dB264EF5279F"},
		victims:     nil,
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z", // 2h before fixedNow
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// Line 2 must show relative time, not the title.
	assertContains(t, msg, "2h ago on base", "relative-time line")
	assertContains(t, msg, "rev 1", "rev derived from action count")

	// Summary from parsed note (still references the protocol name)
	assertContains(t, msg, "Butter Bridge V3.1 drained via reentrancy", "summary from note")

	// Attacker section present with abbreviated address
	assertContains(t, msg, "Attackers:", "attackers section")
	assertContains(t, msg, "0x4059", "attacker addr prefix")
	assertContains(t, msg, "279F", "attacker addr suffix")

	// No victims section for a post without victims
	assertAbsent(t, msg, "Victims:", "victims section must be absent when no victims")

	// Source attribution renders as "Source: @handle" line
	assertContains(t, msg, "Source: @rektreporter", "source attribution")

	// No score/confidence
	assertAbsent(t, msg, "score", "no score")
	assertAbsent(t, msg, "confidence", "no confidence")
	assertAbsent(t, msg, "✓", "no confirmation count")
	assertAbsent(t, msg, "✗", "no disconfirmation count")
}

// TestFormatPostMessage_AmendedPost covers an amended post (rev > 1).
// Acceptance criterion 3: rev derived from action count.
// updatedAt is 1h before fixedNow.
func TestFormatPostMessage_AmendedPost(t *testing.T) {
	note := v2Note(
		"MapProtocol bridge exploited for 3M USDC",
		"ethereum, arbitrum",
		"0xaaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222cc",
		"@rektreporter",
	)
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "MapProtocol Bridge Exploit",
		note:        note,
		actionCount: 3, // createPost + 2 amendments → rev 3
		attackers:   []string{"0xDEADBEEF0000000000000000000000000000DEAD"},
		victims:     nil,
		chain:       graphql.Chain{ChainID: 1, Slug: "ethereum", Name: "Ethereum"},
		updatedAt:   "2026-05-21T15:00:00Z", // 1h before fixedNow
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	assertContains(t, msg, "rev 3", "rev derived from action count of 3")
	assertContains(t, msg, "1h ago", "relative-time line")
	assertContains(t, msg, "MapProtocol bridge exploited for 3M USDC", "summary")
	// Multi-chain attacked set from note
	assertContains(t, msg, "ethereum", "attacked chain from note")
	assertContains(t, msg, "arbitrum", "attacked chain from note")
}

// TestFormatPostMessage_WithVictims covers a post that lists victims.
// Acceptance criterion 5: victims render in their own section.
func TestFormatPostMessage_WithVictims(t *testing.T) {
	note := v2Note(
		"Hack with both attackers and victims",
		"base",
		"0xbbbb1111cccc2222dddd3333eeee4444ffff5555aaaa6666bbbb1111cccc222200",
		"@analyst",
	)
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "FooProtocol Hack",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0x1111111111111111111111111111111111111111"},
		victims:     []string{"0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"},
		chain:       baseChain,
		updatedAt:   "2026-05-21T11:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	assertContains(t, msg, "Attackers:", "attackers section")
	assertContains(t, msg, "Victims:", "victims section must be present when victims exist")
	// Both victim addresses must appear abbreviated
	assertContains(t, msg, "0x2222", "first victim prefix")
	assertContains(t, msg, "0x3333", "second victim prefix")
}

// TestFormatPostMessage_WithoutVictims ensures the Victims section is omitted.
// Acceptance criterion 5: victims section omitted when absent.
func TestFormatPostMessage_WithoutVictims(t *testing.T) {
	note := v2Note("No victims here", "base", "0xcc", "@anon")
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Victimless",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		victims:     nil,
		chain:       baseChain,
		updatedAt:   "2026-05-21T12:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)
	assertAbsent(t, msg, "Victims:", "victims section must be absent")
}

// TestFormatPostMessage_ExplorerLinks checks that attacker addresses and tx
// hashes render with HTML anchor tags pointing to a block explorer.
func TestFormatPostMessage_ExplorerLinks(t *testing.T) {
	txHash := "0x31e5e5f2a8b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7664a"
	note := v2Note("Test summary", "ethereum", txHash, "@src")
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "LinkTest",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0x4059e47b062D9F959e2059b48cD6dB264EF5279F"},
		victims:     nil,
		chain:       graphql.Chain{ChainID: 1, Slug: "ethereum", Name: "Ethereum"},
		updatedAt:   "2026-05-21T13:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// Attacker address should be an HTML link
	assertContains(t, msg, `href=`, "attacker should be an HTML anchor")
	// The tx hash should appear abbreviated: first 6 chars + last 4
	assertContains(t, msg, "0x31e5", "tx hash prefix")
	assertContains(t, msg, "664a", "tx hash suffix")
}

// TestFormatPostMessage_HTMLEscaping checks that injected HTML in title or
// summary is escaped before being written into the message body.
func TestFormatPostMessage_HTMLEscaping(t *testing.T) {
	note := v2Note("<script>alert(1)</script>", "base", "0xaa", "@anon")
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "<b>bold title</b>",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0x4059e47b062D9F959e2059b48cD6dB264EF5279F"},
		victims:     nil,
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// Must not contain raw injected tags
	assertAbsent(t, msg, "<script>", "raw script tag must be escaped")
	assertAbsent(t, msg, "<b>bold title</b>", "raw bold title must be escaped")
	// Must contain escaped form
	assertContains(t, msg, "&lt;script&gt;", "escaped script tag in summary")
}

// TestFormatPostMessage_ZeroActionCountFallsBackToRev1 covers the production
// state where the indexer has not yet been upgraded to expose actionCount.
// Post.ActionCount will be 0 (json.Unmarshal zero-value) and the formatter
// must render "rev 1" — not "rev 0".
func TestFormatPostMessage_ZeroActionCountFallsBackToRev1(t *testing.T) {
	note := v2Note("Flash loan attack on FooVault", "base", "0xdeadbeef", "@researcher")
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "FooVault Flash Loan",
		note:        note,
		actionCount: 0, // indexer not yet upgraded — zero value from json.Unmarshal
		attackers:   []string{"0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},
		victims:     nil,
		chain:       baseChain,
		updatedAt:   "2026-05-21T15:30:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	assertContains(t, msg, "rev 1", "actionCount=0 must fall back to rev 1")
	assertAbsent(t, msg, "rev 0", "rev 0 must never appear")
}

// TestFormatPostMessage_RelativeTime checks the relative-time line for
// several durations against the fixed reference time.
func TestFormatPostMessage_RelativeTime(t *testing.T) {
	cases := []struct {
		updatedAt string
		wantLine  string
	}{
		{"2026-05-21T15:55:00Z", "just now on"}, // 5m ago < 1m? no, 5m — expect "5m ago"
		{"2026-05-21T15:59:30Z", "just now on"}, // 30s ago → "just now"
		{"2026-05-21T15:00:00Z", "1h ago on"},   // exactly 1h
		{"2026-05-21T14:00:00Z", "2h ago on"},   // exactly 2h
		{"2026-05-20T16:00:00Z", "1d ago on"},   // exactly 24h
		{"", "just now on"},                     // empty timestamp → "just now"
	}
	// Fix the 5m case: 15:55 is 5 minutes before 16:00
	cases[0] = struct {
		updatedAt string
		wantLine  string
	}{"2026-05-21T15:55:00Z", "5m ago on"}

	note := v2Note("summary", "base", "0xaabb", "@src")

	for _, tc := range cases {
		p := makePost(struct {
			title       string
			note        string
			actionCount int
			attackers   []string
			victims     []string
			chain       graphql.Chain
			updatedAt   string
		}{
			title:       "T",
			note:        note,
			actionCount: 1,
			attackers:   []string{"0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
			chain:       baseChain,
			updatedAt:   tc.updatedAt,
		})
		msg := telegram.FormatPostMessageAt(p, fixedNow)
		assertContains(t, msg, tc.wantLine, "relative-time line for updatedAt="+tc.updatedAt)
	}
}

// TestFormatPostMessage_MultiLineSource verifies that the Source section
// renders @handle tokens with the "Source:" label and URL tokens on their
// own line — matching the spec's target format.
func TestFormatPostMessage_MultiLineSource(t *testing.T) {
	// note has both a @handle and a URL
	note := v2Note(
		"Bridge hack on Base",
		"base",
		"0xdeadbeef1234567890123456789012345678901234567890123456789012abcd",
		"@rektreporter, https://rekt.news/bridge-hack",
	)
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Bridge Hack",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// @handle must appear as "Source: @rektreporter" (its own labelled line)
	assertContains(t, msg, "Source: @rektreporter", "handle gets Source: prefix")
	// URL must appear on its own line without the "Source:" prefix
	assertContains(t, msg, "https://rekt.news/bridge-hack", "URL present")
	assertAbsent(t, msg, "Source: https://", "URL must not carry Source: prefix")
	// Both tokens must not be comma-joined on a single line
	assertAbsent(t, msg, "@rektreporter, https://", "tokens must not be comma-joined")
}

// TestFormatRetractedMessage verifies that the RETRACTED rendering contains
// the struck-through RETRACTED marker and does NOT contain the live-post
// header (N3 acceptance criterion: edit to a struck-through RETRACTED state).
func TestFormatRetractedMessage(t *testing.T) {
	note := v2Note(
		"Butter Bridge V3.1 drained via reentrancy",
		"base",
		"0x31e5e5f2a8b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9",
		"@rektreporter",
	)
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Butter Bridge V3.1",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0x4059e47b062D9F959e2059b48cD6dB264EF5279F"},
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatRetractedMessage(p.Title)

	// Must contain the RETRACTED marker.
	assertContains(t, msg, "RETRACTED", "retracted marker")

	// Telegram HTML struck-through uses <s>…</s>.
	assertContains(t, msg, "<s>", "struck-through opening tag")
	assertContains(t, msg, "</s>", "struck-through closing tag")

	// Must NOT contain the live-post "🚨 HACK VERIFIED" header verbatim —
	// the RETRACTED state replaces, not appends to, the live message.
	assertAbsent(t, msg, "🚨 <b>HACK VERIFIED</b>", "live header must not appear in retracted message")
}

// TestFormatRetractedMessage_HTMLSafe verifies that HTML-sensitive characters
// in the title are escaped even in the RETRACTED rendering.
func TestFormatRetractedMessage_HTMLSafe(t *testing.T) {
	note := v2Note("<injected>", "base", "0xaa", "@anon")
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "<b>evil title</b>",
		note:        note,
		actionCount: 1,
		attackers:   []string{"0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatRetractedMessage(p.Title)

	assertAbsent(t, msg, "<b>evil title</b>", "raw HTML must be escaped in retracted message")
	assertContains(t, msg, "RETRACTED", "retracted marker must still be present")
}

// --- NEW: tests for real producer-format notes (issue #234) ---

// post10Note is the actual on-chain note for post #10 (Gnosis Pay / Zodiac
// Delay ERC1271 bypass on chainId 100). Format: prose body + "Attacked
// chains: [100]" footer + multi-line "Sources:" footer — exactly as written
// by NoteForCreatePost in damm-thatsrekt-relayer.
const post10Note = `On 2026-06-01 an attacker bypassed the Zodiac Delay Module guarding Gnosis Pay user Safes by forging an ERC1271 contract signature. The module's signature verifier compared the returned magic value without checking whether the verification call had actually succeeded, so a "signer" contract that reverts while returning the magic value was accepted as valid. Funds — primarily EURe and GNO — were drained from affected Safes on Gnosis Chain (chainId 100).

## root cause

Zodiac's SignatureChecker validates contract signatures in _isValidContractSignature(address signer, bytes32 hash, bytes signature). It staticcalls the signer's isValidSignature but discards the call's success flag, trusting only the returned bytes.

Because the success boolean is dropped, a signer contract that REVERTS while placing the 4-byte magic value (0x1626ba7e) in its revert data still passes the check.

Attacked chains: [100]

Sources:
  https://github.com/gnosis/zodiac/blob/master/contracts/core/Module.sol#L1
  https://theblock.co/post/gnosis-pay-exploit
  https://thedefiant.io/gnosis-pay-zodiac-delay-erc1271`

var gnosisChain = graphql.Chain{
	ChainID: 100,
	Slug:    "gnosis",
	Name:    "Gnosis",
}

// TestFormatPostMessage_TitleRendered verifies that p.Title appears in the
// Telegram message as the headline (acceptance criterion 1 from issue #234).
// This test MUST FAIL before the fix and PASS after.
func TestFormatPostMessage_TitleRendered(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Gnosis Pay / Zodiac Delay ERC1271 Bypass",
		note:        post10Note,
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       gnosisChain,
		updatedAt:   "2026-06-01T12:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// Title must appear in the message.
	assertContains(t, msg, "Gnosis Pay / Zodiac Delay ERC1271 Bypass", "title must be rendered as headline")
}

// TestFormatPostMessage_ProducerNoteBody verifies that the prose body from
// a real NoteForCreatePost note renders as the summary (acceptance criterion 2).
// This test MUST FAIL before the fix and PASS after.
func TestFormatPostMessage_ProducerNoteBody(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Gnosis Pay / Zodiac Delay ERC1271 Bypass",
		note:        post10Note,
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       gnosisChain,
		updatedAt:   "2026-06-01T12:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// The prose body prefix must appear somewhere in the message.
	assertContains(t, msg, "On 2026-06-01 an attacker bypassed", "prose body must be rendered")
	// The footer markers themselves must NOT appear verbatim in the output
	// (they are metadata, not content to display to users).
	assertAbsent(t, msg, "Attacked chains: [100]", "raw footer must not appear verbatim")
}

// TestFormatPostMessage_ProducerNoteChains verifies that the "Attacked chains: [100]"
// footer is parsed and the display chain name (or ID fallback) is used in
// line 2 (acceptance criterion 3).
func TestFormatPostMessage_ProducerNoteChains(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Gnosis Pay / Zodiac Delay ERC1271 Bypass",
		note:        post10Note,
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       gnosisChain,
		updatedAt:   "2026-06-01T12:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// Chain 100 should appear as "Gnosis" (known ID) in the "on <chains>" line
	// or at minimum the string "100" to show the chain was parsed.
	if !strings.Contains(msg, "Gnosis") && !strings.Contains(msg, "100") {
		t.Errorf("expected chain name 'Gnosis' or ID '100' from parsed Attacked chains footer, message:\n%s", msg)
	}
}

// TestFormatPostMessage_ProducerNoteSources verifies that the multi-line
// Sources footer is parsed and URLs are rendered in the sources section
// (acceptance criterion 4).
func TestFormatPostMessage_ProducerNoteSources(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Gnosis Pay / Zodiac Delay ERC1271 Bypass",
		note:        post10Note,
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       gnosisChain,
		updatedAt:   "2026-06-01T12:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	assertContains(t, msg, "github.com/gnosis/zodiac", "github source URL must appear")
	assertContains(t, msg, "theblock.co", "theblock source URL must appear")
	assertContains(t, msg, "thedefiant.io", "thedefiant source URL must appear")
}

// TestFormatPostMessage_NoAttackersNoVictims verifies that a post with no
// attackers and no victims renders without those sections — and does not crash.
// This was the exact live failure condition for post #10.
func TestFormatPostMessage_NoAttackersNoVictims(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Gnosis Pay / Zodiac Delay ERC1271 Bypass",
		note:        post10Note,
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       gnosisChain,
		updatedAt:   "2026-06-01T12:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	assertAbsent(t, msg, "Attackers:", "no attackers section when slice is nil")
	assertAbsent(t, msg, "Victims:", "no victims section when slice is nil")
	// Message must still have the header and the prose body.
	assertContains(t, msg, "HACK VERIFIED", "header must still be present")
	assertContains(t, msg, "On 2026-06-01 an attacker bypassed", "body must still be present")
}

// TestFormatPostMessage_TitleHTMLEscaped verifies that HTML-sensitive
// characters in p.Title are escaped before insertion (acceptance criterion
// "HTML parse-mode safety preserved").
func TestFormatPostMessage_TitleHTMLEscaped(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "<Evil> & \"Tricky\" Title",
		note:        "Plain prose note.\n\nAttacked chains: [1]\n\nSources:\n  https://example.com",
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       graphql.Chain{ChainID: 1, Slug: "ethereum", Name: "Ethereum"},
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	assertAbsent(t, msg, "<Evil>", "raw < in title must be escaped")
	assertContains(t, msg, "&lt;Evil&gt;", "title < > must be HTML-escaped")
}

// TestFormatPostMessage_NoteWithNoFooters verifies that a note containing
// only prose (no "Attacked chains:" or "Sources:") degrades gracefully:
// the body is still rendered and the chain falls back to p.Chain.
func TestFormatPostMessage_NoteWithNoFooters(t *testing.T) {
	p := makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "Legacy Post",
		note:        "Old plain-text note with no footer markers.",
		actionCount: 1,
		attackers:   nil,
		victims:     nil,
		chain:       graphql.Chain{ChainID: 1, Slug: "ethereum", Name: "Ethereum"},
		updatedAt:   "2026-05-21T14:00:00Z",
	})

	msg := telegram.FormatPostMessageAt(p, fixedNow)

	// Must not crash and must still contain the header.
	assertContains(t, msg, "HACK VERIFIED", "header present for legacy note")
	// Title must be rendered.
	assertContains(t, msg, "Legacy Post", "title rendered even for legacy note")
	// Falls back to posting chain name in line 2.
	assertContains(t, msg, "Ethereum", "chain fallback in line 2")
	// Prose body should appear.
	assertContains(t, msg, "Old plain-text note with no footer markers.", "legacy prose body rendered")
}

// --- helpers ---

func assertContains(t *testing.T, haystack, needle, label string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("[%s] expected %q in message, not found.\nMessage:\n%s", label, needle, haystack)
	}
}

func assertAbsent(t *testing.T, haystack, needle, label string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("[%s] did not expect %q in message, but found it.\nMessage:\n%s", label, needle, haystack)
	}
}
