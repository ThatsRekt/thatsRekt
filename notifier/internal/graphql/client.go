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
}

func NewClient(url string) *Client {
	return &Client{
		URL: url,
		HTTP: &http.Client{
			Timeout: 30 * time.Second, // ample for cross-chain stitching
		},
	}
}

// chainSlugToPrefix maps the chain slug (as returned in the unified posts feed)
// to the GraphQL prefix the Mesh gateway uses for per-chain queries. The
// prefix is applied by the gateway's RenameRootFields transformer:
//
//	"base" → "Base_"     → query field is Base_postById(id: "42") { removed ... }
//	"ethereum" → "Ethereum_"
//
// The mapping must stay in sync with mesh/src/chains.ts. The sentinel "" value
// means the chain is unknown to this notifier build — PostById returns an error
// for unknown slugs rather than silently querying the wrong prefix.
var chainSlugToPrefix = map[string]string{
	"anvil-eth":    "AnvilEth_",
	"anvil-base":   "AnvilBase_",
	"sepolia":      "Sepolia_",
	"ethereum":     "Ethereum_",
	"base":         "Base_",
	"base-sepolia": "BaseSepolia_",
	"optimism":     "Optimism_",
	"arbitrum":     "Arbitrum_",
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
		return nil, fmt.Errorf("PostById: unknown chain slug %q — add it to chainSlugToPrefix", chainSlug)
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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("PostById new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "thatsrekt-notifier/1")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("PostById do request: %w", err)
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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "thatsrekt-notifier/1")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do request: %w", err)
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
