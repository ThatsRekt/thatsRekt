// Package note — parser for the v2 self-describing on-chain post note.
//
// In v2 the relayer writes a structured note when it calls createPost or
// amendNote. The format is a newline-delimited key:value header block
// followed by a blank line and a free-form summary:
//
//	summary: <one-line human summary>
//	chains: <comma-separated chain slugs>
//	txs: <comma-separated exploit tx hashes>
//	sources: <comma-separated @handle or URL tokens>
//
// All keys are optional. Lines that don't match the pattern are ignored so
// old-format notes (plain text) degrade gracefully — the caller gets an
// empty ParsedNote and falls back to rendering the raw note text.
//
// Parsing is deliberately lenient: unknown keys are silently skipped, extra
// whitespace is trimmed, and empty-after-trim values are treated as absent.
// Callers must not rely on a specific error for malformed input — the parser
// never returns an error.
package note

import (
	"strings"
)

// ParsedNote is the structured representation of a v2 self-describing note.
// All fields are zero-value (empty) when the corresponding key is absent.
type ParsedNote struct {
	// Summary is the one-line human summary extracted from the note.
	Summary string

	// AttackedChains lists the chain slugs the exploit spanned.
	AttackedChains []string

	// ExploitTxHashes lists the exploit transaction hashes.
	ExploitTxHashes []string

	// Sources lists the source attribution tokens (@handle or URL).
	Sources []string
}

// ParseNote parses a v2 self-describing note string into a ParsedNote.
// Unknown keys and malformed lines are silently ignored.
// The function is pure: same input always yields the same output.
func ParseNote(raw string) ParsedNote {
	var out ParsedNote
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(strings.ToLower(key))
		val = strings.TrimSpace(val)
		if val == "" {
			continue
		}
		switch key {
		case "summary":
			out.Summary = val
		case "chains":
			out.AttackedChains = splitTrimmed(val)
		case "txs":
			out.ExploitTxHashes = splitTrimmed(val)
		case "sources":
			out.Sources = splitTrimmed(val)
		}
	}
	return out
}

// splitTrimmed splits a comma-separated value string and trims each token.
// Empty-after-trim tokens are omitted.
func splitTrimmed(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}
