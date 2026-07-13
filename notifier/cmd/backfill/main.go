// Binary backfill patches orphaned pre-N3 entries in the thatsRekt notifier
// state file (state.json). An orphaned entry has an empty chainSlug field,
// causing StoredPosts() to skip it — the post can never be retracted.
//
// # CRITICAL SAFETY REQUIREMENT: STOP THE NOTIFIER BEFORE PATCHING STATE
//
// Store.Save() rewrites the ENTIRE state document from its in-memory copy
// every 15 seconds when dirty — no merge, no ETag check, no read-modify-write.
// If you upload a patched state.json while the notifier is still running:
//   - The notifier never re-reads S3 (Load runs once, at startup).
//   - The next dirty flush (within 15 s) overwrites the S3 object with the
//     notifier's unpatched in-memory state.
//   - The backfill tool printed "patched 6 entries" so we believe it worked.
//   - Result: TG messages 14/18/23/24/25/27 (Maple Finance, Aave, MapProtocol)
//     stay live in the public channel while we believe they are retracted.
//     That is the worst possible outcome: the harm persists AND we stop looking.
//
// # Correct runbook (all steps are mandatory)
//
//	# STEP 0 — STOP THE NOTIFIER. Do NOT skip or reorder this step.
//	aws ecs update-service \
//	  --cluster <CLUSTER> --service <SERVICE> \
//	  --desired-count 0 --profile admin
//	# Wait until the task has actually stopped (not just "draining"):
//	aws ecs wait services-stable \
//	  --cluster <CLUSTER> --services <SERVICE> --profile admin
//
//	# STEP 1 — Download state AFTER the service is stopped.
//	aws s3 cp s3://damm-thatsrekt-notifier-state/state.json /tmp/state.json
//
//	# STEP 2 — Dry-run. Review the 6 entries printed to stderr.
//	go run ./cmd/backfill --dry-run --file /tmp/state.json
//
//	# STEP 3 — Patch and review the diff.
//	go run ./cmd/backfill --file /tmp/state.json > /tmp/state-patched.json
//	diff /tmp/state.json /tmp/state-patched.json
//
//	# STEP 4 — Upload the patch.
//	aws s3 cp /tmp/state-patched.json s3://damm-thatsrekt-notifier-state/state.json
//
//	# STEP 5 — Deploy the new notifier image (with the bsc/polygon fix).
//	aws ecs update-service \
//	  --cluster <CLUSTER> --service <SERVICE> \
//	  --force-new-deployment --profile admin
//
//	# STEP 6 — Scale back to 1.
//	aws ecs update-service \
//	  --cluster <CLUSTER> --service <SERVICE> \
//	  --desired-count 1 --profile admin
//
//	# STEP 7 — Verify. Confirm TG messages 14/18/23/24/25/27 show RETRACTED.
//
// # Follow-up recommendation
//
// Store.Save should use a conditional PUT with If-Match on the S3 ETag so an
// external writer racing a flush produces a 412 (Precondition Failed) rather
// than a silent clobber. This is a broader store refactor (Load would need to
// record the ETag; Save would pass it). File as a follow-up issue — the stop-
// first runbook is the correct mitigation for this backfill. The ETag guard is
// the structural fix that makes this class of race impossible in the future.
//
// The patched JSON is written to stdout; informational output goes to stderr.
// The operation is idempotent — running it twice on the same state file produces
// the same output (entries that already have chainSlug are skipped).
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/backfill"
)

func main() {
	filePath := flag.String("file", "", "Path to state.json (required)")
	dryRun := flag.Bool("dry-run", false, "Print what would be patched without writing output")
	flag.Parse()

	if *filePath == "" {
		fmt.Fprintln(os.Stderr, "error: --file is required")
		flag.Usage()
		os.Exit(1)
	}

	raw, err := os.ReadFile(*filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: read %s: %v\n", *filePath, err)
		os.Exit(1)
	}

	results, patched, err := backfill.PatchJSON(raw, *dryRun)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	// Sort for deterministic output.
	sort.Slice(results, func(i, j int) bool {
		return results[i].PostID < results[j].PostID
	})

	if *dryRun {
		fmt.Fprintf(os.Stderr, "dry-run: %d entries would be patched:\n", len(results))
		for _, r := range results {
			fmt.Fprintf(os.Stderr, "  post_id=%-15s  message_id=%-5d  chainSlug: \"\" → %q\n",
				r.PostID, r.MessageID, r.NewSlug)
		}
		fmt.Fprintln(os.Stderr, "dry-run: no output written")
		return
	}

	if len(results) == 0 {
		fmt.Fprintln(os.Stderr, "nothing to patch — all entries already have chainSlug set")
	} else {
		fmt.Fprintf(os.Stderr, "patched %d entries:\n", len(results))
		for _, r := range results {
			fmt.Fprintf(os.Stderr, "  post_id=%-15s  message_id=%-5d  chainSlug: \"\" → %q\n",
				r.PostID, r.MessageID, r.NewSlug)
		}
	}

	// Write patched JSON to stdout. The operator redirects this to a file.
	_, err = os.Stdout.Write(patched)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: write output: %v\n", err)
		os.Exit(1)
	}
	fmt.Println() // trailing newline
}
