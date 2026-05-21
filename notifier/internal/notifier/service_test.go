// Package notifier_test — service-level tests for amendment handling (N2).
//
// These tests exercise the poll loop's amendment path through stub
// implementations of the Telegram bot and GraphQL client. No network, no S3.
//
// Covered acceptance criteria (issue #128):
//   - Amendment edits the existing Telegram message via the stored tg_message_id;
//     no new message is posted.
//   - The edited message reflects the new content and an incremented rev N.
//   - A changed post with no stored message falls back to a fresh publish.
package notifier_test

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/notifier"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

// ---- stubs ---------------------------------------------------------------

// stubGQL implements notifier.GQLClient. It serves a fixed slice of posts.
type stubGQL struct {
	mu    sync.Mutex
	posts []graphql.Post
}

func (g *stubGQL) LatestPosts(_ context.Context, _ int) ([]graphql.Post, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]graphql.Post, len(g.posts))
	copy(out, g.posts)
	return out, nil
}

// stubBot implements notifier.TelegramBot. It records sends and edits.
type stubBot struct {
	mu      sync.Mutex
	sends   []sendCall
	edits   []editCall
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
}

func (b *stubBot) SendMessage(_ context.Context, chatID, text string, _ *telegram.InlineKeyboardMarkup) (int64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.nextID++
	b.sends = append(b.sends, sendCall{chatID: chatID, text: text})
	return b.nextID, nil
}

func (b *stubBot) EditMessageText(_ context.Context, chatID string, messageID int64, text string, _ *telegram.InlineKeyboardMarkup) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.edits = append(b.edits, editCall{chatID: chatID, messageID: messageID, text: text})
	return nil
}

func (b *stubBot) EditReplyMarkup(_ context.Context, _ string, _ int64, _ *telegram.InlineKeyboardMarkup) error {
	return nil
}

func (b *stubBot) GetUpdates(_ context.Context, _ int64, _ time.Duration) ([]telegram.Update, error) {
	// Never returns updates during tests — callbacks not under test here.
	select {}
}

func (b *stubBot) AnswerCallback(_ context.Context, _, _ string) error { return nil }

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
	st.RegisterPost(postID, msgID)
	st.SetLastSeen(p.Chain.Slug, postID)
	st.UpdatePostSnapshot(postID, p.ActionCount, p.LastUpdatedAt)
	return st
}

// ---- tests -----------------------------------------------------------------

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
	if !containsString(editedText, "rev 2") {
		t.Errorf("expected edited message to contain 'rev 2', got:\n%s", editedText)
	}
}

// TestPollOnce_UnmappedAmendedPostFallsBackToSend covers the case where the
// post has changed (different ActionCount / LastUpdatedAt) but the notifier
// has no stored message_id for it (e.g. it started after the post was
// created). It must fall back to a fresh publish.
func TestPollOnce_UnmappedAmendedPostFallsBackToSend(t *testing.T) {
	// Store is empty — notifier has never seen base-1.
	st := store.NewInMemory()

	bot := &stubBot{}
	// We serve an "amended" post (ActionCount=2) that the store doesn't know.
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

// containsString is a helper for assertions without importing testing/strings
// at package scope.
func containsString(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}
