// Package graphql_test — chain coverage guard.
//
// TestChainCoverage_AllMeshChainsCoveredByNotifier is the anti-drift guard for
// the 4th hardcoded-chain-list drift bug (thatsRekt#256, 2026-07-13).
//
// It parses mesh/src/chains.ts (the TypeScript single source of truth for all
// chain config) and asserts that Go's chainSlugToPrefix covers every slug+prefix
// pair the mesh exposes. If a chain is added to the mesh but not to the Go
// notifier's chainConfig, this test fails in CI before any post from that chain
// arrives at runtime.
//
// Mutation evidence (remove "bsc" entry from chainConfig in client.go):
//
//	--- FAIL: TestChainCoverage_AllMeshChainsCoveredByNotifier
//	    client_test.go:NN: mesh chain "bsc" (prefix "Bsc_") is not covered by
//	    chainSlugToPrefix — add it to chainConfig in client.go
package graphql_test

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
)

// TestChainCoverage_AllMeshChainsCoveredByNotifier is the load-bearing drift
// guard. It parses mesh/src/chains.ts, extracts every slug+prefix pair from the
// CHAINS array, and asserts Go's chainSlugToPrefix (via graphql.PrefixForChain)
// covers each one with the correct prefix.
//
// If this test is GREEN, no chain in the mesh is silently missing from the
// notifier's retract-detection path.
func TestChainCoverage_AllMeshChainsCoveredByNotifier(t *testing.T) {
	meshChains := parseMeshChains(t)

	if len(meshChains) == 0 {
		t.Fatal("parseMeshChains returned 0 entries — parser bug or mesh/src/chains.ts moved")
	}

	for slug, wantPrefix := range meshChains {
		gotPrefix, ok := graphql.PrefixForChain(slug)
		if !ok {
			t.Errorf(
				"mesh chain %q (prefix %q) is not covered by chainSlugToPrefix — add it to chainConfig in notifier/internal/graphql/client.go",
				slug, wantPrefix,
			)
			continue
		}
		if gotPrefix != wantPrefix {
			t.Errorf("mesh chain %q: mesh prefix %q ≠ Go prefix %q — update chainConfig in client.go", slug, wantPrefix, gotPrefix)
		}
	}

	if t.Failed() {
		t.Logf("This test iterates the real mesh/src/chains.ts chain list.")
		t.Logf("A failing entry means the Go notifier's chainConfig is missing a chain the mesh exposes.")
		t.Logf("Add the missing entry to chainConfig in notifier/internal/graphql/client.go.")
	}
}

// TestChainCoverage_NoOrphanedGoChains is an advisory hygiene check.
// Every slug in the Go notifier's chainConfig should exist in the mesh.
// An orphaned Go entry means a chain was removed from the mesh but not from
// the notifier — the notifier won't break (PostById just returns 0 hits),
// but it wastes one HTTP round-trip per poll per orphaned chain.
func TestChainCoverage_NoOrphanedGoChains(t *testing.T) {
	meshChains := parseMeshChains(t)
	for _, slug := range graphql.SupportedChainSlugs {
		if _, ok := meshChains[slug]; !ok {
			t.Logf("advisory: Go chainConfig has slug %q but it is not in mesh/src/chains.ts", slug)
		}
	}
}

// TestPrefixForChain_KnownSlug verifies PrefixForChain returns (prefix, true) for
// a slug that is in chainConfig.
func TestPrefixForChain_KnownSlug(t *testing.T) {
	prefix, ok := graphql.PrefixForChain("base")
	if !ok {
		t.Fatal("PrefixForChain(\"base\"): expected ok=true, got false")
	}
	if prefix != "Base_" {
		t.Errorf("PrefixForChain(\"base\"): expected %q, got %q", "Base_", prefix)
	}
}

// TestPrefixForChain_UnknownSlug verifies PrefixForChain returns ("", false) for
// a slug not in chainConfig.
func TestPrefixForChain_UnknownSlug(t *testing.T) {
	prefix, ok := graphql.PrefixForChain("not-a-real-chain")
	if ok {
		t.Errorf("PrefixForChain(\"not-a-real-chain\"): expected ok=false, got true with prefix=%q", prefix)
	}
	if prefix != "" {
		t.Errorf("PrefixForChain(\"not-a-real-chain\"): expected empty prefix, got %q", prefix)
	}
}

// TestSupportedChainSlugs_BscAndPolygon is the explicit regression guard for
// issue #256: bsc and polygon were missing from the original chainSlugToPrefix,
// causing ~2k-3.2k errors/hour via repeated "unknown chain slug" throws.
// This test fails immediately if either is absent, even before parseMeshChains runs.
func TestSupportedChainSlugs_BscAndPolygon(t *testing.T) {
	slugSet := make(map[string]bool, len(graphql.SupportedChainSlugs))
	for _, s := range graphql.SupportedChainSlugs {
		slugSet[s] = true
	}
	for _, required := range []string{"bsc", "polygon"} {
		if !slugSet[required] {
			t.Errorf(
				"SupportedChainSlugs is missing %q — retracts on this chain are silently broken (issue #256)",
				required,
			)
		}
	}
}

// parseMeshChains reads mesh/src/chains.ts and returns a map of slug → prefix
// for every entry in the exported CHAINS array.
//
// Parsing strategy: scan lines between "export const CHAINS" and the closing
// "])" line, extracting `slug: '...'` and `prefix: '...'` occurrences in order.
// Entries always appear in slug-before-prefix order within each object literal,
// and there is exactly one slug+prefix pair per chain entry.
func parseMeshChains(t *testing.T) map[string]string {
	t.Helper()

	// WARNING: this test IS cacheable by the Go test cache.
	//
	// The test reads mesh/src/chains.ts at runtime via os.Open. The Go test
	// cache keys on package source files and looked-up environment variable
	// values — it does NOT track arbitrary runtime filesystem reads. If
	// chains.ts changes but no Go source files change, `go test ./...` returns
	// "(cached)" and passes even though the drift guard would have caught the
	// new chain.
	//
	// The ONLY protection against this false GREEN is running with -count=1.
	// .github/workflows/notifier-ci.yml hard-codes -count=1 for exactly this
	// reason. DO NOT remove -count=1 from that workflow under any circumstances.
	//
	// Locally, always run: go test -count=1 ./internal/graphql/...

	// Resolve absolute path to mesh/src/chains.ts from the test file's location.
	// client_test.go lives at notifier/internal/graphql/client_test.go.
	// Up 3 dirs from notifier/internal/graphql/ reaches the repo root.
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller(0) failed — cannot determine source file path")
	}
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..", "..")
	chainsFile := filepath.Join(repoRoot, "mesh", "src", "chains.ts")

	f, err := os.Open(chainsFile)
	if err != nil {
		t.Fatalf("open mesh/src/chains.ts: %v\n(looked at: %s)", err, chainsFile)
	}
	defer f.Close()

	slugRe := regexp.MustCompile(`^\s+slug:\s*'([^']+)'`)
	prefixRe := regexp.MustCompile(`^\s+prefix:\s*'([^']+)'`)
	chainsStartRe := regexp.MustCompile(`export const CHAINS`)
	chainsEndRe := regexp.MustCompile(`^\s*\]\)`)

	var slugs, prefixes []string
	inChainsArray := false

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()

		if !inChainsArray {
			if chainsStartRe.MatchString(line) {
				inChainsArray = true
			}
			continue
		}
		// Stop at the closing ]) of the CHAINS export.
		if chainsEndRe.MatchString(line) {
			break
		}

		if m := slugRe.FindStringSubmatch(line); m != nil {
			slugs = append(slugs, m[1])
		}
		if m := prefixRe.FindStringSubmatch(line); m != nil {
			prefixes = append(prefixes, m[1])
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan mesh/src/chains.ts: %v", err)
	}
	if len(slugs) != len(prefixes) {
		t.Fatalf(
			"slug count (%d) ≠ prefix count (%d) in mesh/src/chains.ts — parser bug or file format changed",
			len(slugs), len(prefixes),
		)
	}
	if len(slugs) == 0 {
		t.Fatal("parsed 0 chains from mesh/src/chains.ts — parser bug or file format changed")
	}

	result := make(map[string]string, len(slugs))
	for i, slug := range slugs {
		result[slug] = prefixes[i]
	}
	return result
}
