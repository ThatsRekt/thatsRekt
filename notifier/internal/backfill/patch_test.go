package backfill_test

import (
	"encoding/json"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/backfill"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
)

// ---- PatchState unit tests --------------------------------------------------

func TestPatchState_OrphanGetsSlug(t *testing.T) {
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts: map[string]store.PostState{
			"ethereum-1": {MessageID: 14},
		},
	}
	results, err := backfill.PatchState(state, false)
	if err != nil {
		t.Fatalf("PatchState: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result, got %d", len(results))
	}
	if results[0].NewSlug != "ethereum" {
		t.Errorf("NewSlug: got %q, want %q", results[0].NewSlug, "ethereum")
	}
	if results[0].MessageID != 14 {
		t.Errorf("MessageID: got %d, want 14", results[0].MessageID)
	}
	if results[0].PostID != "ethereum-1" {
		t.Errorf("PostID: got %q, want %q", results[0].PostID, "ethereum-1")
	}
	// The state must be mutated.
	if got := state.Posts["ethereum-1"].ChainSlug; got != "ethereum" {
		t.Errorf("state.Posts[ethereum-1].ChainSlug: got %q, want %q", got, "ethereum")
	}
}

func TestPatchState_DryRunDoesNotMutate(t *testing.T) {
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts: map[string]store.PostState{
			"ethereum-1": {MessageID: 14},
		},
	}
	results, err := backfill.PatchState(state, true /*dryRun*/)
	if err != nil {
		t.Fatalf("PatchState dry-run: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("expected 1 result in dry-run, got %d", len(results))
	}
	// State must be unchanged.
	if got := state.Posts["ethereum-1"].ChainSlug; got != "" {
		t.Errorf("dry-run must not mutate state; ChainSlug after dry-run: %q", got)
	}
}

func TestPatchState_IdempotentOnAlreadyPatched(t *testing.T) {
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts: map[string]store.PostState{
			"ethereum-1": {MessageID: 14, ChainSlug: "ethereum"},
		},
	}
	results, err := backfill.PatchState(state, false)
	if err != nil {
		t.Fatalf("PatchState on already-patched: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for already-patched entry, got %d", len(results))
	}
}

func TestPatchState_SkipsRetracted(t *testing.T) {
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts: map[string]store.PostState{
			"ethereum-1": {MessageID: 14, Retracted: true},
		},
	}
	results, err := backfill.PatchState(state, false)
	if err != nil {
		t.Fatalf("PatchState on retracted: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for retracted entry, got %d", len(results))
	}
}

func TestPatchState_SkipsZeroMessageID(t *testing.T) {
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts: map[string]store.PostState{
			"ethereum-1": {MessageID: 0},
		},
	}
	results, err := backfill.PatchState(state, false)
	if err != nil {
		t.Fatalf("PatchState on zero MessageID: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for zero MessageID entry, got %d", len(results))
	}
}

func TestPatchState_UnknownSlugErrors(t *testing.T) {
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts: map[string]store.PostState{
			// "not-a-chain-1" → inferred slug "not-a-chain" → not in chainConfig
			"not-a-chain-1": {MessageID: 99},
		},
	}
	_, err := backfill.PatchState(state, false)
	if err == nil {
		t.Error("expected error for unknown chain slug, got nil")
	}
}

// TestPatchState_AllSixOrphans patches the exact production orphan set and
// verifies all 6 get chainSlug="ethereum".
func TestPatchState_AllSixOrphans(t *testing.T) {
	orphans := []struct {
		postID string
		msgID  int64
	}{
		{"ethereum-1", 14},
		{"ethereum-2", 18},
		{"ethereum-3", 23},
		{"ethereum-4", 24},
		{"ethereum-5", 25},
		{"ethereum-6", 27},
	}
	posts := make(map[string]store.PostState, len(orphans))
	for _, o := range orphans {
		posts[o.postID] = store.PostState{MessageID: o.msgID}
	}
	state := &store.State{
		LastSeenByChain: map[string]string{},
		Posts:           posts,
	}

	results, err := backfill.PatchState(state, false)
	if err != nil {
		t.Fatalf("PatchState: %v", err)
	}
	if len(results) != 6 {
		t.Errorf("expected 6 results, got %d", len(results))
	}
	for _, o := range orphans {
		if got := state.Posts[o.postID].ChainSlug; got != "ethereum" {
			t.Errorf("state.Posts[%s].ChainSlug: got %q, want %q", o.postID, got, "ethereum")
		}
	}
}

// ---- PatchJSON tests --------------------------------------------------------

func TestPatchJSON_InjectsChainSlug(t *testing.T) {
	raw := []byte(`{
		"lastSeenByChain": {"ethereum": "ethereum-6"},
		"posts": {
			"ethereum-1": {"messageId": 14, "lastActionCount": 0, "lastUpdatedAt": ""},
			"ethereum-2": {"messageId": 18, "lastActionCount": 0, "lastUpdatedAt": ""}
		}
	}`)

	results, patched, err := backfill.PatchJSON(raw, false)
	if err != nil {
		t.Fatalf("PatchJSON: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results, got %d", len(results))
	}

	// Unmarshal the patched JSON and verify the slug was injected.
	var state store.State
	if err := json.Unmarshal(patched, &state); err != nil {
		t.Fatalf("unmarshal patched JSON: %v", err)
	}
	for _, id := range []string{"ethereum-1", "ethereum-2"} {
		ps, ok := state.Posts[id]
		if !ok {
			t.Errorf("post %s missing from patched state", id)
			continue
		}
		if ps.ChainSlug != "ethereum" {
			t.Errorf("post %s: ChainSlug got %q, want %q", id, ps.ChainSlug, "ethereum")
		}
	}
}

func TestPatchJSON_DryRunReturnsOriginalJSON(t *testing.T) {
	raw := []byte(`{"lastSeenByChain":{},"posts":{"ethereum-1":{"messageId":14}}}`)

	results, patched, err := backfill.PatchJSON(raw, true /*dryRun*/)
	if err != nil {
		t.Fatalf("PatchJSON dry-run: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result in dry-run, got %d", len(results))
	}
	// Dry-run must return the exact original bytes.
	if string(patched) != string(raw) {
		t.Errorf("dry-run must return original JSON unchanged:\ngot:  %s\nwant: %s", patched, raw)
	}
}

func TestPatchJSON_IdempotentOnAlreadyPatched(t *testing.T) {
	// State already has chainSlug — re-running must produce 0 results.
	raw := []byte(`{"lastSeenByChain":{},"posts":{"ethereum-1":{"messageId":14,"chainSlug":"ethereum"}}}`)

	results, _, err := backfill.PatchJSON(raw, false)
	if err != nil {
		t.Fatalf("PatchJSON on already-patched: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for already-patched state, got %d", len(results))
	}
}
