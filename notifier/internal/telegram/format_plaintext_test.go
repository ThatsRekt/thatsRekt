package telegram_test

// Tests for FormatPlainTextMessage — the last-resort alert path used when
// Telegram rejects the HTML render with a parse error (issue #262). Prior to
// PR #265's review, this function had zero tests despite being the final
// fallback for a public safety channel.
//
// Covers PR #265 review suggestion 1:
//   - the address/tx/victim anchor line must not double-render its label
//     ("0x1234…abcd (0x1234…abcd (https://…))" collapses to
//     "0x1234…abcd (https://…)");
//   - hostile on-chain markup ("<b>") reveals as literal, safe plain text
//     rather than staying HTML-escaped gibberish — documented as the correct
//     behaviour for parse_mode="", not a regression of #264;
//   - the plain-text output never carries parse_mode (already covered by
//     TestSendMessage_PlainText_NoParseMode in classify_test.go's sibling
//     bot_test.go — not duplicated here);
//   - an over-length message is truncated to fit Telegram's 4096-character
//     limit rather than being rejected outright.
import (
	"strings"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

func plainTextTestPost() graphql.Post {
	return graphql.Post{
		ID:            "ethereum-1",
		Chain:         graphql.Chain{ChainID: 1, Slug: "ethereum", Name: "Ethereum"},
		Title:         "Butter Bridge Hack",
		Note:          "summary: Butter Bridge drained\nchains: ethereum\ntxs: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsources: @rekt",
		ActionCount:   1,
		LastUpdatedAt: "2026-05-21T10:00:00Z",
		Attackers:     []string{"0x1111111111111111111111111111111111111111"},
		Victims:       []string{"0x2222222222222222222222222222222222222222"},
	}
}

// TestFormatPlainTextMessage_NoDuplicateAddressLabel verifies the address
// line renders exactly once, not "LABEL (LABEL (url))".
//
// Mutation evidence:
//
//	Sabotage: remove the collapseDuplicateAnchorLabel step from
//	          FormatPlainTextMessage's pipeline.
//	Result:   the attacker line reads
//	          "0x1111…1111 (0x1111…1111 (https://etherscan.io/address/...))"
//	          — this test fails on the "exactly one occurrence" check.
func TestFormatPlainTextMessage_NoDuplicateAddressLabel(t *testing.T) {
	plain := telegram.FormatPlainTextMessage(plainTextTestPost())

	const label = "0x1111…1111"
	if got := strings.Count(plain, label); got != 1 {
		t.Errorf("expected attacker label %q to appear exactly once in plain text, got %d\nfull text:\n%s", label, got, plain)
	}
	if strings.Contains(plain, label+" ("+label) {
		t.Errorf("plain text still contains the doubled-label artifact:\n%s", plain)
	}

	const victimLabel = "0x2222…2222"
	if got := strings.Count(plain, victimLabel); got != 1 {
		t.Errorf("expected victim label %q to appear exactly once in plain text, got %d\nfull text:\n%s", victimLabel, got, plain)
	}

	// The explorer URL must still be present (not dropped, just deduped).
	if !strings.Contains(plain, "https://etherscan.io/address/0x1111111111111111111111111111111111111111") {
		t.Errorf("expected attacker explorer URL to survive plain-text rendering:\n%s", plain)
	}
}

// TestFormatPlainTextMessage_HostileMarkupRevealsAsLiteralText documents and
// locks in the intended behaviour for on-chain content containing literal
// HTML-like text (e.g. an attacker-controlled note containing "<b>"): the
// plain-text fallback shows it as literal, inert characters. This is safe
// because parse_mode="" means Telegram never interprets entities — showing
// the STILL-ESCAPED "&lt;b&gt;" would be strictly worse (raw entity syntax
// visible to the reader) for zero safety benefit.
func TestFormatPlainTextMessage_HostileMarkupRevealsAsLiteralText(t *testing.T) {
	p := plainTextTestPost()
	p.Title = "Verus <b>Bridge</b>"

	plain := telegram.FormatPlainTextMessage(p)

	if !strings.Contains(plain, "Verus <b>Bridge</b>") {
		t.Errorf("expected hostile markup to appear as literal plain text (safe under parse_mode=\"\"), got:\n%s", plain)
	}
	// Must NOT still be HTML-entity-escaped — that would show raw entity
	// syntax to the channel's readers.
	if strings.Contains(plain, "&lt;b&gt;") {
		t.Errorf("plain text must not contain un-decoded HTML entities:\n%s", plain)
	}
}

// TestFormatPlainTextMessage_AnchorInBodyKeepsLabelAndURL verifies that a
// genuine free-form anchor embedded in the note body (distinct label and
// url — NOT the address/tx template's duplicate-label pattern) still renders
// as "label (url)" and is NOT affected by the anchor-dedup step.
func TestFormatPlainTextMessage_AnchorInBodyKeepsLabelAndURL(t *testing.T) {
	p := plainTextTestPost()
	p.Note = `summary: drained via <a href="https://evil.example/x">click here</a>` + "\nchains: ethereum"

	plain := telegram.FormatPlainTextMessage(p)

	if !strings.Contains(plain, "click here (https://evil.example/x)") {
		t.Errorf("expected body anchor to render as \"label (url)\", got:\n%s", plain)
	}
}

// TestFormatPlainTextMessage_NoHTMLTagsOrEntitiesRemain is a broad sweep
// asserting the plain-text output contains no stray HTML tags (anything
// matching "<...>") and no remaining named entities, since Telegram's
// parse_mode="" treats every byte literally.
func TestFormatPlainTextMessage_NoHTMLTagsOrEntitiesRemain(t *testing.T) {
	p := plainTextTestPost()
	p.Note = `summary: <script>alert(1)</script> drained via <a href="https://evil.example">click</a>` + "\nchains: ethereum"

	plain := telegram.FormatPlainTextMessage(p)

	if strings.Contains(plain, "<script>") || strings.Contains(plain, "</script>") {
		t.Errorf("plain text must not contain raw HTML tags:\n%s", plain)
	}
	for _, entity := range []string{"&lt;", "&gt;", "&amp;", "&quot;"} {
		if strings.Contains(plain, entity) {
			t.Errorf("plain text must not contain un-decoded entity %q:\n%s", entity, plain)
		}
	}
}

// TestFormatPlainTextMessage_TruncatesToTelegramLimit verifies an
// over-length message is clipped to fit Telegram's 4096-character
// sendMessage limit rather than being rejected outright with a non-parse
// 400 ("message is too long") that would otherwise burn the notifier's
// non-transient attempt budget on a message that could never fit.
//
// Mutation evidence:
//
//	Sabotage: remove the truncateForTelegram call from
//	          FormatPlainTextMessage's pipeline.
//	Result:   plain text length exceeds 4096 — this test fails on the length
//	          assertion.
func TestFormatPlainTextMessage_TruncatesToTelegramLimit(t *testing.T) {
	p := plainTextTestPost()
	p.Note = "summary: " + strings.Repeat("A", 6000) + "\nchains: ethereum"

	plain := telegram.FormatPlainTextMessage(p)

	if len([]rune(plain)) > 4096 {
		t.Errorf("expected plain text to be truncated to <=4096 runes, got %d", len([]rune(plain)))
	}
	if !strings.Contains(plain, "truncated") {
		t.Errorf("expected a truncation marker in the output, got:\n%s", plain[len(plain)-80:])
	}
}

// TestFormatPlainTextMessage_ShortMessageUnaffectedByTruncation verifies the
// truncation guard is a no-op for ordinary, well-under-limit messages.
func TestFormatPlainTextMessage_ShortMessageUnaffectedByTruncation(t *testing.T) {
	plain := telegram.FormatPlainTextMessage(plainTextTestPost())
	if strings.Contains(plain, "truncated") {
		t.Errorf("short message must not be truncated:\n%s", plain)
	}
}
