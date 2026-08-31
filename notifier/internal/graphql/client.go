// Package graphql — minimal client for the thatsRekt Mesh stitching gateway.
//
// We only call one operation: `posts(limit, offset, chains)` which returns
// the cross-chain unified feed shape. Per-chain stitching happens upstream —
// from this client's perspective, posts on every supported chain look the
// same and get appended to the channel as they appear.
package graphql

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Post mirrors the subset of the unified `posts.items[]` shape we need to
// render a Telegram message. Match field names exactly to the GraphQL
// response so json.Decode handles the mapping.
//
// v2 additions:
//   - ActionCount — the count of on-chain actions for this post
//     (1 createPost + N-1 amendments). Used to derive "rev N" in the
//     Telegram message without storing a separate revision field.
//     NOTE: ActionCount requires the indexer/mesh to expose this field
//     (see GraphQL indexer dependency note in LatestPosts). Zero-value
//     (0) is treated as "unknown" and the notifier renders "rev 1" as
//     the safe default.
//   - LastUpdatedAt — ISO-8601 timestamp of the most recent on-chain
//     action (createPost or amendment). Used in the "updated · rev N"
//     line of the message.
type Post struct {
	ID                 string   `json:"id"` // composite: `{chainSlug}-{onchainId}`
	Chain              Chain    `json:"chain"`
	Poster             string   `json:"poster"`
	Title              string   `json:"title"`
	Note               string   `json:"note"`
	Confirmations      int      `json:"confirmations"`
	Disconfirmations   int      `json:"disconfirmations"`
	NetScore           int      `json:"netScore"`
	CreatedAtTimestamp string   `json:"createdAtTimestamp"`
	AttackedAt         string   `json:"attackedAt"`
	Attackers          []string `json:"attackers"`
	Victims            []string `json:"victims"`

	// v2: action count used to derive revision number (rev = ActionCount),
	// and to detect amendments between polls (a change in ActionCount or
	// LastUpdatedAt signals an on-chain amendment).
	// Exposed by the Mesh since ThatsRekt/thatsRekt#132 / PR #133.
	// Zero-value (0) is the safe fallback: the notifier renders "rev 1".
	ActionCount int `json:"actionCount"`

	// v2: ISO-8601 timestamp of the latest on-chain write for this post.
	// Used alongside ActionCount for amendment change-detection.
	LastUpdatedAt string `json:"lastUpdatedAt"`

	// v2 (N3): set to true when a PostRemoved event has been indexed for
	// this post. The notifier uses the false→true transition to edit the
	// Telegram message to a struck-through RETRACTED state.
	// NOTE: PostRemoved does NOT bump ActionCount or LastUpdatedAt — it is
	// a removal path, not an amendment. N3 therefore adds Removed as its
	// own independent change-detection signal (see PollOnce state 6).
	Removed bool `json:"removed"`
}

type Chain struct {
	ChainID int    `json:"chainId"`
	Slug    string `json:"slug"`
	Name    string `json:"name"`
}

// Client is a thin HTTP wrapper. Single endpoint; persistent http.Client
// with sane timeouts so a hung gateway doesn't stall the poll loop forever.
type Client struct {
	URL  string
	HTTP *http.Client
	pace *requestPacer
}

// NewClient creates the notifier's single GraphQL client. Every request made
// through the client shares the supplied total rate limit.
func NewClient(url string, requestsPerSecond int) *Client {
	return newClient(
		url,
		&http.Client{Timeout: 30 * time.Second}, // ample for cross-chain stitching
		requestsPerSecond,
		time.Now,
		waitFor,
	)
}

// newClient makes clock and wait behavior injectable so pacing can be tested
// without wall-clock sleeps.
func newClient(
	url string,
	httpClient *http.Client,
	requestsPerSecond int,
	now func() time.Time,
	wait func(context.Context, time.Duration) error,
) *Client {
	if requestsPerSecond <= 0 {
		panic("GraphQL requests per second must be positive")
	}
	interval := time.Second / time.Duration(requestsPerSecond)
	if interval <= 0 {
		panic("GraphQL requests per second exceeds supported precision")
	}
	return &Client{
		URL:  url,
		HTTP: httpClient,
		pace: newRequestPacer(interval, now, wait),
	}
}

type requestPacer struct {
	mu       sync.Mutex
	tail     chan struct{}
	next     time.Time
	interval time.Duration
	now      func() time.Time
	wait     func(context.Context, time.Duration) error
}

func newRequestPacer(
	interval time.Duration,
	now func() time.Time,
	wait func(context.Context, time.Duration) error,
) *requestPacer {
	tail := make(chan struct{})
	close(tail)
	return &requestPacer{
		tail:     tail,
		interval: interval,
		now:      now,
		wait:     wait,
	}
}

// Do reserves the next request turn, paces it, and performs the HTTP dispatch
// before the following caller can start. It never holds a mutex while waiting.
func (p *requestPacer) Do(
	ctx context.Context,
	dispatch func() (*http.Response, error),
) (*http.Response, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	p.mu.Lock()
	previous := p.tail
	turnDone := make(chan struct{})
	p.tail = turnDone
	p.mu.Unlock()

	select {
	case <-previous:
	case <-ctx.Done():
		go func() {
			<-previous
			close(turnDone)
		}()
		return nil, ctx.Err()
	}
	defer close(turnDone)

	p.mu.Lock()
	now := p.now()
	at := p.next
	if at.Before(now) {
		at = now
	}
	p.mu.Unlock()

	if delay := at.Sub(now); delay > 0 {
		if err := p.wait(ctx, delay); err != nil {
			return nil, err
		}
	}

	resp, err := dispatch()

	p.mu.Lock()
	p.next = p.now().Add(p.interval)
	p.mu.Unlock()

	return resp, err
}

func waitFor(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// chainEntry is the single source of truth for one chain the notifier supports.
// Both the slug-to-prefix lookup map and the SupportedChainSlugs list are derived
// from chainConfig at init time — never written separately.
//
// To add a chain:
//  1. Add a single entry to chainConfig below.
//  2. Run `go test ./internal/graphql/...` — the chain coverage test will turn GREEN.
//
// If you add a chain to mesh/src/chains.ts but forget to add it here, the test
// TestChainCoverage_AllMeshChainsCoveredByNotifier fails in CI. If you leave the
// Prefix empty, init() panics at startup.
type chainEntry struct {
	slug   string
	prefix string
}

// chainConfig is the ONLY place chains are declared in the Go notifier.
// Do NOT modify chainSlugToPrefix or SupportedChainSlugs directly — they are
// derived from this slice by init() and are read-only after that point.
//
// Prefix values must match the RenameRootFields transformer in mesh/src/chains.ts
// (field: prefix). Example: slug "base" → prefix "Base_" → GraphQL query field
// "Base_postById(id: "42") { removed title }".
var chainConfig = []chainEntry{
	{"anvil-eth", "AnvilEth_"},
	{"anvil-base", "AnvilBase_"},
	{"sepolia", "Sepolia_"},
	{"ethereum", "Ethereum_"},
	{"base", "Base_"},
	{"base-sepolia", "BaseSepolia_"},
	{"optimism", "Optimism_"},
	{"arbitrum", "Arbitrum_"},
	{"bsc", "Bsc_"},         // added 2026-07-13: fix issue #256
	{"polygon", "Polygon_"}, // added 2026-07-13: fix issue #256
}

// chainSlugToPrefix is built from chainConfig at init time.
// Use PrefixForChain to look up entries — do not access this map directly from
// outside this package.
var chainSlugToPrefix map[string]string

// SupportedChainSlugs is the authoritative list of chain slugs this notifier
// understands, in the order declared in chainConfig. Exported so tests can
// iterate it to verify coverage against external registries (mesh/src/chains.ts).
var SupportedChainSlugs []string

func init() {
	chainSlugToPrefix = make(map[string]string, len(chainConfig))
	SupportedChainSlugs = make([]string, 0, len(chainConfig))
	for _, e := range chainConfig {
		if e.slug == "" || e.prefix == "" {
			panic(fmt.Sprintf(
				"thatsrekt-notifier: chainConfig entry {slug:%q prefix:%q} has empty field — fix notifier/internal/graphql/client.go",
				e.slug, e.prefix,
			))
		}
		if _, dup := chainSlugToPrefix[e.slug]; dup {
			panic(fmt.Sprintf(
				"thatsrekt-notifier: duplicate slug %q in chainConfig — fix notifier/internal/graphql/client.go",
				e.slug,
			))
		}
		chainSlugToPrefix[e.slug] = e.prefix
		SupportedChainSlugs = append(SupportedChainSlugs, e.slug)
	}
}

// PrefixForChain returns the GraphQL prefix for a known chain slug and true.
// Returns ("", false) for unknown slugs. Used by tests to validate coverage
// without relying on PostById's error path.
func PrefixForChain(slug string) (string, bool) {
	p, ok := chainSlugToPrefix[slug]
	return p, ok
}

const (
	defaultRetryDelay = 100 * time.Millisecond
	maxRetryAfter     = time.Second
)

func (c *Client) do(ctx context.Context, operation string, body []byte) (*http.Response, error) {
	var retryDelay time.Duration
	for attempt := range 2 {
		if attempt > 0 {
			if err := ctx.Err(); err != nil {
				return nil, fmt.Errorf("%s retry delay: %w", operation, err)
			}
			if err := c.pace.wait(ctx, retryDelay); err != nil {
				return nil, fmt.Errorf("%s retry delay: %w", operation, err)
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("%s new request: %w", operation, err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "thatsrekt-notifier/1")

		resp, err := c.pace.Do(ctx, func() (*http.Response, error) {
			return c.HTTP.Do(req)
		})
		if err != nil {
			return nil, fmt.Errorf("%s pace request: %w", operation, err)
		}
		if resp.StatusCode != http.StatusTooManyRequests || attempt == 1 {
			return resp, nil
		}
		retryDelay = retryAfterDelay(resp.Header.Get("Retry-After"))
		resp.Body.Close()
	}
	panic("unreachable")
}

func retryAfterDelay(value string) time.Duration {
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds <= 0 {
		return defaultRetryDelay
	}
	if seconds >= int(maxRetryAfter/time.Second) {
		return maxRetryAfter
	}
	return time.Duration(seconds) * time.Second
}

// PostByIdResult is the minimal shape returned by the per-chain postById
// query. Only Removed and Title are needed by the retract-detection pass.
type PostByIdResult struct {
	Removed bool
	Title   string
}

// PostById calls the per-chain `<Prefix>_postById(id: <onchainID>)` query
// on the Mesh gateway to read the current `removed` flag for a specific post.
// This is the correct data path for retract detection: the unified `posts(...)`
// feed filters retracted posts out server-side (removed_eq: false), so
// `removed: true` is only ever observable via the per-chain postById route.
//
// `chainSlug` is the slug as stored in the notifier's post map (e.g. "base").
// `onchainID` is the bare integer id of the post on that chain (NOT the
// composite "{chainSlug}-{onchainID}" form — the per-chain query takes the
// raw on-chain integer).
func (c *Client) PostById(ctx context.Context, chainSlug, onchainID string) (*PostByIdResult, error) {
	prefix, ok := chainSlugToPrefix[chainSlug]
	if !ok {
		return nil, fmt.Errorf("PostById: unknown chain slug %q — add it to chainConfig in notifier/internal/graphql/client.go", chainSlug)
	}

	// Build the query dynamically using the chain prefix. The field name is
	// e.g. "Base_postById" for chain slug "base". Request only the fields
	// decoded by PostByIdResult: removed and title.
	query := fmt.Sprintf(`
		query NotifierPostById($id: String!) {
			%spostById(id: $id) {
				removed
				title
			}
		}
	`, prefix)

	body, err := json.Marshal(map[string]any{
		"query":     query,
		"variables": map[string]any{"id": onchainID},
	})
	if err != nil {
		return nil, fmt.Errorf("PostById marshal query: %w", err)
	}

	resp, err := c.do(ctx, "PostById", body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("PostById read body: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("PostById graphql %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}

	// The response data key is the prefixed field name, e.g. "Base_postById".
	// We decode into a map to avoid hard-coding the prefix in a struct tag.
	var out struct {
		Data   map[string]json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("PostById unmarshal response: %w", err)
	}
	if len(out.Errors) > 0 {
		return nil, fmt.Errorf("PostById graphql error: %s", out.Errors[0].Message)
	}

	fieldName := prefix + "postById"
	raw2, ok2 := out.Data[fieldName]
	if !ok2 {
		return nil, fmt.Errorf("PostById: field %q not found in response", fieldName)
	}
	// A null result means the post id does not exist on this chain's squid.
	if string(raw2) == "null" {
		return nil, nil
	}

	var post struct {
		Removed bool   `json:"removed"`
		Title   string `json:"title"`
	}
	if err := json.Unmarshal(raw2, &post); err != nil {
		return nil, fmt.Errorf("PostById unmarshal post: %w", err)
	}

	return &PostByIdResult{Removed: post.Removed, Title: post.Title}, nil
}

// LatestPosts fetches the most recent `limit` posts in DESC order. Caller
// dedupes against last-seen state to find the newly-arrived ones and detects
// amendments via the ActionCount / lastUpdatedAt snapshot fields.
//
// `actionCount` is included in the query — ThatsRekt/thatsRekt#132 / PR #133
// landed the `actionCount: Int!` field in both the per-chain squid schema and
// the Mesh UnifiedPost type. The notifier uses it to:
//   - Derive "rev N" in the message body.
//   - Detect amendments: if the stored snapshot for a known post has a
//     different actionCount or lastUpdatedAt, the post was amended on-chain.
//
// `removed` is included in the query struct for forward-compatibility. In
// practice the unified `posts(...)` feed never returns a post with
// removed=true because the gateway filters retracted posts out server-side
// (removed_eq: false — see mesh/src/server.ts). Retract detection therefore
// does NOT rely on this field from the feed. Instead, the notifier's separate
// retract-detection pass calls the per-chain <Prefix>_postById query for each
// stored post to observe the removed flag (see PostById and checkRetracts in
// service.go).
func (c *Client) LatestPosts(ctx context.Context, limit int) ([]Post, error) {
	const query = `
		query Notifier($limit: Int!) {
			posts(limit: $limit, offset: 0) {
				items {
					id
					chain { chainId slug name }
					poster
					title
					note
					confirmations
					disconfirmations
					netScore
					createdAtTimestamp
					attackedAt
					lastUpdatedAt
					actionCount
					attackers
					victims
					removed
				}
			}
		}
	`
	body, err := json.Marshal(map[string]any{
		"query":     query,
		"variables": map[string]any{"limit": limit},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal query: %w", err)
	}

	resp, err := c.do(ctx, "LatestPosts", body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("graphql %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}

	var out struct {
		Data struct {
			Posts struct {
				Items []Post `json:"items"`
			} `json:"posts"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}
	if len(out.Errors) > 0 {
		return nil, fmt.Errorf("graphql error: %s", out.Errors[0].Message)
	}
	return out.Data.Posts.Items, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
