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
	// posted to Telegram. Post ids are `{chainSlug}-{base10-int}` and
	// are NOT zero-padded; the Service.isNew comparison is numeric, not
	// lexicographic (see service.go:compareOnchainParts). Tracked per
	// chain so we don't get whipsawed when a different chain catches up.
	LastSeenByChain map[string]string `json:"lastSeenByChain"`

	// Per-post Telegram-side metadata: which message id is the bot's
	// post (so we can edit), and the running cosmetic vote counts.
	Posts map[string]PostState `json:"posts"`
}

type PostState struct {
	MessageID int64 `json:"messageId"`

	// Snapshot of the last on-chain state seen for this post. Used for
	// amendment change-detection: if the current poll returns a different
	// ActionCount or LastUpdatedAt, the post has been amended on-chain.
	// Both fields are zero-value for posts published before N2 deployed;
	// those are treated as "unchanged" (no spurious re-edit on first boot).
	LastActionCount int    `json:"lastActionCount"`
	LastUpdatedAt   string `json:"lastUpdatedAt"`

	// ChainSlug is the chain this post lives on (e.g. "base", "ethereum").
	// Stored at publish time so the retract-detection pass can call the
	// correct per-chain <Prefix>_postById query without re-deriving the
	// chain from the composite post id. Zero-value ("") for posts recorded
	// before N3 deployed; those posts are skipped by the retract pass
	// (they will be picked up as soon as they next appear in the posts feed
	// and their chain slug is re-recorded via publish).
	ChainSlug string `json:"chainSlug,omitempty"`

	// Retracted records that this post has already been edited to the
	// RETRACTED state in Telegram. Once true, subsequent polls that still
	// see removed=true are no-ops — the retract edit is idempotent.
	Retracted bool `json:"retracted,omitempty"`
}

// Backward-compatibility note: existing S3 JSON state may contain the now-
// removed fields "upVotes", "downVotes", and "voters" in each PostState entry.
// Go's json.Unmarshal ignores unknown fields by default, so those entries
// deserialize cleanly into the current struct without error. No migration is
// required.

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
// message id `msgID` for the given `chainSlug`.
func (s *Store) RegisterPost(postID string, msgID int64, chainSlug string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps := s.state.Posts[postID] // preserve existing snapshot if any
	ps.MessageID = msgID
	ps.ChainSlug = chainSlug
	s.state.Posts[postID] = ps
	s.dirty = true
}

// StoredPostEntry is a minimal snapshot of a stored post, used by the
// retract-detection pass to iterate posts without exposing the full PostState.
type StoredPostEntry struct {
	PostID    string
	MessageID int64
	ChainSlug string
}

// StoredPosts returns all posts currently tracked by the store that are not
// yet marked retracted and have a known chain slug (set at publish time).
// The retract-detection pass iterates this slice to decide which posts to
// probe via the per-chain postById query.
func (s *Store) StoredPosts() []StoredPostEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]StoredPostEntry, 0, len(s.state.Posts))
	for id, ps := range s.state.Posts {
		if ps.Retracted || ps.ChainSlug == "" {
			continue
		}
		out = append(out, StoredPostEntry{
			PostID:    id,
			MessageID: ps.MessageID,
			ChainSlug: ps.ChainSlug,
		})
	}
	return out
}

// SetChainSlug writes the chain slug for a post that was published before N3
// deployed (ChainSlug was not stored at publish time). It is idempotent: calling
// it when ChainSlug is already set is a no-op with respect to the stored value,
// though the dirty flag is still updated to keep flush semantics consistent.
// After this call, StoredPosts will include the post in its result set.
func (s *Store) SetChainSlug(postID, chainSlug string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps := s.state.Posts[postID]
	ps.ChainSlug = chainSlug
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

// IsRetracted reports whether the RETRACTED edit has already been applied to
// this post's Telegram message. Returns false for unknown posts, so the first
// retract poll always triggers the edit.
func (s *Store) IsRetracted(postID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return false
	}
	return ps.Retracted
}

// MarkRetracted records that the RETRACTED edit has been applied for postID.
// Subsequent calls with the same postID are idempotent (setting true to true
// is a no-op; the dirty flag is still set to ensure the state is persisted).
func (s *Store) MarkRetracted(postID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps := s.state.Posts[postID]
	ps.Retracted = true
	s.state.Posts[postID] = ps
	s.dirty = true
}

// PostState returns the stored state for a post. The second return value is
// false when the post is unknown (e.g. shutdown happened mid-startup before
// RegisterPost ran).
func (s *Store) PostState(postID string) (PostState, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ps, ok := s.state.Posts[postID]
	if !ok {
		return PostState{}, false
	}
	// PostState is a value type — returning it by value is already a copy.
	return ps, true
}
