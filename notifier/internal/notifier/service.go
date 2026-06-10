// Package notifier — the long-running pump.
//
// One goroutine, one event loop:
//
//  1. Poll loop: every PollInterval, fetch the latest N posts from the
//     Mesh GraphQL endpoint.
//     - Posts strictly newer than the per-chain high-water mark → publish.
//     - Posts already published that have changed (new ActionCount /
//     LastUpdatedAt) → edit in place via the stored tg_message_id.
//     - Posts already published and unchanged → skip.
//
// State is flushed to S3 on a debounced timer so we don't hit S3 on every
// poll.
package notifier

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// GQLClient is the subset of graphql.Client used by the Service. Declared as
// an interface so the service can be tested without a real HTTP connection.
type GQLClient interface {
	LatestPosts(ctx context.Context, limit int) ([]graphql.Post, error)

	// PostById calls the per-chain <Prefix>_postById query on the Mesh
	// gateway to read the current removed flag for a stored post. This is
	// the only data path that surfaces removed=true: the unified posts feed
	// filters retracted posts out server-side (removed_eq: false).
	// Returns nil, nil when the post id is not found on the chain's squid.
	PostById(ctx context.Context, chainSlug, onchainID string) (*graphql.PostByIdResult, error)
}

// TelegramBot is the subset of telegram.Bot used by the Service. Declared as
// an interface so the service can be tested with a stub implementation.
type TelegramBot interface {
	SendMessage(ctx context.Context, chatID, text string, kb *telegram.InlineKeyboardMarkup) (int64, error)
	EditMessageText(ctx context.Context, chatID string, messageID int64, text string, kb *telegram.InlineKeyboardMarkup) error
}

type Service struct {
	GQL          GQLClient
	Bot          TelegramBot
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
			s.PollOnce(ctx)

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
	s.PollOnce(ctx)
}

// PollOnce fetches the latest posts and routes each one through the full
// post lifecycle. Every state is handled explicitly — no post is silently
// dropped:
//
//  1. New (id > last-seen high-water mark) → publish fresh.
//  2. Mapped (in Posts map) + no snapshot yet (pre-N2 post with zero-value
//     LastActionCount/LastUpdatedAt) → back-fill the baseline snapshot using
//     the current on-chain values; do NOT edit the Telegram message.
//     The next poll that detects a real change will then edit correctly.
//  3. Mapped + snapshot exists + unchanged → skip.
//  4. Mapped + snapshot exists + changed → edit the existing Telegram message
//     in place (amendment handling).
//  5. Not new + not in Posts map (notifier never published it) →
//     fall back to a fresh publish.
//
// After the feed loop, a separate retract-detection pass (checkRetracts) calls
// the per-chain <Prefix>_postById query for each stored, non-retracted post to
// detect the removed flag. The unified posts feed never surfaces removed=true
// because the Mesh gateway filters retracted posts out (removed_eq: false in
// the upstream squid query). Per-chain postById deliberately exposes removed=true
// so retract state is observable.
//
// PollOnce is exported so service_test.go can drive it directly.
func (s *Service) PollOnce(ctx context.Context) {
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
		// --- State 1: brand-new post ---
		if s.isNew(p) {
			if err := s.publish(ctx, p); err != nil {
				s.Logger.Warn("publish failed", "post_id", p.ID, "err", err)
				// Don't bump LastSeen — try again next cycle.
				continue
			}
			s.Store.SetLastSeen(p.Chain.Slug, p.ID)
			continue
		}

		// Post is not new (id ≤ last-seen high-water mark). Look up the
		// stored Telegram message id to determine which sub-state we're in.
		msgID, known := s.Store.MessageIDFor(p.ID)
		if !known {
			// --- State 5: not-new + not mapped ---
			// The notifier never published this post. Fall back to a fresh
			// publish (acceptance criterion 4 of issue #128).
			s.Logger.Info("not-new post absent from store — publishing fresh",
				"post_id", p.ID,
				"action_count", p.ActionCount,
			)
			if err := s.publish(ctx, p); err != nil {
				s.Logger.Warn("fallback publish failed", "post_id", p.ID, "err", err)
			}
			continue
		}

		// Back-fill ChainSlug for posts published before N3 deployed.
		// Every pre-N3 post has ChainSlug=="" in the store because RegisterPost
		// did not gain the chainSlug parameter until N3. Without a ChainSlug,
		// StoredPosts() skips the post and checkRetracts can never probe it.
		//
		// The unified posts feed carries p.Chain.Slug for every non-retracted
		// post. We use it here to populate the missing slug. The operation is
		// idempotent: subsequent polls that find ChainSlug already set are
		// no-ops (SetChainSlug writes the same value again, which is harmless).
		if ps, ok := s.Store.PostState(p.ID); ok && ps.ChainSlug == "" {
			s.Store.SetChainSlug(p.ID, p.Chain.Slug)
			s.Logger.Info("back-filled ChainSlug for pre-N3 post",
				"post_id", p.ID,
				"chain", p.Chain.Slug,
			)
		}

		// Post is mapped. Differentiate by snapshot state.
		if !s.Store.HasSnapshot(p.ID) {
			// --- State 2: mapped + no snapshot (pre-N2 post) ---
			// Back-fill the baseline with the current on-chain values so the
			// next genuine amendment is detected. Do NOT edit the message.
			s.Store.UpdatePostSnapshot(p.ID, p.ActionCount, p.LastUpdatedAt)
			s.Logger.Info("back-filled snapshot for pre-N2 post",
				"post_id", p.ID,
				"action_count", p.ActionCount,
				"last_updated_at", p.LastUpdatedAt,
			)
			continue
		}

		// --- State 3: mapped + snapshot + unchanged ---
		if !s.Store.HasChanged(p.ID, p.ActionCount, p.LastUpdatedAt) {
			continue
		}

		// --- State 4: mapped + snapshot + changed → edit in place ---
		if err := s.amendEdit(ctx, p, msgID); err != nil {
			s.Logger.Warn("amendment edit failed", "post_id", p.ID, "err", err)
			// Don't update snapshot — next poll will retry.
			continue
		}
	}

	// Retract-detection pass: for each stored, non-retracted post, query
	// the per-chain postById endpoint to check whether it has been retracted.
	// This runs after every feed poll so retract latency = poll interval.
	s.checkRetracts(ctx)
}

// checkRetracts iterates all stored, non-retracted posts and calls the
// per-chain <Prefix>_postById query for each. When a post has been retracted
// on-chain (removed=true), the existing Telegram message is edited to the
// RETRACTED state.
//
// Design rationale: the unified posts(...) feed permanently excludes retracted
// posts (removed_eq: false in the upstream Mesh query, a deliberate product
// decision from 2026-05-13). Per-chain postById exposes removed=true — this
// is the gateway's intended path for surfacing retract state to callers that
// need it (see mesh/src/server.ts, lines around the removed field comment).
//
// The pass is O(n) in the number of stored posts with one HTTP round-trip per
// post. At thatsRekt's scale (tens to low-hundreds of posts lifetime) this is
// cheap. Posts already marked retracted are excluded by StoredPosts() so the
// set shrinks monotonically over time.
func (s *Service) checkRetracts(ctx context.Context) {
	entries := s.Store.StoredPosts()
	for _, e := range entries {
		// Derive the bare on-chain id from the composite post id.
		// Composite format: "{chainSlug}-{onchainID}" (e.g. "base-42").
		onchainID := onchainPart(e.PostID)
		if onchainID == e.PostID {
			// ID did not contain a separator — unexpected format; skip.
			s.Logger.Warn("checkRetracts: unexpected post id format — skipping",
				"post_id", e.PostID,
			)
			continue
		}

		result, err := s.GQL.PostById(ctx, e.ChainSlug, onchainID)
		if err != nil {
			s.Logger.Warn("checkRetracts: postById failed",
				"post_id", e.PostID,
				"chain", e.ChainSlug,
				"err", err,
			)
			continue
		}
		if result == nil {
			// Post not found on the chain's squid — index lag or wrong id.
			s.Logger.Warn("checkRetracts: postById returned null",
				"post_id", e.PostID,
				"chain", e.ChainSlug,
			)
			continue
		}
		if !result.Removed {
			continue
		}

		// Post is retracted on-chain. Edit the Telegram message.
		if err := s.retractEdit(ctx, result, e.PostID, e.MessageID); err != nil {
			s.Logger.Warn("checkRetracts: retract edit failed",
				"post_id", e.PostID,
				"chain", e.ChainSlug,
				"err", err,
			)
			// Do NOT mark retracted — retry on next poll.
		}
	}
}

// isNew is the dedup check. Post ids are `{chainSlug}-{base10-int}` and are
// NOT zero-padded, so lexicographic comparison breaks at the single→double
// digit boundary ("10" < "9" lexicographically). We compare the on-chain id
// portion numerically. If either side is not a valid base-10 int (unexpected
// format or future schema change) we fall back to string compare so the guard
// never panics and existing behaviour for non-numeric ids is preserved.
// Per-chain last-seen lookup guards against cross-chain id collisions.
func (s *Service) isNew(p graphql.Post) bool {
	last := s.Store.LastSeen(p.Chain.Slug)
	if last == "" {
		return true
	}
	// Compare via the on-chain id portion only (the part after the last
	// "-") so prefix differences in chain slugs can't whipsaw us.
	return compareOnchainParts(onchainPart(p.ID), onchainPart(last))
}

// compareOnchainParts returns true when a > b. Both are the numeric suffix
// strings extracted by onchainPart. When both parse as base-10 ints the
// comparison is numeric; when either is non-numeric it falls back to string
// compare so malformed ids never panic and the function remains total.
func compareOnchainParts(a, b string) bool {
	ai, aerr := strconv.Atoi(a)
	bi, berr := strconv.Atoi(b)
	if aerr == nil && berr == nil {
		return ai > bi
	}
	// Defensive fallback: at least one side is non-numeric.
	return a > b
}

func onchainPart(id string) string {
	idx := strings.LastIndex(id, "-")
	if idx < 0 || idx == len(id)-1 {
		return id
	}
	return id[idx+1:]
}

// publish sends one post to Telegram + records its message id and the current
// on-chain snapshot (ActionCount + LastUpdatedAt). No inline keyboard is
// attached — the vote subsystem has been removed.
func (s *Service) publish(ctx context.Context, p graphql.Post) error {
	text := telegram.FormatPostMessage(p)
	msgID, err := s.Bot.SendMessage(ctx, s.ChannelID, text, nil)
	if err != nil {
		return fmt.Errorf("send message: %w", err)
	}
	s.Store.RegisterPost(p.ID, msgID, p.Chain.Slug)
	s.Store.UpdatePostSnapshot(p.ID, p.ActionCount, p.LastUpdatedAt)
	s.Logger.Info("published",
		"post_id", p.ID,
		"chain", p.Chain.Slug,
		"message_id", msgID,
		"title", p.Title,
		"action_count", p.ActionCount,
	)
	return nil
}

// amendEdit edits an existing Telegram message to reflect new post content.
// Re-renders with the current on-chain data (bumped rev N), calls
// editMessageText on the Bot API, and updates the stored snapshot so the
// next poll won't re-trigger an edit for the same amendment.
//
// Keyboard note: the vote subsystem has been removed. Passing nil here is
// correct for new posts (no keyboard to clear). For any message that still
// carries a legacy vote keyboard from before this change was deployed, the
// nil keyboard leaves that existing keyboard intact rather than clearing it.
// That is an acceptable trade-off; retractEdit explicitly sends an empty
// keyboard to ensure retracted messages are always button-free.
func (s *Service) amendEdit(ctx context.Context, p graphql.Post, msgID int64) error {
	text := telegram.FormatPostMessage(p)

	if err := s.Bot.EditMessageText(ctx, s.ChannelID, msgID, text, nil); err != nil {
		return fmt.Errorf("edit message text: %w", err)
	}

	s.Store.UpdatePostSnapshot(p.ID, p.ActionCount, p.LastUpdatedAt)
	s.Logger.Info("amended",
		"post_id", p.ID,
		"chain", p.Chain.Slug,
		"message_id", msgID,
		"action_count", p.ActionCount,
		"last_updated_at", p.LastUpdatedAt,
	)
	return nil
}

// retractEdit edits an existing Telegram message to the struck-through
// RETRACTED state (N3). It is called by checkRetracts when postById confirms
// a stored post has been retracted on-chain.
//
// The message is never deleted — the channel stays auditable.
// On success the store is marked retracted so subsequent polls are no-ops.
//
// Keyboard removal: passing nil to EditMessageText results in the reply_markup
// field being omitted from the request body (the Bot API's omitempty behaviour),
// which causes Telegram to leave the existing keyboard intact. To genuinely
// remove the vote keyboard from a retracted post, we explicitly send an empty
// InlineKeyboardMarkup ({"inline_keyboard": []}).
func (s *Service) retractEdit(ctx context.Context, p *graphql.PostByIdResult, postID string, msgID int64) error {
	text := telegram.FormatRetractedMessage(p.Title)

	// Explicitly empty keyboard to remove the vote buttons. Passing nil
	// would omit reply_markup entirely, leaving the existing keyboard intact.
	emptyKB := &telegram.InlineKeyboardMarkup{InlineKeyboard: [][]telegram.InlineKeyboardButton{}}

	if err := s.Bot.EditMessageText(ctx, s.ChannelID, msgID, text, emptyKB); err != nil {
		return fmt.Errorf("retract edit message text: %w", err)
	}

	s.Store.MarkRetracted(postID)
	s.Logger.Info("retracted",
		"post_id", postID,
		"message_id", msgID,
	)
	return nil
}
