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

func TestLoad_PrivateGraphQLSettings(t *testing.T) {
	tests := []struct {
		name            string
		dialAddress     string
		internalToken   string
		wantDialAddress string
		wantToken       string
		wantErr         string
	}{
		{
			name: "accepts public route without private settings",
		},
		{
			name:            "loads private IP route and token",
			dialAddress:     "10.0.0.8:8443",
			internalToken:   "test-token",
			wantDialAddress: "10.0.0.8:8443",
			wantToken:       "test-token",
		},
		{
			name:          "rejects internal token without dial address",
			internalToken: "test-token",
			wantErr:       "GRAPHQL_DIAL_ADDRESS",
		},
		{
			name:        "rejects dial address without internal token",
			dialAddress: "10.0.0.8:8443",
			wantErr:     "GRAPHQL_INTERNAL_TOKEN",
		},
		{
			name:          "rejects dial address with hostname",
			dialAddress:   "private.example:8443",
			internalToken: "test-token",
			wantErr:       "GRAPHQL_DIAL_ADDRESS",
		},
		{
			name:          "rejects dial address without port",
			dialAddress:   "10.0.0.8",
			internalToken: "test-token",
			wantErr:       "GRAPHQL_DIAL_ADDRESS",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("BOT_TOKEN", "token")
			t.Setenv("CHANNEL_ID", "channel")
			t.Setenv("STATE_S3_BUCKET", "bucket")
			t.Setenv("GRAPHQL_DIAL_ADDRESS", test.dialAddress)
			t.Setenv("GRAPHQL_INTERNAL_TOKEN", test.internalToken)

			cfg, err := Load()
			if test.wantErr != "" {
				if err == nil {
					t.Fatal("Load succeeded")
				}
				if !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("Load error = %q, want error naming %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg.GraphQLDialAddress != test.wantDialAddress {
				t.Fatalf("GraphQLDialAddress = %q, want %q", cfg.GraphQLDialAddress, test.wantDialAddress)
			}
			if cfg.GraphQLInternalToken != test.wantToken {
				t.Fatalf("GraphQLInternalToken = %q, want %q", cfg.GraphQLInternalToken, test.wantToken)
			}
		})
	}
}
