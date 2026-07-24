package giveup_test

import (
	"encoding/json"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/giveup"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
)

// ---- ClearState unit tests -------------------------------------------------

func TestClearState_ClearsGivenUpAndAttempts(t *testing.T) {
	state := &store.State{
		GivenUpPosts: map[string]string{
			"ethereum-38": "1@2026-07-16T10:00:00Z",
		},
		FailedPublishAttempts: map[string]store.PublishAttemptState{
			"ethereum-38": {Fingerprint: "1@2026-07-16T10:00:00Z", Attempts: 5},
		},
	}

	res, err := giveup.ClearState(state, "ethereum-38", false)
	if err != nil {
		t.Fatalf("ClearState: %v", err)
	}
	if !res.ClearedGivenUp {
		t.Errorf("expected ClearedGivenUp=true")
	}
	if res.PreviousAttempts != 5 {
		t.Errorf("expected PreviousAttempts=5, got %d", res.PreviousAttempts)
	}
	if _, stillGivenUp := state.GivenUpPosts["ethereum-38"]; stillGivenUp {
		t.Errorf("expected GivenUpPosts entry to be removed")
	}
	if _, stillFailing := state.FailedPublishAttempts["ethereum-38"]; stillFailing {
		t.Errorf("expected FailedPublishAttempts entry to be removed")
	}
}

// TestClearState_DryRunDoesNotMutate verifies dry-run reports what would
// change without touching state — mirrors backfill.PatchState's contract.
func TestClearState_DryRunDoesNotMutate(t *testing.T) {
	state := &store.State{
		GivenUpPosts: map[string]string{"ethereum-38": "1@2026-07-16T10:00:00Z"},
		FailedPublishAttempts: map[string]store.PublishAttemptState{
			"ethereum-38": {Fingerprint: "1@2026-07-16T10:00:00Z", Attempts: 5},
		},
	}

	res, err := giveup.ClearState(state, "ethereum-38", true)
	if err != nil {
		t.Fatalf("ClearState: %v", err)
	}
	if !res.ClearedGivenUp {
		t.Errorf("dry-run: expected ClearedGivenUp=true (reporting what WOULD change)")
	}
	if _, stillGivenUp := state.GivenUpPosts["ethereum-38"]; !stillGivenUp {
		t.Errorf("dry-run must not mutate state — GivenUpPosts entry was removed")
	}
	if _, stillFailing := state.FailedPublishAttempts["ethereum-38"]; !stillFailing {
		t.Errorf("dry-run must not mutate state — FailedPublishAttempts entry was removed")
	}
}

// TestClearState_IdempotentOnAlreadyClearPost verifies calling ClearState on
// a post with no give-up state at all is a safe, documented no-op — not an
// error. An operator re-running the tool, or targeting a post that already
// recovered, must not fail.
func TestClearState_IdempotentOnAlreadyClearPost(t *testing.T) {
	state := &store.State{
		GivenUpPosts:          map[string]string{},
		FailedPublishAttempts: map[string]store.PublishAttemptState{},
	}

	res, err := giveup.ClearState(state, "ethereum-99", false)
	if err != nil {
		t.Fatalf("ClearState on a never-given-up post must not error: %v", err)
	}
	if res.ClearedGivenUp {
		t.Errorf("expected ClearedGivenUp=false for a post with no give-up state")
	}
	if res.PreviousAttempts != 0 {
		t.Errorf("expected PreviousAttempts=0, got %d", res.PreviousAttempts)
	}

	// Calling it AGAIN must produce the identical result (idempotent).
	res2, err := giveup.ClearState(state, "ethereum-99", false)
	if err != nil {
		t.Fatalf("second ClearState call must not error: %v", err)
	}
	if res2 != res {
		t.Errorf("expected idempotent result on repeat call: got %+v, want %+v", res2, res)
	}
}

// TestClearState_OnlyGivenUpNoFailedAttempts covers the case where the
// give-up flag is set but the FailedPublishAttempts entry was already
// separately cleared (defensive — should not happen in practice, but the
// tool must not panic or error).
func TestClearState_OnlyGivenUpNoFailedAttempts(t *testing.T) {
	state := &store.State{
		GivenUpPosts:          map[string]string{"ethereum-38": "1@2026-07-16T10:00:00Z"},
		FailedPublishAttempts: map[string]store.PublishAttemptState{},
	}
	res, err := giveup.ClearState(state, "ethereum-38", false)
	if err != nil {
		t.Fatalf("ClearState: %v", err)
	}
	if !res.ClearedGivenUp {
		t.Errorf("expected ClearedGivenUp=true")
	}
	if res.PreviousAttempts != 0 {
		t.Errorf("expected PreviousAttempts=0 (no FailedPublishAttempts entry), got %d", res.PreviousAttempts)
	}
}

func TestClearState_NilStateErrors(t *testing.T) {
	if _, err := giveup.ClearState(nil, "ethereum-38", false); err == nil {
		t.Fatal("expected error for nil state")
	}
}

func TestClearState_EmptyPostIDErrors(t *testing.T) {
	state := &store.State{GivenUpPosts: map[string]string{}, FailedPublishAttempts: map[string]store.PublishAttemptState{}}
	if _, err := giveup.ClearState(state, "", false); err == nil {
		t.Fatal("expected error for empty postID")
	}
}

// ---- ClearJSON round-trip tests --------------------------------------------

func TestClearJSON_ClearsAndReserializes(t *testing.T) {
	raw := []byte(`{
		"lastSeenByChain": {"ethereum": "ethereum-40"},
		"posts": {},
		"failedPublishAttempts": {
			"ethereum-38": {"fingerprint": "1@2026-07-16T10:00:00Z", "attempts": 5}
		},
		"givenUpPosts": {
			"ethereum-38": "1@2026-07-16T10:00:00Z"
		}
	}`)

	res, patched, err := giveup.ClearJSON(raw, "ethereum-38", false)
	if err != nil {
		t.Fatalf("ClearJSON: %v", err)
	}
	if !res.ClearedGivenUp {
		t.Errorf("expected ClearedGivenUp=true")
	}

	var state store.State
	if err := json.Unmarshal(patched, &state); err != nil {
		t.Fatalf("patched JSON must unmarshal into store.State: %v", err)
	}
	if _, ok := state.GivenUpPosts["ethereum-38"]; ok {
		t.Errorf("patched JSON must not contain the cleared GivenUpPosts entry")
	}
	if _, ok := state.FailedPublishAttempts["ethereum-38"]; ok {
		t.Errorf("patched JSON must not contain the cleared FailedPublishAttempts entry")
	}
	// Unrelated state must survive the round-trip untouched.
	if state.LastSeenByChain["ethereum"] != "ethereum-40" {
		t.Errorf("expected lastSeenByChain to survive untouched, got %q", state.LastSeenByChain["ethereum"])
	}
}

func TestClearJSON_DryRunReturnsOriginalBytes(t *testing.T) {
	raw := []byte(`{"givenUpPosts": {"ethereum-38": "1@2026-07-16T10:00:00Z"}, "failedPublishAttempts": {}}`)

	_, patched, err := giveup.ClearJSON(raw, "ethereum-38", true)
	if err != nil {
		t.Fatalf("ClearJSON dry-run: %v", err)
	}
	if string(patched) != string(raw) {
		t.Errorf("dry-run must return the input bytes unmodified\ngot:  %s\nwant: %s", patched, raw)
	}
}

func TestClearJSON_MalformedInputErrors(t *testing.T) {
	if _, _, err := giveup.ClearJSON([]byte(`not json`), "ethereum-38", false); err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}
