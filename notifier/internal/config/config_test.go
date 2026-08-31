package config

import (
	"strings"
	"testing"
)

// Removing the explicit default would allow a deployment with no override to
// burst requests without the intended total 10 requests-per-second ceiling.
func TestLoad_DefaultsGraphQLRequestsPerSecondToTen(t *testing.T) {
	t.Setenv("BOT_TOKEN", "token")
	t.Setenv("CHANNEL_ID", "channel")
	t.Setenv("STATE_S3_BUCKET", "bucket")
	t.Setenv("GRAPHQL_REQUESTS_PER_SECOND", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.GraphQLRequestsPerSecond != 10 {
		t.Fatalf("GraphQLRequestsPerSecond = %d, want 10", cfg.GraphQLRequestsPerSecond)
	}
}

func TestLoad_RejectsGraphQLRequestsPerSecondAboveSafeCeiling(t *testing.T) {
	t.Setenv("BOT_TOKEN", "token")
	t.Setenv("CHANNEL_ID", "channel")
	t.Setenv("STATE_S3_BUCKET", "bucket")
	t.Setenv("GRAPHQL_REQUESTS_PER_SECOND", "11")

	_, err := Load()
	if err == nil {
		t.Fatal("Load succeeded with an unsafe GraphQL request rate")
	}
	if !strings.Contains(err.Error(), "must not exceed 10") {
		t.Fatalf("Load error = %q, want safe-ceiling error", err)
	}
}
