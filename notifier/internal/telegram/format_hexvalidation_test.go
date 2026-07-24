// Regression tests: only well-formed hex renders as an address / tx, and note
// markup never reaches the channel as literal text.
//
// Prod alert, 2026-07-24 — the "Tx:" section rendered as:
//
//	Tx:
//	  <a hre…</a> (<a hre…</a>)
//
// note.go:247 assigns ExploitTxHashes with splitTrimmed() and NO validation, so
// the note's `txs:` field — which contained raw `<a href="https://t.co/…">…</a>`
// markup — was treated as a tx hash and fed through addrAbbrev(), which blindly
// takes first-6 + last-4 of any string.
//
// The same alert also showed the body's embedded anchors verbatim, because the
// note text itself carries HTML that html() correctly escapes for safety but
// which then displays as markup to the reader.
//
// Both are upstream data-quality problems (claw should not be writing HTML into
// notes), but the notifier renders to a user-facing channel and must not emit
// garbage regardless of what it is handed.
package telegram_test

import (
	"strings"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// The exact shape observed in the prod note's `txs:` field.
const anchorMarkup = `<a href="https://t.co/EjVLgq90Sd">zilliqa.blockscout.com/tx/0x370c64084…</a>`

func mk(note string, attackers, victims []string) graphql.Post {
	return makePost(struct {
		title       string
		note        string
		actionCount int
		attackers   []string
		victims     []string
		chain       graphql.Chain
		updatedAt   string
	}{
		title:       "ZIL sweep",
		note:        note,
		actionCount: 1,
		attackers:   attackers,
		victims:     victims,
		chain:       baseChain,
		updatedAt:   "2026-05-21T14:00:00Z",
	})
}

func TestFormatPostMessage_NonHexTxIsNotRendered(t *testing.T) {
	msg := telegram.FormatPostMessage(mk(v2Note("summary", "8453", anchorMarkup, ""), nil, nil))

	if strings.Contains(msg, "hre…") {
		t.Fatalf("mangled anchor rendered as a tx hash:\n%s", msg)
	}
	// With no valid tx hashes, the Tx: section must be omitted entirely rather
	// than printed empty.
	if strings.Contains(msg, "Tx:") {
		t.Fatalf("Tx: section rendered with no valid hashes:\n%s", msg)
	}
}

func TestFormatPostMessage_ValidTxStillRenders(t *testing.T) {
	tx := "0x370c640843f1e0d9a2f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7"
	msg := telegram.FormatPostMessage(mk(v2Note("summary", "8453", tx, ""), nil, nil))

	if !strings.Contains(msg, "Tx:") {
		t.Fatalf("valid tx hash should render a Tx: section:\n%s", msg)
	}
	if !strings.Contains(msg, "basescan.org/tx/"+tx) {
		t.Fatalf("valid tx hash should produce an explorer link:\n%s", msg)
	}
}

func TestFormatPostMessage_MixedTxListKeepsOnlyValid(t *testing.T) {
	tx := "0x370c640843f1e0d9a2f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7"
	msg := telegram.FormatPostMessage(
		mk(v2Note("summary", "8453", anchorMarkup+", "+tx, ""), nil, nil))

	if strings.Contains(msg, "hre…") {
		t.Fatalf("invalid entry survived alongside a valid one:\n%s", msg)
	}
	if !strings.Contains(msg, "basescan.org/tx/"+tx) {
		t.Fatalf("valid entry was dropped:\n%s", msg)
	}
}

func TestFormatPostMessage_NonHexAddressIsNotRendered(t *testing.T) {
	msg := telegram.FormatPostMessage(
		mk(v2Note("summary", "8453", "", ""), []string{anchorMarkup}, nil))

	if strings.Contains(msg, "hre…") {
		t.Fatalf("mangled anchor rendered as an attacker address:\n%s", msg)
	}
	if strings.Contains(msg, "Attackers:") {
		t.Fatalf("Attackers: section rendered with no valid addresses:\n%s", msg)
	}
}

func TestFormatPostMessage_ValidAddressStillRenders(t *testing.T) {
	addr := "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
	msg := telegram.FormatPostMessage(
		mk(v2Note("summary", "8453", "", ""), []string{addr}, nil))

	if !strings.Contains(msg, "basescan.org/address/"+addr) {
		t.Fatalf("valid address should still link:\n%s", msg)
	}
}

// The body carried `<a href="…">label</a>`; escaping made it safe but visible.
// The reader should get the human-readable text, not markup.
func TestFormatPostMessage_BodyMarkupIsNotShownLiterally(t *testing.T) {
	body := `Zilliqa confirmed a theft. Wallet: ` + anchorMarkup
	msg := telegram.FormatPostMessage(mk(v2Note(body, "8453", "", ""), nil, nil))

	if strings.Contains(msg, "&lt;a href") || strings.Contains(msg, "<a hre") {
		t.Fatalf("raw anchor markup leaked into the rendered body:\n%s", msg)
	}
	if !strings.Contains(msg, "Zilliqa confirmed a theft") {
		t.Fatalf("body prose was lost:\n%s", msg)
	}
	// The link target is still useful information — keep the URL as plain text.
	if !strings.Contains(msg, "https://t.co/EjVLgq90Sd") {
		t.Fatalf("link target should survive as readable text:\n%s", msg)
	}
}

// Prod notes sometimes write a numeric chain ID into the legacy `chains:`
// slug field, which rendered as a bare "on 1" instead of "on Ethereum".
func TestFormatPostMessage_NumericChainSlugRendersAsName(t *testing.T) {
	msg := telegram.FormatPostMessage(mk(v2Note("summary", "1", "", ""), nil, nil))
	if !strings.Contains(msg, "on Ethereum") {
		t.Fatalf("numeric chain slug should render as a name:\n%s", msg)
	}
}

// Real slugs must be untouched.
func TestFormatPostMessage_NonNumericChainSlugPreserved(t *testing.T) {
	msg := telegram.FormatPostMessage(mk(v2Note("summary", "solana", "", ""), nil, nil))
	if !strings.Contains(msg, "on solana") {
		t.Fatalf("non-numeric slug should be preserved:\n%s", msg)
	}
}
