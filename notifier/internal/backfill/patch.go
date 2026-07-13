// Package backfill provides an idempotent one-shot patch for the 6 pre-N3
// state entries that are missing a chainSlug field.
//
// Background: before N3 deployed (PR #257, 2026-07-13), the notifier did not
// store chainSlug at publish time. StoredPosts() filters entries with an empty
// ChainSlug, so these posts are invisible to checkRetracts and can never be
// retracted. The fix is to add chainSlug="ethereum" to the 6 orphaned entries
// so the next PollOnce can retract them.
//
// Operator workflow (run from notifier/):
//
//	aws s3 cp s3://damm-thatsrekt-notifier-state/state.json /tmp/state.json
//	go run ./cmd/backfill --dry-run --file /tmp/state.json
//	# Review the output, then:
//	go run ./cmd/backfill --file /tmp/state.json > /tmp/state-patched.json
//	diff /tmp/state.json /tmp/state-patched.json  # final sanity check
//	aws s3 cp /tmp/state-patched.json s3://damm-thatsrekt-notifier-state/state.json
package backfill

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
)

// Result describes one entry that was (or in dry-run mode: would be) patched.
type Result struct {
	PostID    string
	MessageID int64
	NewSlug   string // inferred from the composite post ID
}

// PatchState identifies orphaned PostState entries — those with ChainSlug==""
// and Retracted==false and MessageID!=0 — and sets ChainSlug by inferring it
// from the composite post ID (e.g. "ethereum-1" → slug "ethereum").
//
// When dryRun is true the function returns the Results that would be patched but
// leaves the state unchanged. The operation is idempotent: entries that already
// have a non-empty ChainSlug are skipped on re-runs.
//
// Returns an error if state is nil or if a post ID cannot be parsed into a
// valid, recognised chain slug.
func PatchState(state *store.State, dryRun bool) ([]Result, error) {
	if state == nil {
		return nil, fmt.Errorf("backfill: state is nil")
	}
	var results []Result
	for id, ps := range state.Posts {
		if ps.ChainSlug != "" || ps.Retracted || ps.MessageID == 0 {
			// Already patched, already retracted, or no TG message — skip.
			continue
		}
		slug, err := inferSlug(id)
		if err != nil {
			return nil, fmt.Errorf("backfill: post %q: %w", id, err)
		}
		results = append(results, Result{
			PostID:    id,
			MessageID: ps.MessageID,
			NewSlug:   slug,
		})
		if !dryRun {
			ps.ChainSlug = slug
			state.Posts[id] = ps
		}
	}
	return results, nil
}

// PatchJSON parses a state.json document, applies PatchState, and returns the
// list of Results plus the (optionally) patched JSON.
//
// When dryRun is true the returned JSON is the unmodified input. When dryRun is
// false the returned JSON has chainSlug injected for each orphaned entry.
// The operation is safe to call multiple times (idempotent).
func PatchJSON(raw []byte, dryRun bool) ([]Result, []byte, error) {
	var state store.State
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, nil, fmt.Errorf("backfill: unmarshal state: %w", err)
	}
	if state.Posts == nil {
		state.Posts = map[string]store.PostState{}
	}
	if state.LastSeenByChain == nil {
		state.LastSeenByChain = map[string]string{}
	}

	results, err := PatchState(&state, dryRun)
	if err != nil {
		return nil, nil, err
	}
	if dryRun {
		return results, raw, nil
	}

	out, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("backfill: marshal patched state: %w", err)
	}
	return results, out, nil
}

// inferSlug extracts the chain slug from a composite post ID.
// Format: "{slug}-{onchainID}" — uses the last "-" as separator so multi-
// hyphen slugs (e.g. "anvil-eth", "base-sepolia") resolve correctly.
// Returns an error when the ID is malformed or the inferred slug is not in
// the notifier's chainConfig (graphql.PrefixForChain).
func inferSlug(postID string) (string, error) {
	idx := strings.LastIndex(postID, "-")
	if idx <= 0 {
		return "", fmt.Errorf("malformed post ID %q — expected format {slug}-{onchainID}", postID)
	}
	slug := postID[:idx]
	if _, ok := graphql.PrefixForChain(slug); !ok {
		return "", fmt.Errorf("inferred slug %q from post ID %q is not in chainConfig — add it to chainConfig first", slug, postID)
	}
	return slug, nil
}
