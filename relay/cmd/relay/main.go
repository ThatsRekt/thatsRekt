// Command relay is the thatsRekt websocket relay server (sub-phase A).
//
// Single-chain, env-key-signing, post.create-only. See
// tasks/relay-server-design.md for the full design and the sub-phase
// boundary. Multi-chain dispatch + KMS arrive in sub-phase B.
//
// Configuration is environment-only for sub-phase A. The relay.yaml
// config file from the design is not read yet — adding it without
// multi-chain wiring would be premature.
//
// Required env:
//
//	RELAY_PROVIDER_TOKEN  Bearer token for the inbound websocket.
//	RELAY_PRIVATE_KEY     Hex-encoded ECDSA private key (with or without 0x).
//	RELAY_RPC_URL         RPC endpoint for the configured chain.
//	RELAY_CONTRACT_ADDRESS  thatsRekt proxy address.
//	RELAY_CHAIN_ID        Numeric EIP-155 chain id (must match RPC).
//
// Optional env:
//
//	RELAY_LISTEN_ADDR     Default ":8080".
//	RELAY_WS_PATH         Default "/ws".
//	RELAY_HTTP_PATH       Default "/post". Raw-envelope HTTP transport
//	                      for direct integrators, smoke tests.
//	RELAY_DETECT_PATH     Default "/detect". Otomato-shaped adapter:
//	                      AI-JSON body + metadata in headers.
//	RELAY_CHAIN_NAME      Default "base". Used in ack results and chain lookup.
//	RELAY_DEDUP_WINDOW    Default "15m". Go duration syntax.
//	RELAY_RECEIPT_TIMEOUT Default "60s". Go duration syntax.
//	RELAY_LOG_LEVEL       "debug" | "info" | "warn" | "error". Default "info".
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/JeronimoHoulin/thatsRekt/relay/internal/chain"
	"github.com/JeronimoHoulin/thatsRekt/relay/internal/dispatcher"
	"github.com/JeronimoHoulin/thatsRekt/relay/internal/signer"
	"github.com/JeronimoHoulin/thatsRekt/relay/internal/ws"
)

func main() {
	if err := run(); err != nil {
		// run() owns logger setup; if we're here we may not have one.
		fmt.Fprintf(os.Stderr, "relay: fatal: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}

	logger := newLogger(cfg.LogLevel)
	logger.Info("starting relay (sub-phase A)",
		"listen", cfg.ListenAddr,
		"ws_path", cfg.WSPath, "http_path", cfg.HTTPPath, "detect_path", cfg.DetectPath,
		"chain_name", cfg.ChainName, "chain_id", cfg.ChainID,
		"contract", cfg.ContractAddress.Hex(),
	)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// --- Build chain client (verifies RPC chain id matches config) ---
	client, err := chain.Dial(ctx, chain.Config{
		Name:     cfg.ChainName,
		RPCURL:   cfg.RPCURL,
		ChainID:  cfg.ChainID,
		Contract: cfg.ContractAddress,
	})
	if err != nil {
		return fmt.Errorf("chain dial: %w", err)
	}
	defer client.Close()

	// --- Build signer (binds chain id, derives address) ---
	sgn, err := signer.NewEnvSigner(cfg.PrivateKey, new(big.Int).SetUint64(cfg.ChainID))
	if err != nil {
		return fmt.Errorf("signer: %w", err)
	}
	logger.Info("signer ready", "address", sgn.Address().Hex())

	// --- Build dispatcher ---
	disp, err := dispatcher.New(dispatcher.Config{
		Chains: []dispatcher.ChainPair{
			{Client: client, Signer: sgn},
		},
		ReceiptTimeout: cfg.ReceiptTimeout,
	})
	if err != nil {
		return fmt.Errorf("dispatcher: %w", err)
	}

	// --- Build ws server ---
	srv, err := ws.NewServer(ws.ServerConfig{
		Logger:      logger,
		Submitter:   disp,
		AuthToken:   cfg.ProviderToken,
		DedupWindow: cfg.DedupWindow,
	})
	if err != nil {
		return fmt.Errorf("ws server: %w", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc(cfg.WSPath, srv.HandleWS)
	// Raw-envelope HTTP transport (direct integrators, curl smoke tests).
	mux.HandleFunc(cfg.HTTPPath, srv.HandleHTTP)
	// Otomato-shaped adapter: AI-JSON body + metadata in headers. Routes
	// through the same Submitter + dedup as /post and /ws.
	mux.HandleFunc(cfg.DetectPath, srv.HandleDetect)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Run http server in a goroutine and wait for ctx cancel.
	errCh := make(chan error, 1)
	go func() {
		logger.Info("http listening", "addr", cfg.ListenAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	}

	shutdownCtx, sCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer sCancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown error", "err", err)
	}
	logger.Info("relay stopped")
	return nil
}

type config struct {
	ListenAddr      string
	WSPath          string
	HTTPPath        string
	DetectPath      string
	ProviderToken   string
	PrivateKey      string
	RPCURL          string
	ContractAddress common.Address
	ChainID         uint64
	ChainName       string
	DedupWindow     time.Duration
	ReceiptTimeout  time.Duration
	LogLevel        slog.Level
}

func loadConfig() (config, error) {
	var cfg config

	// Required.
	cfg.ProviderToken = mustEnv("RELAY_PROVIDER_TOKEN")
	if cfg.ProviderToken == "" {
		return cfg, errors.New("RELAY_PROVIDER_TOKEN is required")
	}
	cfg.PrivateKey = mustEnv("RELAY_PRIVATE_KEY")
	if cfg.PrivateKey == "" {
		return cfg, errors.New("RELAY_PRIVATE_KEY is required")
	}
	cfg.RPCURL = mustEnv("RELAY_RPC_URL")
	if cfg.RPCURL == "" {
		return cfg, errors.New("RELAY_RPC_URL is required")
	}

	contractRaw := mustEnv("RELAY_CONTRACT_ADDRESS")
	if !common.IsHexAddress(contractRaw) {
		return cfg, fmt.Errorf("RELAY_CONTRACT_ADDRESS is not a valid address: %q", contractRaw)
	}
	cfg.ContractAddress = common.HexToAddress(contractRaw)

	chainIDRaw := mustEnv("RELAY_CHAIN_ID")
	chainID, err := strconv.ParseUint(chainIDRaw, 10, 64)
	if err != nil || chainID == 0 {
		return cfg, fmt.Errorf("RELAY_CHAIN_ID must be a positive integer, got %q", chainIDRaw)
	}
	cfg.ChainID = chainID

	// Optional.
	cfg.ListenAddr = envOr("RELAY_LISTEN_ADDR", ":8080")
	cfg.WSPath = envOr("RELAY_WS_PATH", "/ws")
	cfg.HTTPPath = envOr("RELAY_HTTP_PATH", "/post")
	cfg.DetectPath = envOr("RELAY_DETECT_PATH", "/detect")
	cfg.ChainName = envOr("RELAY_CHAIN_NAME", "base")
	// Path collision check — three distinct mux entries on the same
	// listener; if any two match, the second registration panics.
	paths := map[string]string{
		"RELAY_WS_PATH":     cfg.WSPath,
		"RELAY_HTTP_PATH":   cfg.HTTPPath,
		"RELAY_DETECT_PATH": cfg.DetectPath,
	}
	seen := make(map[string]string, len(paths))
	for k, v := range paths {
		if other, dup := seen[v]; dup {
			return cfg, fmt.Errorf("%s and %s collide on path %q", other, k, v)
		}
		seen[v] = k
	}

	cfg.DedupWindow, err = parseDuration("RELAY_DEDUP_WINDOW", 15*time.Minute)
	if err != nil {
		return cfg, err
	}
	cfg.ReceiptTimeout, err = parseDuration("RELAY_RECEIPT_TIMEOUT", 60*time.Second)
	if err != nil {
		return cfg, err
	}
	cfg.LogLevel = parseLogLevel(envOr("RELAY_LOG_LEVEL", "info"))

	return cfg, nil
}

func mustEnv(key string) string { return os.Getenv(key) }

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseDuration(key string, def time.Duration) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %v", key, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%s must be positive, got %s", key, d)
	}
	return d, nil
}

func parseLogLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func newLogger(level slog.Level) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}
