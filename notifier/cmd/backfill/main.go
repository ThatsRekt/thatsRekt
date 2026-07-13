// Binary backfill patches orphaned pre-N3 entries in the thatsRekt notifier
// state file (state.json). An orphaned entry has an empty chainSlug field,
// causing StoredPosts() to skip it — the post can never be retracted.
//
// Usage (from the notifier/ directory):
//
//	# 1. Download the live state file:
//	aws s3 cp s3://damm-thatsrekt-notifier-state/state.json /tmp/state.json
//
//	# 2. Dry-run — prints what would be patched, no output written:
//	go run ./cmd/backfill --dry-run --file /tmp/state.json
//
//	# 3. Patch and capture the output:
//	go run ./cmd/backfill --file /tmp/state.json > /tmp/state-patched.json
//
//	# 4. Sanity-check the diff, then upload:
//	diff /tmp/state.json /tmp/state-patched.json
//	aws s3 cp /tmp/state-patched.json s3://damm-thatsrekt-notifier-state/state.json
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
