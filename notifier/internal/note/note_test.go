package note_test

import (
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/note"
)

func TestParseNote_Empty(t *testing.T) {
	got := note.ParseNote("")
	if got.Summary != "" {
		t.Errorf("expected empty summary, got %q", got.Summary)
	}
	if len(got.AttackedChains) != 0 {
		t.Errorf("expected no attacked chains, got %v", got.AttackedChains)
	}
	if len(got.ExploitTxHashes) != 0 {
		t.Errorf("expected no exploit txs, got %v", got.ExploitTxHashes)
	}
	if len(got.Sources) != 0 {
		t.Errorf("expected no sources, got %v", got.Sources)
	}
	if got.Body != "" {
		t.Errorf("expected empty body, got %q", got.Body)
	}
	if len(got.AttackedChainIDs) != 0 {
		t.Errorf("expected no attacked chain IDs, got %v", got.AttackedChainIDs)
	}
}

func TestParseNote_FullV2Note(t *testing.T) {
	raw := `summary: Butter Bridge V3.1 drained via reentrancy
chains: ethereum, arbitrum
txs: 0x31e5e5f2a8b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0, 0xaabbcc
sources: @rektreporter, https://rekt.news/butter-bridge`

	got := note.ParseNote(raw)

	if got.Summary != "Butter Bridge V3.1 drained via reentrancy" {
		t.Errorf("summary mismatch: %q", got.Summary)
	}
	if len(got.AttackedChains) != 2 || got.AttackedChains[0] != "ethereum" || got.AttackedChains[1] != "arbitrum" {
		t.Errorf("attacked chains mismatch: %v", got.AttackedChains)
	}
	if len(got.ExploitTxHashes) != 2 {
		t.Errorf("exploit tx count mismatch: %v", got.ExploitTxHashes)
	}
	if len(got.Sources) != 2 || got.Sources[0] != "@rektreporter" {
		t.Errorf("sources mismatch: %v", got.Sources)
	}
}

func TestParseNote_PartialKeys(t *testing.T) {
	raw := "summary: Flash loan attack on FooProtocol"

	got := note.ParseNote(raw)
	if got.Summary != "Flash loan attack on FooProtocol" {
		t.Errorf("summary mismatch: %q", got.Summary)
	}
	if len(got.AttackedChains) != 0 {
		t.Errorf("expected no chains, got %v", got.AttackedChains)
	}
}

func TestParseNote_OldFormatDegrades(t *testing.T) {
	// Old-format notes are plain prose — they have no key:value structure.
	// Parser must not panic and must return an empty ParsedNote.
	raw := "Some old-style free-form note about a hack with no structure at all."
	got := note.ParseNote(raw)
	if got.Summary != "" {
		t.Errorf("expected empty summary for plain text note, got %q", got.Summary)
	}
}

func TestParseNote_WhitespaceTolerance(t *testing.T) {
	raw := "  summary  :   Something with extra spaces   \n  chains :  base , optimism  "
	got := note.ParseNote(raw)
	if got.Summary != "Something with extra spaces" {
		t.Errorf("summary with whitespace: %q", got.Summary)
	}
	if len(got.AttackedChains) != 2 || got.AttackedChains[1] != "optimism" {
		t.Errorf("chains with whitespace: %v", got.AttackedChains)
	}
}

func TestParseNote_EmptyValues(t *testing.T) {
	raw := "summary: \nchains: "
	got := note.ParseNote(raw)
	if got.Summary != "" {
		t.Errorf("expected empty summary for blank value, got %q", got.Summary)
	}
	if len(got.AttackedChains) != 0 {
		t.Errorf("expected empty chains for blank value, got %v", got.AttackedChains)
	}
}

// --- NEW: real producer format tests (NoteForCreatePost) ---

// post10FixtureNote is a faithful copy of the on-chain note for post #10 on
// Gnosis Chain (chainId 100): prose body + "Attacked chains: [100]" footer +
// "Sources:" multi-line footer. This is the format written by
// damm-thatsrekt-relayer/internal/action/action.go::NoteForCreatePost.
const post10FixtureNote = `On 2026-06-01 an attacker bypassed the Zodiac Delay Module guarding Gnosis Pay user Safes by forging an ERC1271 contract signature. The module's signature verifier compared the returned magic value without checking whether the verification call had actually succeeded, so a "signer" contract that reverts while returning the magic value was accepted as valid. Funds — primarily EURe and GNO — were drained from affected Safes on Gnosis Chain (chainId 100).

## root cause

Zodiac's SignatureChecker validates contract signatures in _isValidContractSignature(address signer, bytes32 hash, bytes signature). It staticcalls the signer's isValidSignature but discards the call's success flag, trusting only the returned bytes:

` + "```" + `solidity
(, bytes memory returnData) = signer.staticcall(
    abi.encodeWithSelector(
        IERC1271.isValidSignature.selector, hash, signature
    )
);
return bytes4(returnData) == EIP1271_MAGIC_VALUE;
` + "```" + `

Because the success boolean is dropped, a signer contract that REVERTS while placing the 4-byte magic value (0x1626ba7e) in its revert data still passes the check.

Attacked chains: [100]

Sources:
  https://github.com/gnosis/zodiac/blob/master/contracts/core/Module.sol#L1
  https://theblock.co/post/gnosis-pay-exploit
  https://thedefiant.io/gnosis-pay-zodiac-delay-erc1271`

// TestParseNote_ProducerFormat_Body verifies that the prose body (everything
// before "Attacked chains:") is extracted into ParsedNote.Body.
func TestParseNote_ProducerFormat_Body(t *testing.T) {
	got := note.ParseNote(post10FixtureNote)

	if got.Body == "" {
		t.Fatal("expected non-empty Body for producer-format note, got empty string")
	}
	// Body must start with the prose opening sentence.
	wantPrefix := "On 2026-06-01 an attacker bypassed"
	if len(got.Body) < len(wantPrefix) || got.Body[:len(wantPrefix)] != wantPrefix {
		t.Errorf("Body does not start with expected prefix.\nGot: %q", got.Body[:min(80, len(got.Body))])
	}
	// Body must NOT contain the footer markers.
	if contains(got.Body, "Attacked chains:") {
		t.Errorf("Body must not include the 'Attacked chains:' footer line, but got: %q", got.Body)
	}
	if contains(got.Body, "Sources:") {
		t.Errorf("Body must not include the 'Sources:' footer line, but got: %q", got.Body)
	}
}

// TestParseNote_ProducerFormat_AttackedChainIDs verifies that chain IDs are
// parsed from the "Attacked chains: [100]" footer.
func TestParseNote_ProducerFormat_AttackedChainIDs(t *testing.T) {
	got := note.ParseNote(post10FixtureNote)

	if len(got.AttackedChainIDs) != 1 {
		t.Fatalf("expected 1 attacked chain ID, got %v", got.AttackedChainIDs)
	}
	if got.AttackedChainIDs[0] != 100 {
		t.Errorf("expected chain ID 100, got %d", got.AttackedChainIDs[0])
	}
}

// TestParseNote_ProducerFormat_Sources verifies that multi-line indented URLs
// under "Sources:" are parsed into ParsedNote.Sources.
func TestParseNote_ProducerFormat_Sources(t *testing.T) {
	got := note.ParseNote(post10FixtureNote)

	if len(got.Sources) != 3 {
		t.Fatalf("expected 3 sources, got %d: %v", len(got.Sources), got.Sources)
	}
	if !contains(got.Sources[0], "github.com") {
		t.Errorf("first source should be github URL, got %q", got.Sources[0])
	}
	if !contains(got.Sources[1], "theblock.co") {
		t.Errorf("second source should be theblock URL, got %q", got.Sources[1])
	}
	if !contains(got.Sources[2], "thedefiant.io") {
		t.Errorf("third source should be thedefiant URL, got %q", got.Sources[2])
	}
}

// TestParseNote_ProducerFormat_MultipleChainIDs verifies parsing of multiple
// chain IDs in the footer using the REAL Go %v rendering: "[1 8453]"
// (space-separated, no commas). This is the exact output of
// fmt.Sprintf("%v", []uint64{1, 8453}) in NoteForCreatePost.
func TestParseNote_ProducerFormat_MultipleChainIDs(t *testing.T) {
	// Use the exact %v form: "[1 8453]" — NOT "[1, 8453]".
	raw := "Cross-chain bridge exploit.\n\nAttacked chains: [1 8453]\n\nSources:\n  https://rekt.news/bridge"
	got := note.ParseNote(raw)

	if got.Body == "" {
		t.Fatal("expected non-empty Body")
	}
	if len(got.AttackedChainIDs) != 2 {
		t.Fatalf("expected 2 attacked chain IDs, got %v", got.AttackedChainIDs)
	}
	if got.AttackedChainIDs[0] != 1 || got.AttackedChainIDs[1] != 8453 {
		t.Errorf("chain IDs mismatch: got %v, want [1 8453]", got.AttackedChainIDs)
	}
	if len(got.Sources) != 1 || got.Sources[0] != "https://rekt.news/bridge" {
		t.Errorf("sources mismatch: %v", got.Sources)
	}
}

// TestParseNote_ProducerFormat_ThreeChains_SpaceSeparated is a regression test
// for the comma-split bug. The old parseChainIDs split on "," which silently
// dropped all but the first token for space-separated slices like "[1 8453 42161]".
// This test MUST assert the exact parsed slice — a substring check is not enough.
func TestParseNote_ProducerFormat_ThreeChains_SpaceSeparated(t *testing.T) {
	// Exact output of fmt.Sprintf("%v", []uint64{1, 8453, 42161}).
	raw := "Multi-chain exploit.\n\nAttacked chains: [1 8453 42161]"
	got := note.ParseNote(raw)

	if got.Body == "" {
		t.Fatal("expected non-empty Body")
	}
	wantIDs := []int{1, 8453, 42161}
	if len(got.AttackedChainIDs) != len(wantIDs) {
		t.Fatalf("expected %d chain IDs, got %v", len(wantIDs), got.AttackedChainIDs)
	}
	for i, want := range wantIDs {
		if got.AttackedChainIDs[i] != want {
			t.Errorf("chain ID[%d]: got %d, want %d", i, got.AttackedChainIDs[i], want)
		}
	}
}

// TestParseNote_ProducerFormat_NoSources verifies that a note with the
// "Attacked chains:" footer but no "Sources:" section degrades gracefully.
func TestParseNote_ProducerFormat_NoSources(t *testing.T) {
	raw := "Some protocol was hacked.\n\nAttacked chains: [8453]"
	got := note.ParseNote(raw)

	if got.Body == "" {
		t.Fatal("expected non-empty Body")
	}
	if len(got.AttackedChainIDs) != 1 || got.AttackedChainIDs[0] != 8453 {
		t.Errorf("chain IDs mismatch: %v", got.AttackedChainIDs)
	}
	if len(got.Sources) != 0 {
		t.Errorf("expected no sources, got %v", got.Sources)
	}
}

// TestParseNote_ProducerFormat_SourcesOnlyNoChains verifies that a producer-
// format note with a "Sources:" footer but WITHOUT an "Attacked chains:" footer
// is still classified as producer-format. Without this, isProducerFormat returns
// false, parseLegacyFormat is called, the raw "Sources:\n  <url>" block leaks
// into Body, and Sources remains empty.
func TestParseNote_ProducerFormat_SourcesOnlyNoChains(t *testing.T) {
	raw := "Protocol drained via price manipulation.\n\nSources:\n  https://rekt.news/protocol\n  https://twitter.com/peckshield/status/123"
	got := note.ParseNote(raw)

	// Body must be clean prose only — no footer markers.
	wantBody := "Protocol drained via price manipulation."
	if got.Body != wantBody {
		t.Errorf("Body mismatch.\nGot:  %q\nWant: %q", got.Body, wantBody)
	}
	if contains(got.Body, "Sources:") {
		t.Errorf("Body must not contain 'Sources:' footer block, got: %q", got.Body)
	}
	// Sources must be parsed from the footer.
	if len(got.Sources) != 2 {
		t.Fatalf("expected 2 sources, got %d: %v", len(got.Sources), got.Sources)
	}
	if got.Sources[0] != "https://rekt.news/protocol" {
		t.Errorf("sources[0] mismatch: %q", got.Sources[0])
	}
	if got.Sources[1] != "https://twitter.com/peckshield/status/123" {
		t.Errorf("sources[1] mismatch: %q", got.Sources[1])
	}
	// No chains in this note.
	if len(got.AttackedChainIDs) != 0 {
		t.Errorf("expected no chain IDs, got %v", got.AttackedChainIDs)
	}
}

// TestParseNote_ProducerFormat_EmptyNote verifies that an empty note returns
// all zero-value fields without panic.
func TestParseNote_ProducerFormat_EmptyNote(t *testing.T) {
	got := note.ParseNote("")
	if got.Body != "" {
		t.Errorf("expected empty body, got %q", got.Body)
	}
	if len(got.AttackedChainIDs) != 0 {
		t.Errorf("expected no chain IDs, got %v", got.AttackedChainIDs)
	}
	if len(got.Sources) != 0 {
		t.Errorf("expected no sources, got %v", got.Sources)
	}
}

// TestParseNote_ProducerFormat_PlainProseDegrades verifies that a note with
// no footer markers at all degrades gracefully: Body is the full prose,
// AttackedChainIDs and Sources are empty.
func TestParseNote_ProducerFormat_PlainProseDegrades(t *testing.T) {
	raw := "Old-style plain text note with no footer markers whatsoever."
	got := note.ParseNote(raw)

	// The full prose should be the body (no footer to strip).
	if got.Body == "" {
		t.Fatal("expected Body to contain the prose for a note with no footers")
	}
	if len(got.AttackedChainIDs) != 0 {
		t.Errorf("expected no chain IDs for plain note, got %v", got.AttackedChainIDs)
	}
	if len(got.Sources) != 0 {
		t.Errorf("expected no sources for plain note, got %v", got.Sources)
	}
}

// --- helpers ---

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexof(s, sub) >= 0)
}

func indexof(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
