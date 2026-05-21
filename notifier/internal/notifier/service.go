// Package notifier — the long-running pump.
//
// Two goroutines, one event loop:
//
//   1. Poll loop: every PollInterval, fetch the latest N posts from the
//      Mesh GraphQL endpoint. Filter for ones strictly newer than the
//      per-chain high-water mark. For each, post to Telegram with vote
//      buttons; record the message id + initial counts in state.
//
//   2. Callback loop: long-poll Telegram getUpdates. Each callback_query
//      is a button press — apply the vote via the store, edit the message
//      to refresh the counts, ack the press.
//
// Both write through the same Store. State is flushed to S3 on a debounced
// timer so we don't hit S3 on every press.
package notifier

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

type Service struct {
	GQL          *graphql.Client
	Bot          *telegram.Bot
	Store        *store.Store
	ChannelID    string
	SiteURL      string
	PollInterval time.Duration
	FetchLimit   int
	Logger       *slog.Logger
}

// Run blocks until ctx is cancelled. Returns the first non-recoverable error.
func (s *Service) Run(ctx context.Context) error {
	// Periodic flush — keeps S3 writes batched. We also flush
	// best-effort on a clean shutdown via the defer below.
	flushTicker := time.NewTicker(15 * time.Second)
	defer flushTicker.Stop()

	pollTicker := time.NewTicker(s.PollInterval)
	defer pollTicker.Stop()

	// Run an initial poll so the first new post on startup doesn't wait
	// a full PollInterval. The seed-from-empty case is harmless because
	// LastSeen returns "" for unknown chains, and the first cycle
	// records the latest id without spamming.
	go s.runPoll(ctx)

	// Callback loop has its own goroutine + retry-with-backoff because a
	// long-poll error shouldn't take the poll loop down.
	go s.runCallbacks(ctx)

	for {
		select {
		case <-ctx.Done():
			// Best-effort flush on shutdown — give it 5s.
			fctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := s.Store.Save(fctx); err != nil {
				s.Logger.Warn("final state flush failed", "err", err)
			}
			return ctx.Err()

		case <-pollTicker.C:
			s.pollOnce(ctx)

		case <-flushTicker.C:
			if err := s.Store.Save(ctx); err != nil {
				s.Logger.Warn("periodic flush failed", "err", err)
			}
		}
	}
}

// runPoll is the initial poll fired at startup; subsequent polls come from
// the main loop's ticker.
func (s *Service) runPoll(ctx context.Context) {
	// Brief sleep so AWS clients have time to initialise. Not strictly
	// needed but keeps logs cleaner on cold-start.
	select {
	case <-time.After(500 * time.Millisecond):
	case <-ctx.Done():
		return
	}
	s.pollOnce(ctx)
}

func (s *Service) pollOnce(ctx context.Context) {
	posts, err := s.GQL.LatestPosts(ctx, s.FetchLimit)
	if err != nil {
		s.Logger.Warn("graphql poll failed", "err", err)
		return
	}

	// GraphQL returns DESC. We want to post in ASCENDING order so the
	// channel reads chronologically (oldest-new first, latest-new last).
	sort.Slice(posts, func(i, j int) bool {
		return posts[i].CreatedAtTimestamp < posts[j].CreatedAtTimestamp
	})

	for _, p := range posts {
		if !s.isNew(p) {
			continue
		}
		if err := s.publish(ctx, p); err != nil {
			s.Logger.Warn("publish failed", "post_id", p.ID, "err", err)
			// Don't bump LastSeen — try again next cycle. (The wagmi
			// gateway is occasionally flaky; nginx rate limit also
			// possible.)
			continue
		}
		s.Store.SetLastSeen(p.Chain.Slug, p.ID)
	}
}

// isNew is the dedup check. We use LEXICOGRAPHIC > because all current ids
// are `{chainSlug}-{base10-int}` and per-chain ids are monotonically
// increasing — within a chain, lex compare matches numeric compare for
// uniformly-padded ints. Per-chain comparison guards against cross-chain
// id collisions.
func (s *Service) isNew(p graphql.Post) bool {
	last := s.Store.LastSeen(p.Chain.Slug)
	if last == "" {
		return true
	}
	// Compare via the on-chain id portion only (the part after the last
	// "-") so prefix differences in chain slugs can't whipsaw us. We
	// fall back to whole-id compare if the format is unexpected.
	return onchainPart(p.ID) > onchainPart(last)
}

func onchainPart(id string) string {
	idx := strings.LastIndex(id, "-")
	if idx < 0 || idx == len(id)-1 {
		return id
	}
	return id[idx+1:]
}

// publish sends one post to Telegram + records its message id + initial
// (zero) vote counts.
func (s *Service) publish(ctx context.Context, p graphql.Post) error {
	text := telegram.FormatPostMessage(p)
	kb := telegram.VoteKeyboard(p.ID, 0, 0)
	msgID, err := s.Bot.SendMessage(ctx, s.ChannelID, text, kb)
	if err != nil {
		return fmt.Errorf("send message: %w", err)
	}
	s.Store.RegisterPost(p.ID, msgID)
	s.Logger.Info("published",
		"post_id", p.ID,
		"chain", p.Chain.Slug,
		"message_id", msgID,
		"title", p.Title,
	)
	return nil
}

// runCallbacks is the second goroutine — long-polls Telegram for button
// presses and applies them. Restarts on transient errors with a small
// backoff so a network blip doesn't take the loop down.
func (s *Service) runCallbacks(ctx context.Context) {
	var offset int64
	backoff := time.Second

	for {
		if ctx.Err() != nil {
			return
		}
		updates, err := s.Bot.GetUpdates(ctx, offset, 30*time.Second)
		if err != nil {
			s.Logger.Warn("getUpdates failed; backing off", "err", err, "backoff", backoff)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			if backoff < 60*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second // reset on success

		for _, u := range updates {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			if u.CallbackQuery != nil {
				s.handleCallback(ctx, *u.CallbackQuery)
			}
		}
	}
}

// handleCallback processes one button press: increment / toggle / switch
// the cosmetic vote, refresh the message keyboard, ack the press.
func (s *Service) handleCallback(ctx context.Context, cq telegram.CallbackQuery) {
	// callback_data shape: "vote:{up|down}:{postId}"
	parts := strings.SplitN(cq.Data, ":", 3)
	if len(parts) != 3 || parts[0] != "vote" {
		// Unknown payload; just ack so the user's spinner clears.
		_ = s.Bot.AnswerCallback(ctx, cq.ID, "")
		return
	}
	direction := parts[1]
	postID := parts[2]

	tgUserID := fmt.Sprintf("%d", cq.From.ID)
	up, down, changed := s.Store.ApplyVote(postID, tgUserID, direction)
	if !changed {
		_ = s.Bot.AnswerCallback(ctx, cq.ID, "")
		return
	}

	kb := telegram.VoteKeyboard(postID, up, down)
	if err := s.Bot.EditReplyMarkup(ctx, s.ChannelID, cq.Message.MessageID, kb); err != nil {
		s.Logger.Warn("edit reply markup failed", "post_id", postID, "err", err)
		// Still ack — the user got their vote counted in state, the
		// next vote will pull the message back into sync.
	}

	// Brief toast acknowledgement.
	var toast string
	switch direction {
	case "up":
		toast = "vouched ✓"
	case "down":
		toast = "refuted ✗"
	}
	_ = s.Bot.AnswerCallback(ctx, cq.ID, toast)
}
