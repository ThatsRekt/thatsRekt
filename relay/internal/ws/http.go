package ws

import (
	"errors"
	"io"
	"net/http"
)

// maxHTTPBodyBytes caps the size of a single HTTP /post request body.
// One inbound envelope is a few KB; 1 MiB is a generous ceiling that
// rejects accidental misuse (e.g. a misconfigured client uploading a
// log file) without ever clipping a real payload.
const maxHTTPBodyBytes = 1 << 20 // 1 MiB

// HandleHTTP is the http.HandlerFunc for the /post endpoint. It accepts a
// single Envelope JSON body, runs it through ProcessEnvelope (the same
// shared core the websocket loop uses), and writes the resulting Response
// as JSON. HTTP status maps onto the Response.Type:
//
//	ack          → 200 OK
//	nack (decode/validation) → 400 Bad Request
//	nack (submission)        → 502 Bad Gateway
//	pong         → 400 Bad Request (ping over HTTP is meaningless and we
//	                                 refuse to encode the contradiction)
//
// Auth is bearer-token via the same Authorization header the websocket
// upgrade uses, gated BEFORE we read the body — we don't want to
// allocate a megabyte for an unauthenticated client.
func (s *Server) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	// Method gate first: HTTP semantics, not auth.
	if r.Method != http.MethodPost {
		// We set Allow per RFC 9110 §10.2.1.
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.checkAuth(r) {
		s.logger.Warn("http /post rejected: bad auth", "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// Cap body size so a malicious or buggy client can't OOM us. The
	// MaxBytesReader returns *http.MaxBytesError on overflow; we treat
	// that as a 413 to keep the contract honest with the caller.
	r.Body = http.MaxBytesReader(w, r.Body, maxHTTPBodyBytes)
	defer func() { _ = r.Body.Close() }()

	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			s.logger.Warn("http /post body too large", "limit", maxHTTPBodyBytes)
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		s.logger.Warn("http /post body read failed", "err", err)
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}

	resp := s.ProcessEnvelope(r.Context(), raw)

	// Map Response.Type → HTTP status. Ping isn't meaningful here; the
	// codec accepts ping at the envelope level and ProcessEnvelope
	// replies with TypePong. We refuse it at the HTTP edge — a request/
	// response transport with a "ping" message is a contradiction and
	// we'd rather fail loud than silently translate.
	status := http.StatusOK
	switch resp.Type {
	case TypeAck:
		status = http.StatusOK
	case TypeNack:
		// Distinguish validation errors (400) from submission failures
		// (502). The marker we have is whether any SubmissionResult is
		// present — validation errors have empty Results, submission
		// failures have at least one entry with status != "submitted".
		if len(resp.Results) == 0 {
			status = http.StatusBadRequest
		} else {
			status = http.StatusBadGateway
		}
	case TypePong:
		// Translate to a 400 — and overwrite the body so the client
		// gets a clear error instead of an unexpected pong response.
		resp = Response{Type: TypeNack, MsgID: resp.MsgID, Error: "ping not supported over HTTP"}
		status = http.StatusBadRequest
	default:
		// Defensive: any future Response.Type we forgot to handle
		// should still produce a sensible HTTP response, not a panic.
		status = http.StatusInternalServerError
	}

	body, err := EncodeResponse(resp)
	if err != nil {
		// Should not happen — Response is plain JSON-marshalable. If
		// it does, return a 500 with a hardcoded body so the client
		// sees something parseable.
		s.logger.Error("http /post response encode failed", "err", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"type":"nack","error":"response encode failed"}`))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

