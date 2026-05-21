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
