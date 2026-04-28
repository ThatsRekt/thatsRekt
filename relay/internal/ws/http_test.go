package ws

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newHTTPTestServer mirrors newTestServer (ws path) but additionally
// wires the HandleHTTP handler at /post. Returns the test server, the
// /post URL, and the underlying *Server so tests can reach into the
// dedup cache for cross-transport assertions.
func newHTTPTestServer(t *testing.T, sub Submitter) (*httptest.Server, string, *Server) {
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
	mux.HandleFunc("/post", srv.HandleHTTP)
	httpSrv := httptest.NewServer(mux)
	t.Cleanup(httpSrv.Close)
	return httpSrv, httpSrv.URL + "/post", srv
}

// postEnvelope is a tiny helper that POSTs an envelope (raw bytes or any
// JSON-marshalable value) with the given bearer token and returns the
// status code, parsed Response, and raw body for error inspection.
func postEnvelope(t *testing.T, url, token string, body any) (int, Response, []byte) {
	t.Helper()
	var raw []byte
	switch v := body.(type) {
	case nil:
		raw = nil
	case []byte:
		raw = v
	case string:
		raw = []byte(v)
	default:
		var err error
		raw, err = json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read resp: %v", err)
	}
	var parsed Response
	// Body may not be JSON for plain text errors (401, 405) — best-effort
	// decode; tests that need parsed response use only fields we set in
	// the JSON path.
	_ = json.Unmarshal(respBody, &parsed)
	return resp.StatusCode, parsed, respBody
}

func validPostCreate(id string) map[string]any {
	return map[string]any{
		"type":      "post.create",
		"id":        id,
		"timestamp": "2026-04-28T00:00:00Z",
		"payload": map[string]any{
			"chains":      []string{"base"},
			"title":       "Aave hacked",
			"attackers":   []string{},
			"victims":     []string{},
			"note":        "tweet body + url",
			"attacked_at": 1777340000,
		},
	}
}

func TestHTTP_RejectsGET(t *testing.T) {
	httpSrv, postURL, _ := newHTTPTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	_ = httpSrv

	req, _ := http.NewRequest(http.MethodGet, postURL, nil)
	req.Header.Set("Authorization", "Bearer dev-secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow header: %q", got)
	}
}

func TestHTTP_RejectsMissingAuth(t *testing.T) {
	_, postURL, _ := newHTTPTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	status, _, _ := postEnvelope(t, postURL, "", validPostCreate("a"))
	if status != http.StatusUnauthorized {
		t.Fatalf("status: %d", status)
	}
}

func TestHTTP_RejectsWrongAuth(t *testing.T) {
	_, postURL, _ := newHTTPTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	status, _, _ := postEnvelope(t, postURL, "wrong", validPostCreate("a"))
	if status != http.StatusUnauthorized {
		t.Fatalf("status: %d", status)
	}
}

func TestHTTP_AcksValidPostCreate(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, postURL, _ := newHTTPTestServer(t, sub)

	status, resp, body := postEnvelope(t, postURL, "dev-secret", validPostCreate("msg-http-1"))
	if status != http.StatusOK {
		t.Fatalf("status: %d body=%s", status, body)
	}
	if resp.Type != TypeAck {
		t.Fatalf("type: %q (err=%q)", resp.Type, resp.Error)
	}
	if resp.MsgID != "msg-http-1" {
		t.Fatalf("msg_id: %q", resp.MsgID)
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "submitted" {
		t.Fatalf("results: %+v", resp.Results)
	}
	if sub.calls.Load() != 1 {
		t.Fatalf("submitter calls: %d", sub.calls.Load())
	}
}

func TestHTTP_NacksMalformedJSON(t *testing.T) {
	_, postURL, _ := newHTTPTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	status, resp, _ := postEnvelope(t, postURL, "dev-secret", "{not-json")
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if resp.Type != TypeNack {
		t.Fatalf("type: %q", resp.Type)
	}
}

func TestHTTP_NacksMissingTitle(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, postURL, _ := newHTTPTestServer(t, sub)

	bad := validPostCreate("msg-bad")
	bad["payload"].(map[string]any)["title"] = ""
	status, resp, _ := postEnvelope(t, postURL, "dev-secret", bad)
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if resp.Type != TypeNack {
		t.Fatalf("type: %q", resp.Type)
	}
	if !strings.Contains(resp.Error, "title") {
		t.Fatalf("error: %q", resp.Error)
	}
	if sub.calls.Load() != 0 {
		t.Fatalf("submitter must not be called on validation failure: %d", sub.calls.Load())
	}
}

func TestHTTP_BadGatewayOnSubmissionFailure(t *testing.T) {
	// Submitter returns "failed" for the requested chain — relay should
	// nack with 502 so callers (and load balancers / monitoring) can
	// distinguish "we rejected your input" (400) from "downstream chain
	// is sad" (502).
	sub := &fakeSubmitter{
		chains:  map[string]bool{"base": true},
		results: []SubmissionResult{{Chain: "base", Status: "failed", Error: "rpc unreachable"}},
	}
	_, postURL, _ := newHTTPTestServer(t, sub)

	status, resp, body := postEnvelope(t, postURL, "dev-secret", validPostCreate("msg-fail"))
	if status != http.StatusBadGateway {
		t.Fatalf("status: %d body=%s", status, body)
	}
	if resp.Type != TypeNack {
		t.Fatalf("type: %q", resp.Type)
	}
	if len(resp.Results) != 1 || resp.Results[0].Status != "failed" {
		t.Fatalf("results: %+v", resp.Results)
	}
}

func TestHTTP_DedupReplaysCachedResponse(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	_, postURL, _ := newHTTPTestServer(t, sub)

	first, _, _ := postEnvelope(t, postURL, "dev-secret", validPostCreate("msg-dup-http"))
	if first != http.StatusOK {
		t.Fatalf("first status: %d", first)
	}

	second, resp, _ := postEnvelope(t, postURL, "dev-secret", validPostCreate("msg-dup-http"))
	if second != http.StatusOK {
		t.Fatalf("second status: %d", second)
	}
	if resp.Type != TypeAck || resp.MsgID != "msg-dup-http" {
		t.Fatalf("second resp: %+v", resp)
	}
	if got := sub.calls.Load(); got != 1 {
		t.Fatalf("submitter must run exactly once, got %d", got)
	}
}

func TestHTTP_RejectsPingTransport(t *testing.T) {
	// Ping over HTTP is a contradiction — a request/response transport
	// can't host a keep-alive primitive. The codec accepts ping at the
	// envelope level (so ws keeps working) but the HTTP transport
	// translates that into a 400 nack.
	_, postURL, _ := newHTTPTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	status, resp, _ := postEnvelope(t, postURL, "dev-secret", map[string]any{
		"type":      "ping",
		"id":        "ping-1",
		"timestamp": "t",
		"payload":   map[string]any{},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("status: %d", status)
	}
	if resp.Type != TypeNack {
		t.Fatalf("type: %q", resp.Type)
	}
	if !strings.Contains(strings.ToLower(resp.Error), "ping") {
		t.Fatalf("error should mention ping, got %q", resp.Error)
	}
}

func TestHTTP_BodyTooLarge(t *testing.T) {
	_, postURL, _ := newHTTPTestServer(t, &fakeSubmitter{chains: map[string]bool{"base": true}})
	// 2 MiB > maxHTTPBodyBytes (1 MiB).
	huge := bytes.Repeat([]byte("x"), 2<<20)
	status, _, _ := postEnvelope(t, postURL, "dev-secret", huge)
	if status != http.StatusRequestEntityTooLarge {
		t.Fatalf("status: %d", status)
	}
}

// TestHTTP_DedupSharesCacheWithWS proves the dedup ring is per-server,
// not per-transport: a post.create over WS followed by the same id over
// HTTP must NOT re-call the submitter. This is the core invariant that
// makes "two transports, one relay" safe.
func TestHTTP_DedupSharesCacheWithWS(t *testing.T) {
	sub := &fakeSubmitter{chains: map[string]bool{"base": true}}
	httpSrv, postURL, _ := newHTTPTestServer(t, sub)
	wsURL := "ws" + strings.TrimPrefix(httpSrv.URL, "http") + "/ws"

	// First hit: WS.
	header := http.Header{}
	header.Set("Authorization", "Bearer dev-secret")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()
	mustWriteJSON(t, conn, validPostCreate("msg-cross"))
	var first Response
	mustReadJSON(t, conn, &first)
	if first.Type != TypeAck {
		t.Fatalf("ws ack expected, got %+v", first)
	}

	// Second hit: HTTP, same id. Should be a cached replay — no second
	// submitter call.
	status, resp, _ := postEnvelope(t, postURL, "dev-secret", validPostCreate("msg-cross"))
	if status != http.StatusOK {
		t.Fatalf("http status: %d", status)
	}
	if resp.Type != TypeAck || resp.MsgID != "msg-cross" {
		t.Fatalf("http resp: %+v", resp)
	}
	if got := sub.calls.Load(); got != 1 {
		t.Fatalf("cross-transport: submitter must run exactly once, got %d", got)
	}
}

