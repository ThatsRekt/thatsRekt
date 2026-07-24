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
//
// Poison-pill guard (issue #262, hardened by the PR #265 review):
//
// maxPublishAttempts bounds the number of *non-transient* failed attempts we
// allow for any single post's current content before permanently giving up
// (persisted to S3). Future polls skip a given-up post with a log entry at
// WARN. An ERROR is emitted on the cycle that crosses the threshold,
// surfacing the payload for operator investigation.
//
// Only non-transient failures count (blocker 1). A transient failure —
// classified by telegram.ClassifySendError as SendTransient: rate-limit,
// 5xx, or a network-level fault — never consumes this budget; it is logged
// at WARN and retried on the next poll cycle with no state mutation at all.
// The alternative (the pre-review behaviour) trades an infinite-retry bug for
// a silent alert-loss bug: a ~50 s Telegram/network blip would otherwise
// permanently discard a hack alert, which is strictly worse for a public
// safety channel than looping loudly. Only a deterministic, retry-proof
// failure (wrong chat_id, bot blocked, or a parse-entity error that also
// fails its plain-text fallback) may burn the budget.
//
// The budget — and the give-up flag itself — is scoped to a fingerprint of
// the post's ON-CHAIN content, not the bare post id (blocker 2; see
// contentFingerprint and store.Store.IsPublishGivenUp). If that content later
// changes — an on-chain AMENDMENT, which bumps ActionCount/LastUpdatedAt —
// the fingerprint changes too and the post gets a fresh budget automatically:
// give-up self-heals rather than permanently tombstoning the post.
//
// A notifier CODE deploy that changes how a post renders (e.g. a fix to
// FormatPostMessage) does NOT change the fingerprint — ActionCount and
// LastUpdatedAt are on-chain data, unaffected by what binary is running. A
// post given up on before such a deploy stays given up after it. The actual
// ethereum-38 incident was fixed by deploying PRs #263/#264 — a rendering
// fix, not an on-chain amendment — so under THIS scheme it would still need
// the operator to run cmd/clear-given-up post-deploy; it would not have
// un-suppressed itself. See cmd/clear-given-up for that recovery path.
//
// N = 5 justification: at the default 10 s poll interval, five non-transient
// attempts give ~50 s before giving up on genuinely unfixable-by-retry
// content (e.g. a chat the bot has no access to). A parse-entity error and
// its plain-text fallback together count as ONE attempt (not two) — see
// publishWithFallback — so five polls is the full budget for a post whose
// HTML and plain-text renders both fail identically every time.
package notifier

import (
	"context"
	"errors"
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
	// SendMessage posts a new message to chatID. parseMode controls Telegram's
	// text parser: "HTML" enables <b>, <a href="…">, etc.; "" sends plain text
	// with no entity parsing. Pass "" for the plain-text fallback when Telegram
	// has rejected the HTML version with a parse error.
	SendMessage(ctx context.Context, chatID, text, parseMode string, kb *telegram.InlineKeyboardMarkup) (int64, error)
	EditMessageText(ctx context.Context, chatID string, messageID int64, text string, kb *telegram.InlineKeyboardMarkup) error
}

// maxPublishAttempts is the maximum number of failed publish attempts allowed
// per post before the service permanently gives up. See the package-level
// comment for the N=5 justification.
const maxPublishAttempts = 5

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
			fp := contentFingerprint(p)
			// Poison-pill guard: if we have already permanently given up on
			// this exact content, advance the high-water mark and move on.
			// The ERROR log emitted on the give-up cycle is the operator's
			// action item. A content change (fp differs) is NOT given up —
			// see contentFingerprint and Store.IsPublishGivenUp.
			if s.Store.IsPublishGivenUp(p.ID, fp) {
				s.Logger.Warn("skipping given-up new post — advancing high-water mark",
					"post_id", p.ID,
				)
				s.Store.SetLastSeen(p.Chain.Slug, p.ID)
				continue
			}
			if transient, err := s.publishWithFallback(ctx, p); err != nil {
				if s.handlePublishFailure(p, fp, err, transient, "new post") {
					// Advance so subsequent polls do not re-enter State 1 for
					// this post. The give-up flag persists even if LastSeen is
					// somehow reset, providing defence in depth.
					s.Store.SetLastSeen(p.Chain.Slug, p.ID)
				}
				// Do not bump LastSeen on transient / below-limit failures —
				// try again next cycle.
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
			//
			// Poison-pill guard (issue #262): if we have already permanently
			// given up on this exact content, skip it silently. The ERROR
			// log on the give-up cycle is the operator's action item. A
			// content change is NOT given up — see contentFingerprint.
			fp := contentFingerprint(p)
			if s.Store.IsPublishGivenUp(p.ID, fp) {
				continue
			}

			s.Logger.Info("not-new post absent from store — publishing fresh",
				"post_id", p.ID,
				"action_count", p.ActionCount,
			)
			if transient, err := s.publishWithFallback(ctx, p); err != nil {
				s.handlePublishFailure(p, fp, err, transient, "post")
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
			var termErr *telegram.ErrTerminalEdit
			if errors.As(err, &termErr) {
				// Advance the snapshot in both terminal sub-cases to stop the
				// retry loop. For amendments the harm is cosmetic: the message
				// shows stale content. Retrying indefinitely is worse.
				s.Store.UpdatePostSnapshot(p.ID, p.ActionCount, p.LastUpdatedAt)
				if termErr.MessageGone {
					// Message was deleted from the channel — nothing left to edit.
					s.Logger.Warn("amendment edit permanently failed — message gone, tombstoning snapshot",
						"post_id", p.ID,
						"message_id", msgID,
						"reason", termErr.Description,
					)
				} else {
					// Message EXISTS but is uneditable (edit window expired, or bot
					// lost admin rights). Content is stale — log at ERROR so the
					// operator can see it. Snapshot advanced to stop retrying.
					s.Logger.Error("amendment edit permanently failed — message uneditable, tombstoning snapshot; message shows stale content",
						"post_id", p.ID,
						"message_id", msgID,
						"reason", termErr.Description,
					)
				}
				continue
			}
			// Transient (network error, rate-limit, etc.) — retry on next poll.
			s.Logger.Warn("amendment edit failed (will retry)", "post_id", p.ID, "err", err)
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
			var termErr *telegram.ErrTerminalEdit
			if errors.As(err, &termErr) {
				if termErr.MessageGone {
					// The message no longer exists in the channel — the false-
					// accusation risk is gone. Mark retracted so StoredPosts()
					// excludes this post on future polls. See issue #256 Bug 2.
					s.Store.MarkRetracted(e.PostID)
					s.Logger.Warn("checkRetracts: retract edit permanently failed — message gone, marking retracted",
						"post_id", e.PostID,
						"message_id", e.MessageID,
						"reason", termErr.Description,
					)
				} else {
					// CRITICAL: the message EXISTS and is still publicly visible,
					// but the bot cannot edit it (edit window expired, or admin
					// rights revoked). Do NOT call MarkRetracted — that would
					// permanently silence retrying and leave a live false accusation
					// marked "done". Log at ERROR. A human must manually delete the
					// Telegram message; once that is confirmed, remove or set
					// retracted:true for this post in state.json.
					s.Logger.Error(
						"CRITICAL: checkRetracts — retract edit blocked; false accusation still publicly visible; MANUAL RETRACTION REQUIRED",
						"post_id", e.PostID,
						"message_id", e.MessageID,
						"reason", termErr.Description,
					)
				}
				continue
			}
			// Transient (network error, rate-limit, etc.) — retry on next poll.
			s.Logger.Warn("checkRetracts: retract edit failed (will retry)",
				"post_id", e.PostID,
				"chain", e.ChainSlug,
				"err", err,
			)
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

// publishWithFallback sends a new Telegram message for p and records the
// outcome in the store. It is called for both fresh posts (State 1) and the
// catch-up fallback path (State 5).
//
// Attempt sequence:
//  1. Render p as HTML and call SendMessage with ParseMode="HTML".
//  2. If Telegram returns a parse-entity error ("can't parse entities"),
//     render p as plain text and call SendMessage with no parse mode.
//     A plain, unformatted alert is far better than no alert. The plain-text
//     path reuses the existing stripMarkup helper (issue #264, DRY).
//  3. If both attempts fail, return a combined error. The caller decides
//     whether to count the attempt and handles give-up logic via
//     handlePublishFailure.
//
// transient reports whether the overall failure should be exempt from the
// maxPublishAttempts budget (issue #262 review, PR #265 blocker 1). The HTML
// attempt's own classification is never what decides this: if it was a
// parse error, that half of the round is deterministic and permanent by
// definition — what matters is whether the SECOND (plain-text) attempt also
// failed, and if so, whether THAT failure was transient. If the HTML attempt
// failed for a non-parse-error reason, its own classification decides.
//
// On success (either HTML or plain-text), RegisterPost and UpdatePostSnapshot
// are called so the post is tracked for future amendment and retract handling.
func (s *Service) publishWithFallback(ctx context.Context, p graphql.Post) (transient bool, err error) {
	htmlText := telegram.FormatPostMessage(p)
	msgID, sendErr := s.Bot.SendMessage(ctx, s.ChannelID, htmlText, "HTML", nil)
	if sendErr == nil {
		s.registerPublished(p, msgID)
		return false, nil
	}

	// Parse-entity error: the HTML is syntactically invalid for Telegram's
	// parser. Retry exactly once with plain text — the same HTML payload would
	// fail identically on every subsequent attempt (deterministic failure).
	if telegram.IsParseError(sendErr) {
		s.Logger.Warn("publish HTML rejected by Telegram parse error — falling back to plain text",
			"post_id", p.ID,
			"err", sendErr,
		)
		plainText := telegram.FormatPlainTextMessage(p)
		plainMsgID, fallbackErr := s.Bot.SendMessage(ctx, s.ChannelID, plainText, "", nil)
		if fallbackErr == nil {
			s.Logger.Warn("published via plain-text fallback",
				"post_id", p.ID,
				"chain", p.Chain.Slug,
				"message_id", plainMsgID,
			)
			s.registerPublished(p, plainMsgID)
			return false, nil
		}
		combined := fmt.Errorf("send HTML: %w; plain-text fallback: %w", sendErr, fallbackErr)
		return telegram.ClassifySendError(fallbackErr) == telegram.SendTransient, combined
	}

	return telegram.ClassifySendError(sendErr) == telegram.SendTransient, fmt.Errorf("send message: %w", sendErr)
}

// handlePublishFailure applies the poison-pill retry/give-up policy for a
// failed publish attempt (issue #262 review, PR #265 blockers 1 and 2):
//
//   - transient failures (network blips, 429s, 5xx) never consume the
//     maxPublishAttempts budget and mutate no store state at all — they are
//     logged at WARN and retried on the next poll with a clean slate;
//   - non-transient failures increment the attempt counter, scoped to fp (a
//     fingerprint of the ON-CHAIN content currently being published) so an
//     amendment gets a fresh budget rather than inheriting a prior failure
//     count for content that no longer exists. A rendering-fixing notifier
//     deploy does NOT change fp (fp is on-chain data) — see cmd/clear-given-up
//     for that recovery path;
//   - crossing maxPublishAttempts marks the post given-up, scoped to the
//     same fingerprint (self-healing give-up).
//
// logContext is a short label ("new post" / "post") purely for keeping the
// two call sites' log lines distinguishable; it has no effect on behaviour.
// Returns true if this call crossed the give-up threshold — the caller (State
// 1 only) uses this to decide whether to advance the high-water mark.
func (s *Service) handlePublishFailure(p graphql.Post, fp string, sendErr error, transient bool, logContext string) bool {
	if transient {
		s.Logger.Warn("publish failed (transient — not counted against attempt budget, will retry)",
			"post_id", p.ID,
			"context", logContext,
			"err", sendErr,
		)
		return false
	}

	st := s.Store.RecordPublishFailure(p.ID, fp, true)
	if st.Attempts < maxPublishAttempts {
		s.Logger.Warn("publish failed (will retry)",
			"post_id", p.ID,
			"context", logContext,
			"attempt", st.Attempts,
			"of", maxPublishAttempts,
			"err", sendErr,
		)
		return false
	}

	s.Store.MarkPublishGivenUp(p.ID, fp)
	s.Logger.Error("publish permanently failed — giving up",
		"post_id", p.ID,
		"context", logContext,
		"attempts", st.Attempts,
		"err", sendErr,
	)
	return true
}

// contentFingerprint returns a stable identifier for the on-chain content
// that determines what gets published for p, used to scope the notifier's
// publish-retry and give-up state (issue #262 review, PR #265 blocker 2)
// instead of the bare post id.
//
// Deliberately NOT a hash of the rendered text: telegram.FormatPostMessage
// renders a relative "X ago" timestamp computed from wall-clock time, which
// drifts on every single poll independent of the on-chain data. Hashing the
// rendered output directly would reset the attempt counter on every poll —
// the budget would never be reached and a genuinely permanent failure would
// retry forever. ActionCount + LastUpdatedAt is exactly the pair
// Store.HasChanged already uses to detect "has this post changed" for
// amendment handling — reusing it here keeps one definition of "changed" for
// the whole package, and is sufficient: nothing else in the post's rendered
// content (title, note, attackers, victims) changes on-chain without also
// bumping one of these two fields.
func contentFingerprint(p graphql.Post) string {
	return fmt.Sprintf("%d@%s", p.ActionCount, p.LastUpdatedAt)
}

// registerPublished records a successful Telegram send in the store. Called
// by publishWithFallback on both the HTML and plain-text success paths.
func (s *Service) registerPublished(p graphql.Post, msgID int64) {
	s.Store.RegisterPost(p.ID, msgID, p.Chain.Slug)
	s.Store.UpdatePostSnapshot(p.ID, p.ActionCount, p.LastUpdatedAt)
	s.Logger.Info("published",
		"post_id", p.ID,
		"chain", p.Chain.Slug,
		"message_id", msgID,
		"title", p.Title,
		"action_count", p.ActionCount,
	)
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
