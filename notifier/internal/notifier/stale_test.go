package notifier_test

// State 5 republish guard. A post that is not new (id ≤ high-water mark) and
// absent from the store is published fresh (issue #128 AC4). Posts created
// before the notifier's state began are absent too, and they enter the latest
// `FETCH_LIMIT` window whenever the feed shifts: a recent post is retracted or
// purged, or one chain's results briefly drop out of the unified feed. Each
// time, the community channel got months-old alerts. MaxRepublishAge bounds
// State 5 to recent posts; older ones are recorded as seen without a send.

import (
	"context"
	"testing"
	"time"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
)

var staleNow = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

func sendsOf(bot *stubBot) int {
	bot.mu.Lock()
	defer bot.mu.Unlock()
	return len(bot.sends)
}

func TestStaleGuard_OldUnpublishedPostIsNotRepublished(t *testing.T) {
	st := makeEthState38()
	bot := &stubBot{}
	post := makeEthPost("ethereum-38")
	post.CreatedAtTimestamp = "2026-05-01T00:00:00.000000Z" // months before staleNow
	svc := makeSvcForPoisonPill(t, st, bot, []graphql.Post{post})
	svc.MaxRepublishAge = 24 * time.Hour
	svc.Now = func() time.Time { return staleNow }

	svc.PollOnce(context.Background())
	svc.PollOnce(context.Background())

	if n := sendsOf(bot); n != 0 {
		t.Fatalf("an old post absent from the store was republished: %d sends", n)
	}
}

func TestStaleGuard_RecentUnpublishedPostIsStillPublished(t *testing.T) {
	st := makeEthState38()
	bot := &stubBot{}
	post := makeEthPost("ethereum-38")
	post.CreatedAtTimestamp = staleNow.Add(-2 * time.Hour).Format(time.RFC3339Nano)
	svc := makeSvcForPoisonPill(t, st, bot, []graphql.Post{post})
	svc.MaxRepublishAge = 24 * time.Hour
	svc.Now = func() time.Time { return staleNow }

	svc.PollOnce(context.Background())

	if n := sendsOf(bot); n != 1 {
		t.Fatalf("a recent post absent from the store must still be published (issue #128 AC4), got %d sends", n)
	}
}

func TestStaleGuard_DisabledByZeroKeepsOldBehaviour(t *testing.T) {
	st := makeEthState38()
	bot := &stubBot{}
	post := makeEthPost("ethereum-38")
	post.CreatedAtTimestamp = "2026-05-01T00:00:00Z"
	svc := makeSvcForPoisonPill(t, st, bot, []graphql.Post{post})
	svc.Now = func() time.Time { return staleNow }

	svc.PollOnce(context.Background())

	if n := sendsOf(bot); n != 1 {
		t.Fatalf("MaxRepublishAge 0 must keep the State 5 fallback, got %d sends", n)
	}
}

func TestStaleGuard_UnparseableTimestampFailsOpen(t *testing.T) {
	st := makeEthState38()
	bot := &stubBot{}
	post := makeEthPost("ethereum-38")
	post.CreatedAtTimestamp = "not a time"
	svc := makeSvcForPoisonPill(t, st, bot, []graphql.Post{post})
	svc.MaxRepublishAge = 24 * time.Hour
	svc.Now = func() time.Time { return staleNow }

	svc.PollOnce(context.Background())

	if n := sendsOf(bot); n != 1 {
		t.Fatalf("an unreadable timestamp must not hide an alert, got %d sends", n)
	}
}

func TestStaleGuard_BrandNewPostsAreNeverGated(t *testing.T) {
	st := makeEthState38()
	bot := &stubBot{}
	// Above the high-water mark (State 1) but with an old createdAt: a chain
	// whose high-water mark is behind still publishes it.
	post := makeEthPost("ethereum-40")
	post.CreatedAtTimestamp = "2026-05-01T00:00:00Z"
	svc := makeSvcForPoisonPill(t, st, bot, []graphql.Post{post})
	svc.MaxRepublishAge = 24 * time.Hour
	svc.Now = func() time.Time { return staleNow }

	svc.PollOnce(context.Background())

	if n := sendsOf(bot); n != 1 {
		t.Fatalf("State 1 must not be gated by age, got %d sends", n)
	}
}

func TestStaleGuard_EmptyStateSeedsWithoutSpamming(t *testing.T) {
	// Lost or fresh S3 state: no high-water mark for the chain, so every post
	// in the window is "new". Old ones seed the mark without a send; a recent
	// one still goes out.
	st := makeEthState38()
	st.SetLastSeen("ethereum", "")
	bot := &stubBot{}
	old := makeEthPost("ethereum-37")
	old.CreatedAtTimestamp = "2026-05-01T00:00:00Z"
	recent := makeEthPost("ethereum-41")
	recent.CreatedAtTimestamp = staleNow.Add(-time.Hour).Format(time.RFC3339)
	svc := makeSvcForPoisonPill(t, st, bot, []graphql.Post{recent, old})
	svc.MaxRepublishAge = 24 * time.Hour
	svc.Now = func() time.Time { return staleNow }

	svc.PollOnce(context.Background())
	svc.PollOnce(context.Background())

	if n := sendsOf(bot); n != 1 {
		t.Fatalf("expected only the recent post to be sent, got %d sends", n)
	}
	if got := st.LastSeen("ethereum"); got != "ethereum-41" {
		t.Fatalf("high-water mark = %q, want ethereum-41", got)
	}
}
