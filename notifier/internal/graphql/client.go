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

	// v2: action count used to derive revision number (rev = ActionCount).
	// Zero means the indexer has not yet been upgraded to expose this field;
	// the notifier falls back to rev 1 in that case.
	ActionCount int `json:"actionCount"`

	// v2: ISO-8601 timestamp of the latest on-chain write for this post.
	// Mirrors the existing `lastUpdatedAt` field on the mesh UnifiedPost type.
	LastUpdatedAt string `json:"lastUpdatedAt"`
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

// LatestPosts fetches the most recent `limit` posts in DESC order. Caller
// dedupes against last-seen state to find the newly-arrived ones.
//
// GraphQL indexer dependency (v2):
//
//   - `lastUpdatedAt` — already present in the Mesh UnifiedPost type.
//   - `actionCount` — NOT YET exposed by the indexer or mesh. The struct
//     field Post.ActionCount is retained for forward-compatibility: once
//     the indexer upgrade lands (tracked in ThatsRekt/thatsRekt#132),
//     re-add `actionCount` to the query below and json.Unmarshal will
//     populate the field automatically. Until then, ActionCount stays 0
//     and FormatPostMessage renders rev 1 as the safe default.
//
// What the indexer/mesh must add to unblock full rev-N functionality:
//
//  1. The per-chain squid schema needs an `actionCount: Int!` field on
//     the `Post` entity, maintained as `1 + len(post.edits)` by the
//     processor (incremented on every AmendNote, AmendTitle, AddAttackers,
//     AddVictims event).
//  2. The Mesh `UnifiedPost` type and its `FETCH_POSTS_QUERY` must project
//     `actionCount` so it reaches the notifier.
//
// Until that change lands, the notifier is correct at rev=1 for all posts.
func (c *Client) LatestPosts(ctx context.Context, limit int) ([]Post, error) {
	// NOTE: `actionCount` is intentionally absent from this query.
	// GraphQL validates the full selection set against the schema before
	// execution: an unknown field causes a hard validation error and the
	// server returns zero data — there is no partial success. The field is
	// not yet in the Mesh UnifiedPost schema; re-add it here once
	// ThatsRekt/thatsRekt#132 has merged and the schema exposes it.
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
					attackers
					victims
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
