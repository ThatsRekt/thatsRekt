// Package notifier_test — service-level tests for amendment handling (N2),
// retract handling (N3), and the isNew numeric-compare fix (issue #236).
//
// These tests exercise the poll loop through stub implementations of the
// Telegram bot and GraphQL client. No network, no S3.
//
// Covered acceptance criteria (issue #128, N2):
//   - Amendment edits the existing Telegram message via the stored tg_message_id;
//     no new message is posted.
//   - The edited message reflects the new content and an incremented rev N.
//   - A changed post with no stored message falls back to a fresh publish.
//   - Pre-N2 posts (zero-value snapshot) are back-filled on first poll without
//     triggering an edit; a subsequent amendment is then detected and edited.
//
// Covered acceptance criteria (issue #129, N3):
//   - A retracted post (detected via postById) edits the existing Telegram
//     message to RETRACTED state.
//   - The message is never deleted (no DeleteMessage call).
//   - A retracted post with no stored message_id is a no-op (postById returns
//     removed=true, but the post is not in the store — nothing to edit).
//   - Retract is idempotent: repeated polls on an already-retracted post do not
//     trigger additional edits.
//   - The retract edit sends an explicitly empty keyboard (not nil) to clear any
//     legacy keyboard — passing nil would leave an existing keyboard intact.
//
// Covered acceptance criteria (issue #236, isNew numeric compare):
//   - isNew returns true for post #10 when last-seen is post #9 (single→double
//     digit boundary — the broken case with lexicographic compare).
//   - isNew returns false for post #9 when last-seen is post #10.
//   - Multi-digit ordering is correct across -9 / -10 / -11 / -100.
//   - Non-numeric / malformed id portions fall back to string compare without
//     panicking.
//   - Per-chain isolation is preserved (last-seen is per chain slug).
package notifier_test

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/notifier"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// ---- stubs ---------------------------------------------------------------

// stubGQL implements notifier.GQLClient. It serves a fixed slice of posts via
// LatestPosts and a configurable postById response via PostById.
type stubGQL struct {
	mu    sync.Mutex
	posts []graphql.Post

	// postByIdFn, when non-nil, is called by PostById. If nil, PostById
	// returns (nil, nil) (post not found / not retracted).
	postByIdFn func(chainSlug, onchainID string) (*graphql.PostByIdResult, error)
}

func (g *stubGQL) LatestPosts(_ context.Context, _ int) ([]graphql.Post, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]graphql.Post, len(g.posts))
	copy(out, g.posts)
	return out, nil
}

func (g *stubGQL) PostById(_ context.Context, chainSlug, onchainID string) (*graphql.PostByIdResult, error) {
	g.mu.Lock()
	fn := g.postByIdFn
	g.mu.Unlock()
	if fn == nil {
		return nil, nil
	}
	return fn(chainSlug, onchainID)
}

// stubBot implements notifier.TelegramBot. It records sends, edits, and
// keyboard arguments passed to EditMessageText so tests can assert the
// keyboard-removal behaviour of retractEdit.
type stubBot struct {
	mu      sync.Mutex
	sends   []sendCall
	edits   []editCall
	deletes int
	nextID  int64
}

type sendCall struct {
	chatID string
	text   string
}

type editCall struct {
	chatID    string
	messageID int64
	text      string
	keyboard  *telegram.InlineKeyboardMarkup // nil means omitted; non-nil means sent
}

func (b *stubBot) SendMessage(_ context.Context, chatID, text string, _ *telegram.InlineKeyboardMarkup) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	b.sends = append(b.sends, sendCall{chatID: chatID, text: text})
	return b.nextID, nil
}

func (b *stubBot) EditMessageText(_ context.Context, chatID string, messageID int64, text string, kb *telegram.InlineKeyboardMarkup) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.edits = append(b.edits, editCall{chatID: chatID, messageID: messageID, text: text, keyboard: kb})
	return nil
}

// ---- helpers ---------------------------------------------------------------

func makeTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// basePost returns a published post already in the store.
func basePost() graphql.Post {
	return graphql.Post{
		ID:                 "base-1",
		Chain:              graphql.Chain{ChainID: 8453, Slug: "base", Name: "Base"},
		Poster:             "0xaaaa",
		Title:              "Butter Bridge Hack",
		Note:               "summary: Butter Bridge drained\nchains: base\ntxs: 0xaaaa\nsources: @rekt",
		ActionCount:        1,
		LastUpdatedAt:      "2026-05-21T10:00:00Z",
		CreatedAtTimestamp: "2026-05-21T10:00:00Z",
		Attackers:          []string{"0x1111111111111111111111111111111111111111"},
	}
}

// amendedPost returns the same post with a bumped action count and timestamp.
func amendedPost() graphql.Post {
	p := basePost()
	p.ActionCount = 2
	p.LastUpdatedAt = "2026-05-21T11:00:00Z"
	p.Note = "summary: Butter Bridge drained (updated)\nchains: base\ntxs: 0xaaaa\nsources: @rekt"
	return p
}

// populatedStore returns an in-memory store that already knows about base-1.
// The store is initialised directly (not via S3) so tests need no AWS.
func populatedStore(postID string, msgID int64, p graphql.Post) *store.Store {
	st := store.NewInMemory()
	st.RegisterPost(postID, msgID, p.Chain.Slug)
	st.SetLastSeen(p.Chain.Slug, postID)
	st.UpdatePostSnapshot(postID, p.ActionCount, p.LastUpdatedAt)
	return st
}

// ---- N2 tests -----------------------------------------------------------------

// TestPollOnce_AmendmentEditsExistingMessage is the primary acceptance
// criterion: an amended post (changed ActionCount/LastUpdatedAt) that is
// already in the store is edited in place — no new message is posted.
func TestPollOnce_AmendmentEditsExistingMessage(t *testing.T) {
	// Arrange: the store already has base-1 with rev 1 at message_id 42.
	pub := basePost()
	st := populatedStore("base-1", 42, pub)

	// The poll returns the amended version of the same post.
	bot := &stubBot{}
	gql := &stubGQL{posts: []graphql.Post{amendedPost()}}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	// Assert: exactly one edit, zero sends.
	bot.mu.Lock()
	sends := len(bot.sends)
	edits := len(bot.edits)
	bot.mu.Unlock()

	if sends != 0 {
		t.Errorf("expected 0 sends for amendment, got %d", sends)
	}
	if edits != 1 {
		t.Errorf("expected 1 edit for amendment, got %d", edits)
	}

	// The edit must target the correct message id.
	bot.mu.Lock()
	gotMsgID := bot.edits[0].messageID
	bot.mu.Unlock()
	if gotMsgID != 42 {
		t.Errorf("expected edit on message_id=42, got %d", gotMsgID)
	}
}

// TestPollOnce_AmendmentReflectsNewRevision verifies that the edited message
// body shows the bumped rev N derived from the new ActionCount.
func TestPollOnce_AmendmentReflectsNewRevision(t *testing.T) {
	pub := basePost()
	st := populatedStore("base-1", 7, pub)

	bot := &stubBot{}
	gql := &stubGQL{posts: []graphql.Post{amendedPost()}}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	edits := bot.edits
	bot.mu.Unlock()

	if len(edits) != 1 {
		t.Fatalf("expected 1 edit, got %d", len(edits))
	}

	editedText := edits[0].text
	if !strings.Contains(editedText, "rev 2") {
		t.Errorf("expected edited message to contain 'rev 2', got:\n%s", editedText)
	}
}

// TestPollOnce_UnmappedAmendedPostFallsBackToSend covers the case where a
// not-new post (id ≤ high-water mark) has been amended but the notifier has
// no stored message_id for it (e.g. the post was created before the notifier
// started, then amended later). It must fall back to a fresh publish.
//
// Arrangement:
//   - The store knows about a DIFFERENT post (other-1) so the high-water mark
//     for the chain is set above base-1's on-chain id equivalent, meaning
//     base-1 is not new.
//   - base-1 is absent from the Posts map — the notifier never published it.
//   - The poll returns an amended version of base-1 (ActionCount=2).
//
// Expected: 1 fresh send, 0 edits (fallback to publish).
func TestPollOnce_UnmappedAmendedPostFallsBackToSend(t *testing.T) {
	st := store.NewInMemory()
	// Set the high-water mark to a post id with a higher on-chain number than
	// base-1 ("base-1" has on-chain part "1"; "base-2" has "2" > "1"), so that
	// base-1 is NOT new when polled.
	st.SetLastSeen("base", "base-2")
	// base-1 is intentionally absent from the Posts map.

	bot := &stubBot{}
	// Serve an "amended" base-1 (ActionCount=2) — not new, not in the map.
	gql := &stubGQL{posts: []graphql.Post{amendedPost()}}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	edits := len(bot.edits)
	bot.mu.Unlock()

	if sends != 1 {
		t.Errorf("expected 1 fresh send for unmapped amended post, got %d", sends)
	}
	if edits != 0 {
		t.Errorf("expected 0 edits for unmapped post, got %d", edits)
	}
}

// TestPollOnce_UnchangedPostIsNotReprocessed ensures that a post the notifier
// already published, with the same ActionCount and LastUpdatedAt, is not
// re-sent or re-edited (it is neither new nor changed).
func TestPollOnce_UnchangedPostIsNotReprocessed(t *testing.T) {
	pub := basePost()
	// Store already has the post, same snapshot.
	st := populatedStore("base-1", 99, pub)

	bot := &stubBot{}
	// Return the exact same post — no change.
	gql := &stubGQL{posts: []graphql.Post{pub}}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	edits := len(bot.edits)
	bot.mu.Unlock()

	if sends != 0 {
		t.Errorf("expected 0 sends for unchanged post, got %d", sends)
	}
	if edits != 0 {
		t.Errorf("expected 0 edits for unchanged post, got %d", edits)
	}
}

// TestPollOnce_PreN2BackfillThenDetect verifies the pre-N2 back-fill path:
//
//   - Poll 1: base-1 is in the Posts map but with a zero-value snapshot
//     (LastActionCount==0, LastUpdatedAt==""), simulating a post that existed
//     before N2 deployed. The snapshot must be back-filled to the current
//     on-chain values; no Telegram edit must be issued.
//   - Poll 2: the same post returns with a changed ActionCount/LastUpdatedAt
//     (an on-chain amendment). This time the snapshot exists and differs →
//     the existing Telegram message must be edited in place.
func TestPollOnce_PreN2BackfillThenDetect(t *testing.T) {
	// Arrange: base-1 is mapped (has a tg_message_id) but has a zero-value
	// snapshot — exactly what every N1 post looks like right after N2 deploys.
	st := store.NewInMemory()
	st.RegisterPost("base-1", 42, "base")
	st.SetLastSeen("base", "base-1")
	// Deliberately NOT calling UpdatePostSnapshot — snapshot stays {0, ""}.

	bot := &stubBot{}
	// Poll 1 returns base-1 with ActionCount=1 (unchanged on-chain).
	p1 := basePost() // ActionCount=1
	gql := &stubGQL{posts: []graphql.Post{p1}}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	// --- Poll 1: back-fill, no edit ---
	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends1 := len(bot.sends)
	edits1 := len(bot.edits)
	bot.mu.Unlock()

	if sends1 != 0 {
		t.Errorf("poll 1: expected 0 sends (back-fill only), got %d", sends1)
	}
	if edits1 != 0 {
		t.Errorf("poll 1: expected 0 edits (back-fill only), got %d", edits1)
	}

	// --- Poll 2: amended post → edit in place ---
	gql.mu.Lock()
	gql.posts = []graphql.Post{amendedPost()} // ActionCount=2, new LastUpdatedAt
	gql.mu.Unlock()

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends2 := len(bot.sends)
	edits2 := len(bot.edits)
	var editedMsgID int64
	if edits2 > 0 {
		editedMsgID = bot.edits[0].messageID
	}
	bot.mu.Unlock()

	if sends2 != 0 {
		t.Errorf("poll 2: expected 0 sends (edit in place), got %d", sends2)
	}
	if edits2 != 1 {
		t.Errorf("poll 2: expected 1 edit after amendment, got %d", edits2)
	}
	if editedMsgID != 42 {
		t.Errorf("poll 2: expected edit on message_id=42, got %d", editedMsgID)
	}
}

// TestPollOnce_AmendEditMissingPostStateReturnsError was previously guarding
// against amendEdit silently zeroing vote counts when PostState was absent.
// The vote subsystem has been removed (issue #181); amendEdit no longer reads
// PostState and so this guard clause is no longer needed. Test retained as a
// documented tombstone.
func TestPollOnce_AmendEditMissingPostStateReturnsError(t *testing.T) {
	t.Skip("vote subsystem removed (#181): PostState guard in amendEdit no longer exists")
}

// ---- N3: retract handling tests --------------------------------------------
//
// N3 retract detection uses the per-chain postById query, NOT the unified
// posts feed. The gateway's posts(...) feed permanently excludes retracted
// posts (removed_eq: false filter). The checkRetracts pass in PollOnce calls
// PostById for each stored, non-retracted post to detect the removed flag.
//
// Test strategy: populate the store with a known post, configure stubGQL's
// postByIdFn to return removed=true for that post's (chain, onchainID), then
// call PollOnce and assert that retractEdit fired exactly once on the correct
// message id.

// retractedPostByIdResult returns a PostByIdResult with Removed=true and the
// title from basePost, matching what the real postById query would return.
func retractedPostByIdResult() *graphql.PostByIdResult {
	return &graphql.PostByIdResult{
		Removed: true,
		Title:   "Butter Bridge Hack",
	}
}

// TestPollOnce_RetractEditsMessageToRetractedState is the primary N3 acceptance
// criterion: a retracted post (detected via postById) that is in the store must
// trigger an in-place edit of the existing Telegram message to the RETRACTED
// state, not a new send.
func TestPollOnce_RetractEditsMessageToRetractedState(t *testing.T) {
	pub := basePost()
	st := populatedStore("base-1", 55, pub)

	bot := &stubBot{}
	gql := &stubGQL{
		posts: []graphql.Post{}, // feed is empty — retracted post is absent from feed
		postByIdFn: func(chainSlug, onchainID string) (*graphql.PostByIdResult, error) {
			if chainSlug == "base" && onchainID == "1" {
				return retractedPostByIdResult(), nil
			}
			return nil, nil
		},
	}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	edits := len(bot.edits)
	var editMsgID int64
	var editText string
	if edits > 0 {
		editMsgID = bot.edits[0].messageID
		editText = bot.edits[0].text
	}
	bot.mu.Unlock()

	// No new message — must edit in place.
	if sends != 0 {
		t.Errorf("retract: expected 0 sends, got %d", sends)
	}
	if edits != 1 {
		t.Errorf("retract: expected 1 edit, got %d", edits)
	}
	// Edit must target the stored message id.
	if editMsgID != 55 {
		t.Errorf("retract: expected edit on message_id=55, got %d", editMsgID)
	}
	// The edited text must contain "RETRACTED" with struck-through formatting.
	if !strings.Contains(editText, "RETRACTED") {
		t.Errorf("retract: edited message must contain RETRACTED, got:\n%s", editText)
	}
}

// TestPollOnce_RetractNeverDeletesMessage verifies the auditable-channel
// guarantee: the notifier never calls DeleteMessage for a retracted post.
// The stubBot does not implement DeleteMessage; if the service calls it the
// compiler would catch it (interface mismatch), so this test documents the
// constraint in test form rather than catching a runtime panic.
//
// The real assertion here is: the edit count is 1 (message updated to RETRACTED)
// and the send count is 0 (no new message posted as a "replacement").
func TestPollOnce_RetractNeverDeletesMessage(t *testing.T) {
	pub := basePost()
	st := populatedStore("base-1", 77, pub)

	bot := &stubBot{}
	gql := &stubGQL{
		posts: []graphql.Post{},
		postByIdFn: func(chainSlug, onchainID string) (*graphql.PostByIdResult, error) {
			if chainSlug == "base" && onchainID == "1" {
				return retractedPostByIdResult(), nil
			}
			return nil, nil
		},
	}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	deletes := bot.deletes
	sends := len(bot.sends)
	edits := len(bot.edits)
	bot.mu.Unlock()

	// Channel must stay auditable: no deletes.
	if deletes != 0 {
		t.Errorf("retract: message must never be deleted, got %d delete calls", deletes)
	}
	// Edit happened, no fresh send.
	if edits != 1 {
		t.Errorf("retract: expected 1 edit (RETRACTED state), got %d", edits)
	}
	if sends != 0 {
		t.Errorf("retract: expected 0 sends, got %d", sends)
	}
}

// TestPollOnce_RetractUnmappedPostIsNoOp verifies that a retracted post with
// no stored Telegram message_id is a no-op — no edit, no send, no delete.
// postById may return removed=true, but without a stored message_id there is
// nothing to edit; posting a fresh "retracted" message would be channel noise.
func TestPollOnce_RetractUnmappedPostIsNoOp(t *testing.T) {
	// The store knows about a different post ("base-2") so the high-water mark
	// for the chain is above base-1's on-chain id, making base-1 not-new.
	// base-1 is NOT in the Posts map — StoredPosts() will not return it.
	st := store.NewInMemory()
	st.SetLastSeen("base", "base-2")

	bot := &stubBot{}
	gql := &stubGQL{
		posts: []graphql.Post{},
		// Even if postById would return removed=true for base-1, the store
		// doesn't have base-1 in its Posts map, so checkRetracts never calls
		// PostById for it — StoredPosts only returns posts the notifier has
		// already published. No postByIdFn needed.
		postByIdFn: nil,
	}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	edits := len(bot.edits)
	deletes := bot.deletes
	bot.mu.Unlock()

	if sends != 0 {
		t.Errorf("retract unmapped: expected 0 sends, got %d", sends)
	}
	if edits != 0 {
		t.Errorf("retract unmapped: expected 0 edits, got %d", edits)
	}
	if deletes != 0 {
		t.Errorf("retract unmapped: expected 0 deletes, got %d", deletes)
	}
}

// TestPollOnce_RetractIsIdempotent verifies that repeated polls on an already-
// retracted post do not trigger additional edits. The RETRACTED edit happens
// exactly once; subsequent polls on the same post are no-ops because StoredPosts
// excludes already-retracted posts.
func TestPollOnce_RetractIsIdempotent(t *testing.T) {
	pub := basePost()
	st := populatedStore("base-1", 88, pub)

	bot := &stubBot{}
	gql := &stubGQL{
		posts: []graphql.Post{},
		postByIdFn: func(chainSlug, onchainID string) (*graphql.PostByIdResult, error) {
			if chainSlug == "base" && onchainID == "1" {
				return retractedPostByIdResult(), nil
			}
			return nil, nil
		},
	}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	// Poll 1 — retract is applied.
	svc.PollOnce(context.Background())

	bot.mu.Lock()
	edits1 := len(bot.edits)
	bot.mu.Unlock()

	if edits1 != 1 {
		t.Fatalf("retract idempotency: expected 1 edit on first poll, got %d", edits1)
	}

	// Poll 2 — same post is still retracted. StoredPosts excludes it (Retracted=true).
	// PostById must NOT be called again; no additional edit.
	svc.PollOnce(context.Background())

	bot.mu.Lock()
	edits2 := len(bot.edits)
	sends2 := len(bot.sends)
	bot.mu.Unlock()

	if edits2 != 1 {
		t.Errorf("retract idempotency: expected still 1 edit after second poll, got %d", edits2)
	}
	if sends2 != 0 {
		t.Errorf("retract idempotency: expected 0 sends on second poll, got %d", sends2)
	}
}

// TestPollOnce_PreN3BackfillChainSlug verifies that a mapped pre-N3 post whose
// stored ChainSlug is "" (every post published before N3 deployed) gets its
// ChainSlug back-filled from the feed on the next poll, making it visible to
// StoredPosts and therefore to checkRetracts.
//
// Two-poll sequence:
//   - Poll 1: post appears in the feed, is mapped but has ChainSlug=="".
//     PollOnce must write the ChainSlug from p.Chain.Slug to the store.
//     StoredPosts must return the post after this poll.
//   - Poll 2: feed is empty (post retracted, filtered out by gateway); postById
//     returns removed=true. checkRetracts must now detect the retract and edit
//     the message to RETRACTED state.
func TestPollOnce_PreN3BackfillChainSlug(t *testing.T) {
	// Arrange: store has base-1 mapped with NO ChainSlug (pre-N3 state).
	// We use NewInMemory + RegisterPost with an empty slug to simulate
	// a post that was published before N3 deployed.
	st := store.NewInMemory()
	st.RegisterPost("base-1", 55, "") // empty slug — pre-N3 backlog
	st.SetLastSeen("base", "base-1")
	st.UpdatePostSnapshot("base-1", basePost().ActionCount, basePost().LastUpdatedAt)

	// Verify precondition: StoredPosts skips the post because ChainSlug=="".
	if got := st.StoredPosts(); len(got) != 0 {
		t.Fatalf("precondition failed: expected StoredPosts to be empty before back-fill, got %d entries", len(got))
	}

	bot := &stubBot{}
	// Poll 1 feed: post is still live (not yet retracted) — appears in feed.
	gql := &stubGQL{
		posts: []graphql.Post{basePost()},
		// postById not called in poll 1 because StoredPosts is empty pre-back-fill.
		postByIdFn: nil,
	}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	// --- Poll 1: back-fill ChainSlug ---
	svc.PollOnce(context.Background())

	// After poll 1, StoredPosts must include base-1 (ChainSlug was back-filled).
	stored := st.StoredPosts()
	if len(stored) != 1 {
		t.Fatalf("poll 1: expected StoredPosts to have 1 entry after back-fill, got %d", len(stored))
	}
	if stored[0].PostID != "base-1" {
		t.Errorf("poll 1: expected stored post id 'base-1', got %q", stored[0].PostID)
	}
	if stored[0].ChainSlug != "base" {
		t.Errorf("poll 1: expected stored ChainSlug 'base', got %q", stored[0].ChainSlug)
	}

	// No Telegram activity on poll 1 — back-fill is a store-only operation.
	bot.mu.Lock()
	sends1 := len(bot.sends)
	edits1 := len(bot.edits)
	bot.mu.Unlock()
	if sends1 != 0 {
		t.Errorf("poll 1: expected 0 sends (back-fill only), got %d", sends1)
	}
	if edits1 != 0 {
		t.Errorf("poll 1: expected 0 edits (back-fill only), got %d", edits1)
	}

	// --- Poll 2: post retracted — checkRetracts must detect and edit ---
	gql.mu.Lock()
	gql.posts = []graphql.Post{} // post is gone from feed (filtered by gateway)
	gql.postByIdFn = func(chainSlug, onchainID string) (*graphql.PostByIdResult, error) {
		if chainSlug == "base" && onchainID == "1" {
			return retractedPostByIdResult(), nil
		}
		return nil, nil
	}
	gql.mu.Unlock()

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	edits2 := len(bot.edits)
	var editMsgID int64
	var editText string
	if edits2 > 0 {
		editMsgID = bot.edits[0].messageID
		editText = bot.edits[0].text
	}
	bot.mu.Unlock()

	if edits2 != 1 {
		t.Errorf("poll 2: expected 1 retract edit after back-fill, got %d", edits2)
	}
	if editMsgID != 55 {
		t.Errorf("poll 2: expected edit on message_id=55, got %d", editMsgID)
	}
	if !strings.Contains(editText, "RETRACTED") {
		t.Errorf("poll 2: edited message must contain RETRACTED, got:\n%s", editText)
	}
}

// TestPollOnce_RetractClearsKeyboard verifies that the retract edit explicitly
// sends an empty InlineKeyboardMarkup rather than nil. Passing nil to
// EditMessageText would omit reply_markup from the request body (omitempty),
// causing Telegram to leave any existing keyboard intact on the retracted
// message. An explicitly empty keyboard guarantees the message is button-free
// after retraction — important for any message that still carries a legacy
// keyboard from before the vote subsystem was removed (#181).
func TestPollOnce_RetractClearsKeyboard(t *testing.T) {
	pub := basePost()
	st := populatedStore("base-1", 100, pub)

	bot := &stubBot{}
	gql := &stubGQL{
		posts: []graphql.Post{},
		postByIdFn: func(chainSlug, onchainID string) (*graphql.PostByIdResult, error) {
			if chainSlug == "base" && onchainID == "1" {
				return retractedPostByIdResult(), nil
			}
			return nil, nil
		},
	}

	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	edits := bot.edits
	bot.mu.Unlock()

	if len(edits) != 1 {
		t.Fatalf("retract keyboard: expected 1 edit, got %d", len(edits))
	}

	kb := edits[0].keyboard
	// keyboard must be non-nil — a nil keyboard (omitempty) would leave any
	// existing keyboard intact on the Telegram message.
	if kb == nil {
		t.Fatalf("retract keyboard: EditMessageText must receive a non-nil keyboard to clear any legacy buttons; got nil")
	}
	// The keyboard must have zero rows — an explicit empty InlineKeyboardMarkup.
	if len(kb.InlineKeyboard) != 0 {
		t.Errorf("retract keyboard: expected 0 keyboard rows (empty), got %d", len(kb.InlineKeyboard))
	}
}

// ---- issue #236: isNew numeric compare tests --------------------------------
//
// These tests are driven through PollOnce because isNew is unexported. The
// load-bearing assertion in each case is the send/edit count: a correct numeric
// compare means post #10 IS new when last-seen is #9 (→ 1 send); a broken lex
// compare means post #10 is NOT new (→ 0 sends, falls into State-5 fallback).
//
// We explicitly check that the send count is 1 AND that SetLastSeen advanced the
// high-water mark, because the fallback path (State 5) would also produce 1 send
// but would NOT advance the high-water mark. That distinction is how we prove
// isNew returned true (State 1) versus the fallback (State 5).

// makeEthPost builds a minimal graphql.Post on the "ethereum" chain with the
// given composite id (e.g. "ethereum-10").
func makeEthPost(id string) graphql.Post {
	return graphql.Post{
		ID:                 id,
		Chain:              graphql.Chain{ChainID: 1, Slug: "ethereum", Name: "Ethereum"},
		Poster:             "0xbbbb",
		Title:              "Test Hack",
		Note:               "summary: test\nchains: ethereum\ntxs: 0x1\nsources: @rekt",
		ActionCount:        1,
		LastUpdatedAt:      "2026-06-01T00:00:00Z",
		CreatedAtTimestamp: "2026-06-01T00:00:00Z",
		Attackers:          []string{"0x2222222222222222222222222222222222222222"},
	}
}

// makeSvc returns a Service configured with an in-memory store pre-seeded with
// the given last-seen id for the "ethereum" chain.
func makeSvc(t *testing.T, lastSeenID string, postToServe graphql.Post) (*notifier.Service, *stubBot, *store.Store) {
	t.Helper()
	st := store.NewInMemory()
	if lastSeenID != "" {
		st.SetLastSeen("ethereum", lastSeenID)
	}
	bot := &stubBot{}
	gql := &stubGQL{posts: []graphql.Post{postToServe}}
	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}
	return svc, bot, st
}

// TestIsNew_SingleToDoubleDigitBoundary_IsNew is the load-bearing regression
// test for issue #236. Post #10 with last-seen #9 MUST be treated as new
// (numeric 10 > 9). With the old lexicographic compare "10" > "9" is false,
// so this test fails against the unfixed code.
func TestIsNew_SingleToDoubleDigitBoundary_IsNew(t *testing.T) {
	post := makeEthPost("ethereum-10")
	svc, bot, st := makeSvc(t, "ethereum-9", post)

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	bot.mu.Unlock()

	// Must have published exactly one new message (State 1, not State 5 fallback).
	if sends != 1 {
		t.Errorf("isNew boundary: expected 1 send for ethereum-10 > ethereum-9, got %d (lex compare bug?)", sends)
	}

	// High-water mark must have advanced to ethereum-10 (State 1 path).
	// State-5 fallback also sends but does NOT call SetLastSeen.
	if got := st.LastSeen("ethereum"); got != "ethereum-10" {
		t.Errorf("isNew boundary: expected lastSeen to advance to ethereum-10, got %q", got)
	}
}

// TestIsNew_SingleToDoubleDigitBoundary_NotNew is the inverse: post #9 with
// last-seen #10 must NOT be treated as new (9 < 10 numerically).
func TestIsNew_SingleToDoubleDigitBoundary_NotNew(t *testing.T) {
	// We need a mapped post for State 3 (not new, mapped, unchanged) so that
	// PollOnce doesn't fall through to the State-5 fallback and send anyway.
	st := store.NewInMemory()
	st.SetLastSeen("ethereum", "ethereum-10")
	post9 := makeEthPost("ethereum-9")
	// Register the post in the store so PollOnce reaches State 3 (skip).
	st.RegisterPost("ethereum-9", 99, "ethereum")
	st.UpdatePostSnapshot("ethereum-9", post9.ActionCount, post9.LastUpdatedAt)

	bot := &stubBot{}
	gql := &stubGQL{posts: []graphql.Post{post9}}
	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	edits := len(bot.edits)
	bot.mu.Unlock()

	if sends != 0 {
		t.Errorf("isNew inverse: expected 0 sends for ethereum-9 when last-seen is ethereum-10, got %d", sends)
	}
	if edits != 0 {
		t.Errorf("isNew inverse: expected 0 edits (post is unchanged), got %d", edits)
	}
}

// TestIsNew_MultiDigitOrdering exercises the full single→double→triple digit
// range. Each step: poll a post whose id is one step ahead of last-seen and
// assert it is treated as new. This catches regressions where numeric ordering
// is correct for 9→10 but breaks for 10→11, 11→100, etc.
func TestIsNew_MultiDigitOrdering(t *testing.T) {
	cases := []struct {
		lastSeen string
		postID   string
	}{
		{"ethereum-9", "ethereum-10"},
		{"ethereum-10", "ethereum-11"},
		{"ethereum-11", "ethereum-100"},
		{"ethereum-99", "ethereum-100"},
		{"ethereum-100", "ethereum-101"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.lastSeen+"_to_"+tc.postID, func(t *testing.T) {
			post := makeEthPost(tc.postID)
			svc, bot, st := makeSvc(t, tc.lastSeen, post)

			svc.PollOnce(context.Background())

			bot.mu.Lock()
			sends := len(bot.sends)
			bot.mu.Unlock()

			if sends != 1 {
				t.Errorf("multi-digit: expected 1 send (%s > %s), got %d", tc.postID, tc.lastSeen, sends)
			}
			if got := st.LastSeen("ethereum"); got != tc.postID {
				t.Errorf("multi-digit: expected lastSeen=%s, got %q", tc.postID, got)
			}
		})
	}
}

// TestIsNew_MalformedIDFallbackNoPanic verifies that malformed / non-numeric id
// portions do not panic and fall back gracefully to string compare. A malformed
// id is any id whose trailing part (after the last "-") is not a base-10 int.
func TestIsNew_MalformedIDFallbackNoPanic(t *testing.T) {
	cases := []struct {
		name     string
		lastSeen string
		postID   string
		wantNew  bool
	}{
		// Lexicographic: "z" > "a" → true. Both non-numeric → string fallback.
		{
			name:     "both_non_numeric_greater",
			lastSeen: "ethereum-abc",
			postID:   "ethereum-xyz",
			wantNew:  true,
		},
		// Lexicographic: "a" > "z" → false. Both non-numeric → string fallback.
		{
			name:     "both_non_numeric_lesser",
			lastSeen: "ethereum-xyz",
			postID:   "ethereum-abc",
			wantNew:  false,
		},
		// postID has no "-" separator → onchainPart returns whole id.
		// Both onchainParts are non-numeric: "malformedid" vs "1" (numeric, but
		// postID part is non-numeric). Falls back to string compare. Should not panic.
		// "malformedid" > "1" is true lex ('m' > '1'), so isNew → true → 1 send.
		{
			name:     "no_separator_in_post_id",
			lastSeen: "ethereum-1",
			postID:   "malformedid",
			wantNew:  true, // "malformedid" > "1" lex; primary check is no panic
		},
		// lastSeen has no separator. onchainPart returns the whole id. No panic.
		// "2" > "malformed" is false lex ('2' < 'm'), so isNew → false → 0 sends.
		{
			name:     "no_separator_in_last_seen",
			lastSeen: "malformed",
			postID:   "ethereum-2",
			wantNew:  false, // "2" < "malformed" lex; primary check is no panic
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			// For the "not new" cases we need the post in the store to avoid
			// the State-5 fallback sending unconditionally.
			st := store.NewInMemory()
			if tc.lastSeen != "" {
				st.SetLastSeen("ethereum", tc.lastSeen)
			}
			post := makeEthPost(tc.postID)
			if !tc.wantNew {
				// Register the post so State-3 (skip) fires instead of State-5 send.
				st.RegisterPost(tc.postID, 1, "ethereum")
				st.UpdatePostSnapshot(tc.postID, post.ActionCount, post.LastUpdatedAt)
			}

			bot := &stubBot{}
			gql := &stubGQL{posts: []graphql.Post{post}}
			svc := &notifier.Service{
				GQL:       gql,
				Bot:       bot,
				Store:     st,
				ChannelID: "@testchan",
				SiteURL:   "https://thatsrekt.com",
				Logger:    makeTestLogger(),
			}

			// The primary assertion is "does not panic". We also check send
			// count for cases where the expected behaviour is deterministic.
			svc.PollOnce(context.Background())

			bot.mu.Lock()
			sends := len(bot.sends)
			bot.mu.Unlock()

			if tc.wantNew && sends == 0 {
				t.Errorf("malformed fallback %s: expected a send (isNew=true), got 0", tc.name)
			}
			if !tc.wantNew && sends != 0 {
				t.Errorf("malformed fallback %s: expected 0 sends (isNew=false), got %d", tc.name, sends)
			}
		})
	}
}

// TestIsNew_PerChainIsolation verifies that the last-seen high-water mark is
// per chain: ethereum-9 as last-seen for "ethereum" must not affect the
// "base" chain, and vice versa. A post on "base-10" is new regardless of
// what ethereum's last-seen value is.
func TestIsNew_PerChainIsolation(t *testing.T) {
	st := store.NewInMemory()
	// Seed ethereum with a high-water mark of ethereum-100.
	st.SetLastSeen("ethereum", "ethereum-100")
	// base chain has no entry — first post should be treated as new.

	post := graphql.Post{
		ID:                 "base-1",
		Chain:              graphql.Chain{ChainID: 8453, Slug: "base", Name: "Base"},
		Poster:             "0xcccc",
		Title:              "Base Chain Post",
		Note:               "summary: test\nchains: base\ntxs: 0x2\nsources: @rekt",
		ActionCount:        1,
		LastUpdatedAt:      "2026-06-01T00:00:00Z",
		CreatedAtTimestamp: "2026-06-01T00:00:00Z",
		Attackers:          []string{"0x3333333333333333333333333333333333333333"},
	}

	bot := &stubBot{}
	gql := &stubGQL{posts: []graphql.Post{post}}
	svc := &notifier.Service{
		GQL:       gql,
		Bot:       bot,
		Store:     st,
		ChannelID: "@testchan",
		SiteURL:   "https://thatsrekt.com",
		Logger:    makeTestLogger(),
	}

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	bot.mu.Unlock()

	// base-1 is new for the base chain (no prior last-seen entry).
	if sends != 1 {
		t.Errorf("per-chain isolation: expected 1 send for base-1 (base chain fresh), got %d", sends)
	}
	// ethereum high-water mark must be unchanged.
	if got := st.LastSeen("ethereum"); got != "ethereum-100" {
		t.Errorf("per-chain isolation: ethereum last-seen should be unchanged, got %q", got)
	}
	// base high-water mark must have advanced to base-1.
	if got := st.LastSeen("base"); got != "base-1" {
		t.Errorf("per-chain isolation: base last-seen should be base-1, got %q", got)
	}
}

// TestIsNew_EmptyLastSeen verifies the unchanged behaviour: when no last-seen
// exists for a chain, every post on that chain is treated as new.
func TestIsNew_EmptyLastSeen(t *testing.T) {
	post := makeEthPost("ethereum-1")
	svc, bot, st := makeSvc(t, "", post)

	svc.PollOnce(context.Background())

	bot.mu.Lock()
	sends := len(bot.sends)
	bot.mu.Unlock()

	if sends != 1 {
		t.Errorf("empty last-seen: expected 1 send for first post on fresh chain, got %d", sends)
	}
	if got := st.LastSeen("ethereum"); got != "ethereum-1" {
		t.Errorf("empty last-seen: expected lastSeen=ethereum-1, got %q", got)
	}
}
