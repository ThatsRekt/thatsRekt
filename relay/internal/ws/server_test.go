package ws

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakeSubmitter records calls and returns canned results. Used to exercise
// the ws layer without standing up a chain.
type fakeSubmitter struct {
	calls   atomic.Int64
	results []SubmissionResult
	chains  map[string]bool
}

func (f *fakeSubmitter) SubmitPostCreate(ctx context.Context, payload PostCreatePayload) []SubmissionResult {
	f.calls.Add(1)
	// Echo the input chains so each result matches a requested chain.
	out := make([]SubmissionResult, 0, len(payload.Chains))
	for _, c := range payload.Chains {
		// Find a canned result matching this chain name; default to a
		// "submitted" entry.
		var match *SubmissionResult
		for i := range f.results {
			if f.results[i].Chain == c {
				match = &f.results[i]
				break
			}
		}
		if match != nil {
			out = append(out, *match)
		} else {
			out = append(out, SubmissionResult{Chain: c, Status: "submitted", TxHash: "0xtx", PostID: "1"})
		}
	}
	return out
}

func (f *fakeSubmitter) HasChain(name string) bool { return f.chains[name] }

func newTestServer(t *testing.T, sub Submitter) (*httptest.Server, string) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := NewServer(ServerConfig{
		Logger:      logger,
		Submitter:   sub,
		AuthToken:   "dev-secret",
		DedupWindow: time.Minute,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.HandleWS)
	httpSrv := httptest.NewServer(mux)
	t.Cleanup(httpSrv.Close)
	wsURL := "ws" + strings.TrimPrefix(httpSrv.URL, "http") + "/ws"
	return httpSrv, wsURL
}

func dialWS(t *testing.T, wsURL, token string) *websocket.Conn {
	t.Helper()
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		if resp != nil {
			t.Fatalf("dial: %v (status %d)", err, resp.StatusCode)
		}
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestServer_RejectsMissingAuth(t *testing.T) {
	_, wsURL := newTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected dial to fail")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v", resp)
	}
}

func TestServer_RejectsWrongAuth(t *testing.T) {
	_, wsURL := newTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	header := http.Header{}
	header.Set("Authorization", "Bearer wrong")
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err == nil {
		t.Fatal("expected dial to fail")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %v", resp)
	}
}

func TestServer_AcceptsValidAuth_AndAcksPostCreate(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, wsURL := newTestServer(t, sub)
	conn := dialWS(t, wsURL, "dev-secret")

	msg := map[string]any{
		"type":      "post.create",
		"id":        "msg-1",
		"timestamp": "2026-04-27T22:00:00Z",
		"payload": map[string]any{
			"chains":      []string{"base"},
			"title":       "headline",
			"attackers":   []string{"0x0000000000000000000000000000000000000001"},
			"victims":     []string{},
			"note":        "ctx",
			"attacked_at": 1777340000,
		},
	}
	mustWriteJSON(t, conn, msg)
	var resp Response
	mustReadJSON(t, conn, &resp)
	if resp.Type != TypeAck {
		t.Fatalf("expected ack, got %q (err=%q)", resp.Type, resp.Error)
	}
	if resp.MsgID != "msg-1" {
		t.Fatalf("msg_id: %q", resp.MsgID)
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "submitted" {
		t.Fatalf("results: %+v", resp.Results)
	}
	if sub.calls.Load() != 1 {
		t.Fatalf("submitter calls: %d", sub.calls.Load())
	}
}

func TestServer_DedupReplaysCachedResponse(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, wsURL := newTestServer(t, sub)
	conn := dialWS(t, wsURL, "dev-secret")

	msg := map[string]any{
		"type":      "post.create",
		"id":        "msg-dup",
		"timestamp": "2026-04-27T22:00:00Z",
		"payload": map[string]any{
			"chains":      []string{"base"},
			"title":       "headline",
			"attackers":   []string{},
			"victims":     []string{},
			"note":        "",
			"attacked_at": 1777340000,
		},
	}
	mustWriteJSON(t, conn, msg)
	var first Response
	mustReadJSON(t, conn, &first)
	if first.Type != TypeAck {
		t.Fatalf("first: %+v", first)
	}

	// Send the SAME msg id again — the submitter must NOT be called twice.
	mustWriteJSON(t, conn, msg)
	var second Response
	mustReadJSON(t, conn, &second)
	if second.Type != TypeAck || second.MsgID != "msg-dup" {
		t.Fatalf("second: %+v", second)
	}
	if got := sub.calls.Load(); got != 1 {
		t.Fatalf("submitter must run exactly once, got %d", got)
	}
}

func TestServer_NacksMalformedPayload(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, wsURL := newTestServer(t, sub)
	conn := dialWS(t, wsURL, "dev-secret")

	// Missing title.
	msg := map[string]any{
		"type":      "post.create",
		"id":        "msg-bad",
		"timestamp": "t",
		"payload": map[string]any{
			"chains":      []string{"base"},
			"title":       "",
			"attackers":   []string{},
			"victims":     []string{},
			"note":        "",
			"attacked_at": 1,
		},
	}
	mustWriteJSON(t, conn, msg)
	var resp Response
	mustReadJSON(t, conn, &resp)
	if resp.Type != TypeNack {
		t.Fatalf("expected nack, got %q", resp.Type)
	}
	if resp.MsgID != "msg-bad" {
		t.Fatalf("msg_id: %q", resp.MsgID)
	}
	if !strings.Contains(resp.Error, "title") {
		t.Fatalf("error should mention title, got %q", resp.Error)
	}
	if sub.calls.Load() != 0 {
		t.Fatal("submitter must not be called on validation failure")
	}
}

func TestServer_PingPong(t *testing.T) {
	_, wsURL := newTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	conn := dialWS(t, wsURL, "dev-secret")
	mustWriteJSON(t, conn, map[string]any{
		"type":      "ping",
		"id":        "ping-1",
		"timestamp": "t",
		"payload":   map[string]any{},
	})
	var resp Response
	mustReadJSON(t, conn, &resp)
	if resp.Type != TypePong {
		t.Fatalf("expected pong, got %q", resp.Type)
	}
	if resp.MsgID != "ping-1" {
		t.Fatalf("ping echo: %q", resp.MsgID)
	}
}

func mustWriteJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	if err := c.WriteJSON(v); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func mustReadJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, raw, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("unmarshal: %v (raw=%s)", err, string(raw))
	}
}
