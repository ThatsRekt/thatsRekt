// Package giveup provides an idempotent operator tool for clearing the
// notifier's permanent-give-up state for a specific post (issue #262 review,
// PR #265 blocker 2).
//
// Why this exists despite give-up being self-healing: give-up is scoped to a
// fingerprint of the on-chain content (see notifier.contentFingerprint). If
// the content changes — an amendment, or a notifier deploy that changes
// rendering — the next poll computes a different fingerprint and retries
// automatically; no operator action needed. This tool is for the OTHER
// case: the content is fine, but publishing keeps failing for a reason
// unrelated to content (e.g. the bot lost admin rights in the channel, or
// was temporarily removed). Once that external condition is fixed, use this
// tool to clear the give-up flag and the failed-attempt counter so the next
// poll retries with a fresh budget — without hand-editing state.json.
//
// # CRITICAL SAFETY REQUIREMENT: STOP THE NOTIFIER BEFORE PATCHING STATE
//
// Same reasoning as cmd/backfill (see its package doc): Store.Save()
// rewrites the ENTIRE state document from its in-memory copy every 15
// seconds when dirty. If the notifier is still running when you upload a
// patched state.json, the next flush silently clobbers your edit and you
// believe the give-up flag is cleared when it is not.
//
// # Operator workflow (run from notifier/)
//
//	# STEP 0 — STOP THE NOTIFIER.
//	aws ecs update-service \
//	  --cluster <CLUSTER> --service <SERVICE> \
//	  --desired-count 0 --profile admin
//	aws ecs wait services-stable \
//	  --cluster <CLUSTER> --services <SERVICE> --profile admin
//
//	# STEP 1 — Download state AFTER the service is stopped.
//	aws s3 cp s3://damm-thatsrekt-notifier-state/state.json /tmp/state.json
//
//	# STEP 2 — Dry-run. Review what would be cleared.
//	go run ./cmd/clear-given-up --dry-run --file /tmp/state.json --post-id ethereum-38
//
//	# STEP 3 — Clear and review the diff.
//	go run ./cmd/clear-given-up --file /tmp/state.json --post-id ethereum-38 > /tmp/state-patched.json
//	diff /tmp/state.json /tmp/state-patched.json
//
//	# STEP 4 — Upload the patch.
//	aws s3 cp /tmp/state-patched.json s3://damm-thatsrekt-notifier-state/state.json
//
//	# STEP 5 — Restart the notifier.
//	aws ecs update-service \
//	  --cluster <CLUSTER> --service <SERVICE> \
//	  --desired-count 1 --profile admin
package giveup

import (
	"encoding/json"
	"fmt"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
)

// Result describes what was (or, in dry-run mode, would be) cleared for one
// post.
type Result struct {
	PostID           string
	ClearedGivenUp   bool
	PreviousAttempts int
}

// ClearState clears the give-up flag and the failed-attempt counter for
// postID in state. Idempotent: calling it on a post with no give-up state
// and no failed attempts is a documented no-op (Result.ClearedGivenUp=false,
// PreviousAttempts=0) rather than an error — an operator re-running the
// tool, or targeting a post id that already recovered on its own, must not
// fail.
//
// When dryRun is true, Result reports what WOULD be cleared but state is
// left unmodified.
func ClearState(state *store.State, postID string, dryRun bool) (Result, error) {
	if state == nil {
		return Result{}, fmt.Errorf("giveup: state is nil")
	}
	if postID == "" {
		return Result{}, fmt.Errorf("giveup: postID is required")
	}

	res := Result{PostID: postID}

	if _, wasGivenUp := state.GivenUpPosts[postID]; wasGivenUp {
		res.ClearedGivenUp = true
		if !dryRun {
			delete(state.GivenUpPosts, postID)
		}
	}
	if attempt, hadAttempts := state.FailedPublishAttempts[postID]; hadAttempts {
		res.PreviousAttempts = attempt.Attempts
		if !dryRun {
			delete(state.FailedPublishAttempts, postID)
		}
	}

	return res, nil
}

// ClearJSON parses a state.json document, clears postID's give-up state, and
// returns the Result plus the (optionally) patched JSON. Mirrors
// backfill.PatchJSON's dry-run contract: dry-run returns the ORIGINAL bytes
// unmodified, non-dry-run returns the re-marshalled, patched document.
func ClearJSON(raw []byte, postID string, dryRun bool) (Result, []byte, error) {
	var state store.State
	if err := json.Unmarshal(raw, &state); err != nil {
		return Result{}, nil, fmt.Errorf("giveup: unmarshal state: %w", err)
	}
	if state.GivenUpPosts == nil {
		state.GivenUpPosts = map[string]string{}
	}
	if state.FailedPublishAttempts == nil {
		state.FailedPublishAttempts = map[string]store.PublishAttemptState{}
	}

	res, err := ClearState(&state, postID, dryRun)
	if err != nil {
		return Result{}, nil, err
	}
	if dryRun {
		return res, raw, nil
	}

	out, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return Result{}, nil, fmt.Errorf("giveup: marshal patched state: %w", err)
	}
	return res, out, nil
}
