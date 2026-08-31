// Package config — env-var driven configuration. Single source of truth for
// every tunable so the Fargate task spec maps 1:1 to env names.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

const maxGraphQLRequestsPerSecond = 10

type Config struct {
	// Telegram
	BotToken  string // BOT_TOKEN — from @BotFather
	ChannelID string // CHANNEL_ID — `@username` for public channels, or numeric `-100…` for private

	// thatsRekt API
	GraphQLURL               string // GRAPHQL_URL — e.g. https://thatsrekt.com/graphql
	GraphQLRequestsPerSecond int    // GRAPHQL_REQUESTS_PER_SECOND — total client limit (default 10)
	SiteURL                  string // SITE_URL — base URL for `/post/:chain/:id` links, e.g. https://thatsrekt.com

	// Polling
	PollInterval time.Duration // POLL_INTERVAL — how often to query GraphQL for new posts (default 10s)
	FetchLimit   int           // FETCH_LIMIT — how many posts to pull per cycle (default 25)

	// State persistence (S3)
	StateBucket string // STATE_S3_BUCKET — single small JSON file lives here
	StateKey    string // STATE_S3_KEY — defaults to thatsrekt-notifier/state.json
}

func Load() (*Config, error) {
	cfg := &Config{
		BotToken:    os.Getenv("BOT_TOKEN"),
		ChannelID:   os.Getenv("CHANNEL_ID"),
		GraphQLURL:  envOrDefault("GRAPHQL_URL", "https://thatsrekt.com/graphql"),
		SiteURL:     envOrDefault("SITE_URL", "https://thatsrekt.com"),
		StateBucket: os.Getenv("STATE_S3_BUCKET"),
		StateKey:    envOrDefault("STATE_S3_KEY", "thatsrekt-notifier/state.json"),
	}

	pollSec, err := parseIntDefault("POLL_INTERVAL_SECONDS", 10)
	if err != nil {
		return nil, fmt.Errorf("POLL_INTERVAL_SECONDS: %w", err)
	}
	cfg.PollInterval = time.Duration(pollSec) * time.Second

	limit, err := parseIntDefault("FETCH_LIMIT", 25)
	if err != nil {
		return nil, fmt.Errorf("FETCH_LIMIT: %w", err)
	}
	cfg.FetchLimit = limit

	rate, err := parsePositiveIntDefault("GRAPHQL_REQUESTS_PER_SECOND", 10)
	if err != nil {
		return nil, fmt.Errorf("GRAPHQL_REQUESTS_PER_SECOND: %w", err)
	}
	cfg.GraphQLRequestsPerSecond = rate

	if cfg.BotToken == "" {
		return nil, errors.New("BOT_TOKEN env required")
	}
	if cfg.ChannelID == "" {
		return nil, errors.New("CHANNEL_ID env required")
	}
	if cfg.StateBucket == "" {
		return nil, errors.New("STATE_S3_BUCKET env required")
	}
	return cfg, nil
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseIntDefault(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func parsePositiveIntDefault(key string, def int) (int, error) {
	n, err := parseIntDefault(key, def)
	if err != nil {
		return 0, err
	}
	if n <= 0 {
		return 0, errors.New("must be positive")
	}
	if n > maxGraphQLRequestsPerSecond {
		return 0, errors.New("must not exceed 10")
	}
	return n, nil
}
