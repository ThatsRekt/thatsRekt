// Package note — parser for on-chain post notes.
//
// Two formats are supported:
//
// # Legacy v2 key:value format (old; written by early notifier PRs)
//
// A newline-delimited key:value header block:
//
//	summary: <one-line human summary>
//	chains:  <comma-separated chain slugs>
//	txs:     <comma-separated exploit tx hashes>
//	sources: <comma-separated @handle or URL tokens>
//
// # Producer format (current; written by NoteForCreatePost in
// damm-thatsrekt-relayer/internal/action/action.go)
//
// Free-prose body followed by optional footers:
//
//	<prose body — one or more paragraphs>
//
//	Attacked chains: [<chainId1> <chainId2> ...]
//
//	Sources:
//	  <url1>
//	  <url2>
//
// The chain-ID list uses Go's %v rendering of a []uint64 — space-separated
// inside brackets (e.g. "[1 8453]"), NOT comma-separated.
//
// Parsing is deliberately lenient. Unknown keys and malformed lines are
// silently ignored. The parser never returns an error — callers always get a
// (possibly empty) ParsedNote.
package note

import (
	"strconv"
	"strings"
)

// ParsedNote is the structured representation of a parsed on-chain note.
// All fields are zero-value (empty/nil) when the corresponding section is
// absent.
//
// For the producer format, Body / AttackedChainIDs / Sources are populated.
// For the legacy key:value format, Summary / AttackedChains / ExploitTxHashes /
// Sources are populated. The formatter should prefer Body over Summary and
// AttackedChainIDs over AttackedChains when both are present.
type ParsedNote struct {
	// Body is the free-prose body of a producer-format note (everything before
	// the "Attacked chains:" footer). Empty for legacy key:value notes.
	Body string

	// AttackedChainIDs holds the integer chain IDs parsed from the producer-
	// format "Attacked chains: [<id>, ...]" footer. Empty for legacy notes.
	AttackedChainIDs []int

	// Summary is the one-line human summary from a legacy key:value note.
	Summary string

	// AttackedChains lists the chain slugs from a legacy key:value note.
	AttackedChains []string

	// ExploitTxHashes lists the exploit tx hashes from a legacy key:value note.
	ExploitTxHashes []string

	// Sources lists source attribution tokens (@handle or URL). Populated from
	// both the producer-format multi-line "Sources:" footer and the legacy
	// comma-separated "sources:" key.
	Sources []string
}

// ParseNote parses a raw on-chain note string into a ParsedNote.
// It auto-detects the format:
//   - If the note contains an "Attacked chains: [...]" marker it is treated as
//     producer format and the body / AttackedChainIDs / Sources are extracted.
//   - Otherwise the legacy key:value scanner is applied.
//
// The function is pure: same input always produces the same output.
func ParseNote(raw string) ParsedNote {
	if raw == "" {
		return ParsedNote{}
	}
	if isProducerFormat(raw) {
		return parseProducerFormat(raw)
	}
	return parseLegacyFormat(raw)
}

// isProducerFormat returns true when the note was written by NoteForCreatePost.
// Detection keys on either footer marker:
//   - "Attacked chains:" — always written when AttackedChainIDs is non-empty.
//   - "\n\nSources:\n" — written when Sources is non-empty (can appear without the
//     chains footer if AttackedChainIDs was empty).
//
// A note that carries a "Sources:" footer but no "Attacked chains:" footer is
// still producer-format; classifying it as legacy would leave the raw
// "Sources:\n  <url>" block in the body and drop the source URLs.
func isProducerFormat(raw string) bool {
	hasChains := strings.Contains(raw, "\nAttacked chains:") || strings.HasPrefix(raw, "Attacked chains:")
	hasSources := strings.Contains(raw, "\n\nSources:\n") || strings.HasPrefix(raw, "Sources:\n")
	return hasChains || hasSources
}

// parseProducerFormat handles notes written by NoteForCreatePost:
//
//	<prose body>
//
//	Attacked chains: [chainId1 chainId2 ...]
//
//	Sources:
//	  url1
//	  url2
//
// Either footer section is optional. The prose body is everything before the
// first footer marker ("Attacked chains:" or "\n\nSources:").
func parseProducerFormat(raw string) ParsedNote {
	var out ParsedNote

	// Find the earliest footer marker to determine where the prose body ends.
	// NoteForCreatePost always separates footers from the body with "\n\n", so
	// we look for both possible first-footer positions and pick the earliest.
	attackedIdx := strings.Index(raw, "Attacked chains:")
	sourcesIdx := strings.Index(raw, "\n\nSources:\n")

	footerStart := -1
	switch {
	case attackedIdx >= 0 && sourcesIdx >= 0:
		if attackedIdx <= sourcesIdx {
			footerStart = attackedIdx
		} else {
			footerStart = sourcesIdx + 2 // skip the leading "\n\n"
		}
	case attackedIdx >= 0:
		footerStart = attackedIdx
	case sourcesIdx >= 0:
		footerStart = sourcesIdx + 2 // skip the leading "\n\n"
	}

	if footerStart < 0 {
		// No recognised footer — body is the full note.
		out.Body = strings.TrimSpace(raw)
		return out
	}

	out.Body = strings.TrimSpace(raw[:footerStart])
	footer := raw[footerStart:]

	// Parse each footer line.
	lines := strings.Split(footer, "\n")
	inSources := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "Attacked chains:") {
			inSources = false
			// Extract chain IDs from the bracketed list produced by Go %v:
			// "Attacked chains: [1 8453 42161]"
			rest := strings.TrimPrefix(trimmed, "Attacked chains:")
			rest = strings.TrimSpace(rest)
			out.AttackedChainIDs = parseChainIDs(rest)
			continue
		}

		if trimmed == "Sources:" {
			inSources = true
			continue
		}

		if inSources {
			if trimmed == "" {
				// Blank line ends the sources block.
				inSources = false
				continue
			}
			// Indented URL lines: trim leading whitespace only.
			url := strings.TrimSpace(line)
			if url != "" {
				out.Sources = append(out.Sources, url)
			}
		}
	}

	return out
}

// parseChainIDs parses a bracketed integer list into a []int.
//
// The authoritative producer format is Go's %v rendering of a []uint64 slice,
// which is space-separated inside brackets: "[1 8453 42161]". Commas are also
// accepted as separators so that hand-written notes remain valid.
//
// Non-integer tokens are silently skipped. Surrounding brackets are stripped.
func parseChainIDs(s string) []int {
	// Strip surrounding brackets if present.
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "[")
	s = strings.TrimSuffix(s, "]")
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// Split on any run of whitespace and/or commas so both the canonical
	// Go %v form ("[1 8453]") and hand-written comma form ("[1, 8453]") work.
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '\t' || r == ','
	})
	ids := make([]int, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		id, err := strconv.Atoi(p)
		if err != nil {
			continue // skip non-integer tokens silently
		}
		ids = append(ids, id)
	}
	return ids
}

// parseLegacyFormat handles the old key:value header format.
// If no recognized keys are found (plain prose with no structure), the full
// trimmed note is placed in Body so the formatter can still render it.
func parseLegacyFormat(raw string) ParsedNote {
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
	// For plain prose notes (no recognized key:value structure), populate Body
	// with the full trimmed text so the formatter can render it.
	if out.Summary == "" && len(out.AttackedChains) == 0 && len(out.Sources) == 0 {
		out.Body = strings.TrimSpace(raw)
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
