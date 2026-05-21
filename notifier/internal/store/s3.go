// Package store — persistence layer for notifier state.
//
// State is a single small JSON document held in S3. The bot reads it at
// startup, mutates in memory, and writes back periodically. Object size is
// tiny (a few KB even with hundreds of tracked posts) so the read/write
// cost is negligible.
//
// Why S3 vs DynamoDB / RDS / EFS:
//   - Free at this volume. No table provisioning, no schema migrations.
//   - Single binary blob is the right primitive for "load-mutate-save"
//     without per-field updates. Concurrency is a non-issue: this service
//     is single-instance.
//   - DAMM has S3 already — no new infra surface area.
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// State is the entire persisted document. Keep it small + flat — the bot
// holds the whole thing in memory and rewrites the entire JSON on every
// flush, which is fine at our scale.
type State struct {
	// Composite post id of the highest-numbered post we've already
	// posted to Telegram. New posts have id strictly greater than this
	// (lexicographic — fine because all current ids are
	// `{chainSlug}-{base10-int}` and per-chain ids are monotonic).
	// Tracked per chain so we don't get whipsawed when a different
	// chain catches up.
	LastSeenByChain map[string]string `json:"lastSeenByChain"`

	// Per-post Telegram-side metadata: which message id is the bot's
	// post (so we can edit), and the running cosmetic vote counts.
	Posts map[string]PostState `json:"posts"`
}

type PostState struct {
	MessageID int64 `json:"messageId"`
	UpVotes   int   `json:"upVotes"`
	DownVotes int   `json:"downVotes"`
	// Track which Telegram users have already voted on this post + in
	// which direction, so a single user can't tap ✓ ten times. Keyed
	// by `tg_user_id` (string for JSON friendliness).
	Voters map[string]string `json:"voters"` // direction: "up" | "down"

	// Snapshot of the last on-chain state seen for this post. Used for
	// amendment change-detection: if the current poll returns a different
	// ActionCount or LastUpdatedAt, the post has been amended on-chain.
	// Both fields are zero-value for posts published before N2 deployed;
	// those are treated as "unchanged" (no spurious re-edit on first boot).
	LastActionCount int    `json:"lastActionCount"`
	LastUpdatedAt   string `json:"lastUpdatedAt"`
}

// Store is the S3-backed state holder. Methods are safe to call from
// multiple goroutines concurrently — internal mutex guards the in-memory
// copy. Persistence to S3 is via Save() which the caller schedules.
type Store struct {
	bucket string
	key    string
	client *s3.Client

	mu    sync.Mutex
	state State
	dirty bool
}

func New(client *s3.Client, bucket, key string) *Store {
	return &Store{
		bucket: bucket,
		key:    key,
		client: client,
		state: State{
			LastSeenByChain: map[string]string{},
			Posts:           map[string]PostState{},
		},
	}
}

// NewInMemory returns a zero-dependency, S3-free Store for use in tests.
// Save is a no-op. All other methods work identically to the production Store.
func NewInMemory() *Store {
	return &Store{
		state: State{
			LastSeenByChain: map[string]string{},
			Posts:           map[string]PostState{},
		},
	}
}

// Load reads the document from S3 into memory. A 404 is fine — that's the
// first-run case. Other errors are surfaced.
func (s *Store) Load(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.key),
	})
	if err != nil {
		var nsk *types.NoSuchKey
		if errors.As(err, &nsk) {
			// First run. Empty state already initialised in New().
			return nil
		}
		return fmt.Errorf("get state: %w", err)
	}
	defer out.Body.Close()

	raw, err := io.ReadAll(out.Body)
	if err != nil {
		return fmt.Errorf("read state body: %w", err)
	}
	if len(raw) == 0 {
		return nil
	}
	var parsed State
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return fmt.Errorf("unmarshal state: %w", err)
	}
	if parsed.LastSeenByChain == nil {
		parsed.LastSeenByChain = map[string]string{}
	}
	if parsed.Posts == nil {
		parsed.Posts = map[string]PostState{}
	}
	s.state = parsed
	return nil
}

// Save flushes the in-memory state to S3. Idempotent — no-op if no
// mutations have happened since the last save, or if the store was created
// with NewInMemory (no S3 client).
func (s *Store) Save(ctx context.Context) error {
	s.mu.Lock()
	if !s.dirty || s.client == nil {
		s.mu.Unlock()
		return nil
	}
	body, err := json.MarshalIndent(s.state, "", "  ")
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		return fmt.Errorf("marshal state: %w", err)
	}

	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(s.key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("application/json"),
	})
	if err != nil {
		// Re-mark dirty so the next Save retries.
		s.mu.Lock()
		s.dirty = true
		s.mu.Unlock()
		return fmt.Errorf("put state: %w", err)
	}
	return nil
}

// LastSeen returns the high-water-mark id for a chain. Empty string if
// we've never posted on that chain yet.
func (s *Store) LastSeen(chainSlug string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state.LastSeenByChain[chainSlug]
}

// SetLastSeen marks `id` as the latest one we've posted for a chain.
// Caller passes IDs in ascending order; we don't enforce monotonicity.
func (s *Store) SetLastSeen(chainSlug, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.LastSeenByChain[chainSlug] = id
	s.dirty = true
}

// RegisterPost records that we just posted `postID` to Telegram with
// message id `msgID`. Initialises empty vote state.
func (s *Store) RegisterPost(postID string, msgID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps := s.state.Posts[postID] // preserve existing snapshot if any
	ps.MessageID = msgID
	if ps.Voters == nil {
		ps.Voters = map[string]string{}
	}
	s.state.Posts[postID] = ps
	s.dirty = true
}

// UpdatePostSnapshot records the on-chain action count and lastUpdatedAt for
// `postID` so the next poll can detect amendments (a change in either value
// signals that the post has been amended on-chain).
func (s *Store) UpdatePostSnapshot(postID string, actionCount int, lastUpdatedAt string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps := s.state.Posts[postID]
	ps.LastActionCount = actionCount
	ps.LastUpdatedAt = lastUpdatedAt
	s.state.Posts[postID] = ps
	s.dirty = true
}

// MessageIDFor returns the Telegram message id for a known post, and true if
// the post is in the store. Returns 0, false for unknown posts.
func (s *Store) MessageIDFor(postID string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return 0, false
	}
	return ps.MessageID, true
}

// HasSnapshot reports whether a post in the store has a non-zero-value
// amendment snapshot (LastActionCount != 0 or LastUpdatedAt != ""). Returns
// false for posts that are absent from the store or that have a zero-value
// snapshot (e.g. posts published before N2 deployed — "pre-N2 posts").
func (s *Store) HasSnapshot(postID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return false
	}
	return ps.LastActionCount != 0 || ps.LastUpdatedAt != ""
}

// HasChanged reports whether the given (actionCount, lastUpdatedAt) pair
// differs from what was last recorded for postID.
//
// Callers must only invoke this after confirming a snapshot exists via
// HasSnapshot (or equivalent logic in PollOnce). The function returns false
// for posts absent from the store; the zero-value snapshot case is no longer
// handled here — PollOnce distinguishes "no snapshot" from "unchanged"
// explicitly using HasSnapshot.
func (s *Store) HasChanged(postID string, actionCount int, lastUpdatedAt string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return false
	}
	return ps.LastActionCount != actionCount || ps.LastUpdatedAt != lastUpdatedAt
}

// PostState returns the current vote-tracking state for a post. The second
// return value is `false` when the post is unknown (e.g. shutdown happened
// mid-startup before RegisterPost ran).
func (s *Store) PostState(postID string) (PostState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return PostState{}, false
	}
	// Return a defensive copy so callers can't mutate the live map.
	voters := make(map[string]string, len(ps.Voters))
	for k, v := range ps.Voters {
		voters[k] = v
	}
	ps.Voters = voters
	return ps, true
}

// ApplyVote registers a vote from `tgUserID` on `postID`. Toggles off if
// they re-press the same direction; switches if they press the other
// direction. Returns the resulting (UpVotes, DownVotes) counts and a
// bool indicating whether the message needs to be re-edited (false if
// the press was a no-op, e.g. unknown post).
func (s *Store) ApplyVote(postID, tgUserID, direction string) (up, down int, changed bool) {
	if direction != "up" && direction != "down" {
		return 0, 0, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return 0, 0, false
	}
	if ps.Voters == nil {
		ps.Voters = map[string]string{}
	}
	prev := ps.Voters[tgUserID]
	switch {
	case prev == direction:
		// Toggle off — they pressed the same direction twice.
		delete(ps.Voters, tgUserID)
		if direction == "up" {
			ps.UpVotes--
		} else {
			ps.DownVotes--
		}
	case prev == "up" && direction == "down":
		ps.Voters[tgUserID] = direction
		ps.UpVotes--
		ps.DownVotes++
	case prev == "down" && direction == "up":
		ps.Voters[tgUserID] = direction
		ps.UpVotes++
		ps.DownVotes--
	default:
		// Fresh vote.
		ps.Voters[tgUserID] = direction
		if direction == "up" {
			ps.UpVotes++
		} else {
			ps.DownVotes++
		}
	}
	s.state.Posts[postID] = ps
	s.dirty = true
	return ps.UpVotes, ps.DownVotes, true
}
