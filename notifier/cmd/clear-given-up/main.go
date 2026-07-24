// Binary clear-given-up clears the thatsRekt notifier's permanent give-up
// state for one post (issue #262 review, PR #265 blocker 2). See
// notifier/internal/giveup's package doc for the full operator runbook and
// why the notifier must be stopped first.
//
// The patched JSON is written to stdout; informational output goes to
// stderr. The operation is idempotent — running it twice on the same state
// file, or targeting a post with no give-up state, produces the same
// (no-op) result rather than an error.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/giveup"
)

func main() {
	filePath := flag.String("file", "", "Path to state.json (required)")
	postID := flag.String("post-id", "", "Composite post ID to clear, e.g. ethereum-38 (required)")
	dryRun := flag.Bool("dry-run", false, "Print what would be cleared without writing output")
	flag.Parse()

	if *filePath == "" {
		fmt.Fprintln(os.Stderr, "error: --file is required")
		flag.Usage()
		os.Exit(1)
	}
	if *postID == "" {
		fmt.Fprintln(os.Stderr, "error: --post-id is required")
		flag.Usage()
		os.Exit(1)
	}

	raw, err := os.ReadFile(*filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: read %s: %v\n", *filePath, err)
		os.Exit(1)
	}

	res, patched, err := giveup.ClearJSON(raw, *postID, *dryRun)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	verb := "cleared"
	if *dryRun {
		verb = "would clear"
	}
	if !res.ClearedGivenUp && res.PreviousAttempts == 0 {
		fmt.Fprintf(os.Stderr, "nothing to clear for post_id=%s — no give-up flag and no failed-attempt counter recorded\n", *postID)
	} else {
		fmt.Fprintf(os.Stderr, "%s post_id=%-15s  given_up=%-5v  previous_attempts=%d\n",
			verb, res.PostID, res.ClearedGivenUp, res.PreviousAttempts)
	}

	if *dryRun {
		fmt.Fprintln(os.Stderr, "dry-run: no output written")
		return
	}

	if _, err := os.Stdout.Write(patched); err != nil {
		fmt.Fprintf(os.Stderr, "error: write output: %v\n", err)
		os.Exit(1)
	}
	fmt.Println() // trailing newline
}
