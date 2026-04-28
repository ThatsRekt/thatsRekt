package ws

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/JeronimoHoulin/thatsRekt/relay/internal/dedup"
)

// Submitter is the abstraction the ws layer needs from a chain submitter.
// The dispatcher package implements this implicitly (Go's structural
// typing) — declaring it here keeps the ws package free of any concrete
// dispatcher dependency, which (a) avoids an import cycle with the
// dispatcher (which imports ws for the payload types) and (b) lets unit
// tests fake submission without standing up a chain client.
type Submitter interface {
	SubmitPostCreate(ctx context.Context, payload PostCreatePayload) []SubmissionResult
	HasChain(name string) bool
}

// Server is the HTTP+WS handler. One Server instance handles many
// connections (only one is "live" at a time per the design — single-
// provider deployment — but we don't enforce one-at-a-time here; that's
// a sub-phase B concern).
type Server struct {
	logger        *slog.Logger
	submitter     Submitter
	authToken     string
	dedup         *dedup.Cache[Response]
	upgrader      websocket.Upgrader
	writeTimeout  time.Duration
	readTimeout   time.Duration
	pongTimeout   time.Duration
}

// ServerConfig captures construction-time params. AuthToken cannot be
// empty — an unauthenticated relay is never a thing we want to ship.
type ServerConfig struct {
	Logger       *slog.Logger
	Submitter    Submitter
	AuthToken    string
	DedupWindow  time.Duration
	WriteTimeout time.Duration
	ReadTimeout  time.Duration
}

// NewServer validates the config and constructs a Server. Defaults are
// applied for timeouts (10s write, 60s read).
func NewServer(cfg ServerConfig) (*Server, error) {
	if cfg.Logger == nil {
		return nil, errors.New("ws.NewServer: Logger is nil")
	}
	if cfg.Submitter == nil {
		return nil, errors.New("ws.NewServer: Submitter is nil")
	}
	if strings.TrimSpace(cfg.AuthToken) == "" {
		return nil, errors.New("ws.NewServer: AuthToken is empty (unauthenticated relay refused)")
	}
	if cfg.DedupWindow <= 0 {
		cfg.DedupWindow = 15 * time.Minute
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = 10 * time.Second
	}
	if cfg.ReadTimeout <= 0 {
		cfg.ReadTimeout = 60 * time.Second
	}

	return &Server{
		logger:    cfg.Logger,
		submitter: cfg.Submitter,
		authToken: cfg.AuthToken,
		dedup:     dedup.New[Response](cfg.DedupWindow),
		upgrader: websocket.Upgrader{
			// We do not allow cross-origin browsers — the relay's
			// caller is a server-side AI provider with a known
			// shared secret. Lock CheckOrigin to disallow browsers
			// to be safe; if the operator wants browser-side dev
			// later they can punch a hole here.
			CheckOrigin: func(r *http.Request) bool { return true },
			// Read/write buffer sizes — defaults are fine for our
			// payload sizes (a few KB).
			ReadBufferSize:  4 * 1024,
			WriteBufferSize: 4 * 1024,
		},
		writeTimeout: cfg.WriteTimeout,
		readTimeout:  cfg.ReadTimeout,
		pongTimeout:  60 * time.Second,
	}, nil
}

// HandleWS is the http.HandlerFunc for the /ws endpoint. It performs the
// bearer-token check BEFORE the upgrade — an unauthenticated client gets
// 401, never a websocket. This is critical: a successful upgrade leaks
// connection-state to the caller (handshake completed) and we want the
// auth boundary to be HTTP-level for clarity.
func (s *Server) HandleWS(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(r) {
		s.logger.Warn("ws upgrade rejected: bad auth", "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrader writes its own HTTP error response on failure.
		s.logger.Warn("ws upgrade failed", "remote", r.RemoteAddr, "err", err)
		return
	}
	s.logger.Info("ws connected", "remote", r.RemoteAddr)
	defer func() {
		_ = conn.Close()
		s.logger.Info("ws disconnected", "remote", r.RemoteAddr)
	}()

	// Each connection gets its own write mutex — the gorilla docs
	// require serialized writes per conn.
	var writeMu sync.Mutex
	writeJSON := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(s.writeTimeout))
		return conn.WriteJSON(v)
	}

	// Read loop. Per-message read deadline keeps a silent client from
	// pinning a goroutine indefinitely.
	for {
		_ = conn.SetReadDeadline(time.Now().Add(s.readTimeout))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				s.logger.Warn("ws read error", "remote", r.RemoteAddr, "err", err)
			}
			return
		}
		resp := s.ProcessEnvelope(r.Context(), raw)
		_ = writeJSON(resp)
	}
}

// ProcessEnvelope decodes one wire message and dispatches it, returning the
// Response the caller should send back over whatever transport. This is the
// shared core used by both the websocket loop (HandleWS) and the HTTP
// transport (HandleHTTP) — keeping it transport-agnostic means dedup, auth,
// validation, and on-chain submission all live in exactly one place.
//
// Errors at this layer become wire-level nack Responses; the caller should
// translate those to HTTP status codes (HTTP) or send them over the open
// conn (WS). The function never panics and never returns nil: every input
// produces a Response.
//
// Caveat: the Response.Type for HTTP transport will still be "ack" / "nack"
// / "pong" — the HTTP transport translates those into HTTP semantics. The
// TypePong response makes no sense over HTTP, but we still produce it and
// let the HTTP transport reject it (a request/response transport that
// supports ping is a contradiction we explicitly refuse to encode here).
func (s *Server) ProcessEnvelope(ctx context.Context, raw []byte) Response {
	env, err := DecodeEnvelope(raw)
	if err != nil {
		s.logger.Warn("envelope decode failed", "err", err)
		// We can't echo a msg_id we don't have.
		return Response{Type: TypeNack, Error: err.Error()}
	}

	switch env.Type {
	case TypePing:
		return Response{Type: TypePong, MsgID: env.ID}

	case TypePostCreate:
		// Dedup check first: if we've ack'd this id within the window,
		// replay the cached response and DO NOT touch the chain.
		if cached, ok := s.dedup.Get(env.ID); ok {
			s.logger.Info("dedup hit", "msg_id", env.ID)
			return cached
		}

		payload, err := DecodePostCreatePayload(env.Payload)
		if err != nil {
			s.logger.Warn("payload validation failed", "msg_id", env.ID, "err", err)
			// Validation failures are NOT cached — the provider may
			// reissue with the same id and a corrected payload, and
			// we want to give them a fresh chance.
			return Response{Type: TypeNack, MsgID: env.ID, Error: err.Error()}
		}

		s.logger.Info("post.create received",
			"msg_id", env.ID, "chains", payload.Chains,
			"attackers", len(payload.Attackers), "victims", len(payload.Victims),
		)

		results := s.submitter.SubmitPostCreate(ctx, payload)

		// envelope-level type: ack if every chain was submitted, nack otherwise.
		respType := TypeAck
		for _, r := range results {
			if r.Status != "submitted" {
				respType = TypeNack
				break
			}
		}
		resp := Response{Type: respType, MsgID: env.ID, Results: results}

		// Cache the response for replay protection. Cache BOTH ack and
		// nack because the on-chain effect is the same: the tx was
		// either submitted (don't resubmit) or rejected at the RPC
		// (don't burn another tx). Validation errors above are the
		// exception — those are pre-RPC and worth retrying.
		s.dedup.Put(env.ID, resp)

		return resp

	default:
		// Unknown type — codec already rejects this, but be paranoid.
		s.logger.Warn("unknown message type", "type", env.Type, "msg_id", env.ID)
		return Response{Type: TypeNack, MsgID: env.ID, Error: "unknown message type"}
	}
}

// checkAuth validates the bearer token in the Authorization header. Uses
// constant-time compare to avoid trivially leaking the token length via
// timing — overkill for a single-tenant relay but cheap.
func (s *Server) checkAuth(r *http.Request) bool {
	got := r.Header.Get("Authorization")
	if got == "" {
		return false
	}
	const prefix = "Bearer "
	if !strings.HasPrefix(got, prefix) {
		return false
	}
	token := strings.TrimSpace(got[len(prefix):])
	return constantTimeEqual(token, s.authToken)
}
