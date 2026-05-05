// thatsRekt notifier — Telegram channel bot.
//
// Run as a long-running Fargate task. Reads its configuration from env
// vars (see internal/config). Only requires:
//   - a BotFather-issued BOT_TOKEN
//   - a Telegram CHANNEL_ID where the bot is admin
//   - an S3 bucket the IAM role has GetObject/PutObject on
//
// Lifecycle:
//   1. Load config + state from S3.
//   2. Start two goroutines: poll loop + callback loop.
//   3. On SIGTERM (Fargate stop signal): cancel ctx, flush state, exit 0.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/ThatsRekt/thatsRekt/notifier/internal/config"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/graphql"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/notifier"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/store"
	"github.com/ThatsRekt/thatsRekt/notifier/internal/telegram"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		logger.Error("aws config load failed", "err", err)
		os.Exit(1)
	}
	s3Client := s3.NewFromConfig(awsCfg)
	st := store.New(s3Client, cfg.StateBucket, cfg.StateKey)
	if err := st.Load(ctx); err != nil {
		logger.Error("state load failed", "err", err)
		os.Exit(1)
	}

	svc := &notifier.Service{
		GQL:          graphql.NewClient(cfg.GraphQLURL),
		Bot:          telegram.NewBot(cfg.BotToken),
		Store:        st,
		ChannelID:    cfg.ChannelID,
		SiteURL:      cfg.SiteURL,
		PollInterval: cfg.PollInterval,
		FetchLimit:   cfg.FetchLimit,
		Logger:       logger,
	}

	logger.Info("notifier starting",
		"graphql_url", cfg.GraphQLURL,
		"channel_id", cfg.ChannelID,
		"poll_interval", cfg.PollInterval.String(),
		"state_bucket", cfg.StateBucket,
	)

	if err := svc.Run(ctx); err != nil && err != context.Canceled {
		logger.Error("service exited", "err", err)
		os.Exit(1)
	}
	logger.Info("notifier shut down cleanly")
}
