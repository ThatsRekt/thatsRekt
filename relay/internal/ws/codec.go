// Package ws contains the websocket transport for the thatsRekt relay.
//
// This file (codec.go) defines the wire envelope and payload types exchanged
// between the AI provider and the relay, plus a small set of validators that
// reject malformed messages BEFORE we touch the chain. The relay is a pure
// relay — these validators only check envelope shape and the minimum a sane
// caller could not have meant. Semantic validation (address format, length
// caps, etc.) is the contract's job. See tasks/relay-server-design.md.
package ws

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// bytesReader returns an io.Reader over b without copying. Centralized so
// we don't sprinkle bytes.NewReader calls through the codec.
func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

// Message types. Sub-phase A only handles `post.create`; the constants for
// the deferred update flows are intentionally omitted here so a typo in a
// future PR doesn't silently route through an unhandled branch.
const (
	TypePostCreate = "post.create"
	TypePing       = "ping"

	TypeAck  = "ack"
	TypeNack = "nack"
	TypePong = "pong"
)

// Envelope is the outer wrapper for every inbound message. The payload is
// kept as raw JSON so we can defer type-specific decoding until we know the
// `Type` field — avoids parsing a payload shape we don't care about.
type Envelope struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

// PostCreatePayload mirrors the `post.create` payload from the design doc.
//
// Field-by-field policy:
//   - Chains: non-empty. Sub-phase A submits to one chain; B will fan out.
//     The relay does NOT default-fill this — empty array is a nack.
//   - Title: required. The contract enforces the byte cap; the relay only
//     rejects empty so we don't burn a tx on a guaranteed revert.
//   - Attackers/Victims: passed through as-is. No address-format checks
//     here — the contract's `ZeroAddress` / dedup checks are the policy
//     layer. JSON unmarshal will reject obviously non-string entries.
//   - Note: passed through as-is. Empty is allowed (the contract permits it).
//   - AttackedAt: must be > 0 (the contract reverts on 0). We mirror the
//     check so the nack arrives instantly instead of after a failed RPC.
type PostCreatePayload struct {
	Chains     []string `json:"chains"`
	Title      string   `json:"title"`
	Attackers  []string `json:"attackers"`
	Victims    []string `json:"victims"`
	Note       string   `json:"note"`
	AttackedAt uint64   `json:"attacked_at"`
}

// SubmissionResult is one entry of the `results` array in an ack/nack.
//
// Status values:
//   - "submitted": the tx was accepted by the RPC. tx_hash and post_id are
//     populated (post_id from the receipt log).
//   - "failed":    submission was attempted but the RPC or the receipt
//     reported failure. error is populated.
//   - "skipped":   reserved for sub-phase B (chain not configured, etc.).
type SubmissionResult struct {
	Chain   string `json:"chain"`
	Status  string `json:"status"`
	TxHash  string `json:"tx_hash,omitempty"`
	PostID  string `json:"post_id,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Response is what the relay sends back after processing a message.
type Response struct {
	Type    string             `json:"type"`              // "ack" | "nack" | "pong"
	MsgID   string             `json:"msg_id,omitempty"`  // echoed for everything except plain pong
	Results []SubmissionResult `json:"results,omitempty"` // populated for ack/nack
	Error   string             `json:"error,omitempty"`   // top-level error for envelope-level failures (e.g. malformed JSON)
}

// Validation errors. Stable strings — they appear in the wire response.
var (
	ErrEmptyType       = errors.New("envelope.type is empty")
	ErrEmptyID         = errors.New("envelope.id is empty")
	ErrUnknownType     = errors.New("envelope.type is not recognized")
	ErrPayloadDecode   = errors.New("payload could not be decoded")
	ErrEmptyChains     = errors.New("payload.chains is empty")
	ErrEmptyTitle      = errors.New("payload.title is empty")
	ErrInvalidAttackAt = errors.New("payload.attacked_at must be > 0")
)

// DecodeEnvelope unmarshals raw bytes into an Envelope and runs the minimum
// set of structural checks. It does NOT decode the payload — call
// DecodePostCreatePayload after dispatching on Type.
func DecodeEnvelope(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, fmt.Errorf("%w: %v", ErrPayloadDecode, err)
	}
	if env.Type == "" {
		return env, ErrEmptyType
	}
	// We require an id even for ping so we can correlate logs end-to-end.
	if env.ID == "" {
		return env, ErrEmptyID
	}
	switch env.Type {
	case TypePostCreate, TypePing:
		// known
	default:
		return env, fmt.Errorf("%w: %q", ErrUnknownType, env.Type)
	}
	return env, nil
}

// DecodePostCreatePayload unmarshals + validates a post.create payload.
//
// Validation is deliberately minimal — see the doc comment on
// PostCreatePayload for the per-field reasoning. We DO NOT:
//   - check address checksums or hex length (the contract reverts cleanly
//     on invalid data; address parsing happens at the dispatcher layer
//     via common.HexToAddress, which is forgiving but won't silently
//     truncate)
//   - default-fill any field
//   - cap title length (the contract owns that policy)
//   - check attacked_at against block.timestamp (the relay doesn't have
//     a clock authoritative for the chain; the contract reverts if the
//     timestamp is in the future)
func DecodePostCreatePayload(raw json.RawMessage) (PostCreatePayload, error) {
	var p PostCreatePayload
	if len(raw) == 0 {
		return p, fmt.Errorf("%w: empty payload", ErrPayloadDecode)
	}
	dec := json.NewDecoder(bytesReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return p, fmt.Errorf("%w: %v", ErrPayloadDecode, err)
	}
	if len(p.Chains) == 0 {
		return p, ErrEmptyChains
	}
	for _, c := range p.Chains {
		if c == "" {
			return p, fmt.Errorf("%w: chain entry is empty string", ErrEmptyChains)
		}
	}
	if p.Title == "" {
		return p, ErrEmptyTitle
	}
	if p.AttackedAt == 0 {
		return p, ErrInvalidAttackAt
	}
	// Attackers and victims may be empty arrays — the contract allows
	// pure-headline alerts (title only). We mirror that.
	if p.Attackers == nil {
		p.Attackers = []string{}
	}
	if p.Victims == nil {
		p.Victims = []string{}
	}
	return p, nil
}

// EncodeResponse marshals a Response to JSON. Kept as a thin wrapper so the
// transport layer doesn't pull encoding/json directly and so we have one
// place to add wire-version sniffing later if needed.
func EncodeResponse(r Response) ([]byte, error) {
	return json.Marshal(r)
}
