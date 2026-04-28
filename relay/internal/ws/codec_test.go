package ws

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeEnvelope_Valid(t *testing.T) {
	raw := []byte(`{
		"type":"post.create",
		"id":"msg-abc",
		"timestamp":"2026-04-27T22:00:00Z",
		"payload":{"x":1}
	}`)
	env, err := DecodeEnvelope(raw)
	if err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
	if env.Type != TypePostCreate {
		t.Fatalf("type: got %q", env.Type)
	}
	if env.ID != "msg-abc" {
		t.Fatalf("id: got %q", env.ID)
	}
	var p struct{ X int }
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.X != 1 {
		t.Fatalf("payload roundtrip: %v %+v", err, p)
	}
}

func TestDecodeEnvelope_Errors(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want error
	}{
		{"junk", `{not json`, ErrPayloadDecode},
		{"missing type", `{"id":"x","timestamp":"t","payload":{}}`, ErrEmptyType},
		{"missing id", `{"type":"post.create","timestamp":"t","payload":{}}`, ErrEmptyID},
		{"unknown type", `{"type":"post.create.evil","id":"x","timestamp":"t","payload":{}}`, ErrUnknownType},
		{"ping ok shape", `{"type":"ping","id":"x","timestamp":"t","payload":{}}`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeEnvelope([]byte(tc.raw))
			if tc.want == nil {
				if err != nil {
					t.Fatalf("expected ok, got %v", err)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err: want %v, got %v", tc.want, err)
			}
		})
	}
}

func TestDecodePostCreatePayload_Valid(t *testing.T) {
	raw := []byte(`{
		"chains":["base"],
		"title":"Aave drainer detected",
		"attackers":["0x0000000000000000000000000000000000000001"],
		"victims":["0x0000000000000000000000000000000000000002"],
		"note":"context here",
		"attacked_at":1777340000
	}`)
	p, err := DecodePostCreatePayload(raw)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(p.Chains) != 1 || p.Chains[0] != "base" {
		t.Fatalf("chains: %+v", p.Chains)
	}
	if p.Title != "Aave drainer detected" {
		t.Fatalf("title: %q", p.Title)
	}
	if len(p.Attackers) != 1 || len(p.Victims) != 1 {
		t.Fatalf("addrs: %+v %+v", p.Attackers, p.Victims)
	}
	if p.AttackedAt != 1777340000 {
		t.Fatalf("attacked_at: %d", p.AttackedAt)
	}
}

func TestDecodePostCreatePayload_AllowsEmptyAddressArrays(t *testing.T) {
	// The contract permits a pure-headline alert (title only). The relay
	// must mirror that — empty attackers/victims is NOT a validation error.
	raw := []byte(`{
		"chains":["base"],
		"title":"Heads up: chain-wide drainer",
		"attackers":[],
		"victims":[],
		"note":"",
		"attacked_at":1
	}`)
	p, err := DecodePostCreatePayload(raw)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if p.Attackers == nil || p.Victims == nil {
		t.Fatalf("nil arrays not normalized")
	}
}

func TestDecodePostCreatePayload_ValidationErrors(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want error
	}{
		{"empty chains array", `{"chains":[],"title":"t","attackers":[],"victims":[],"note":"n","attacked_at":1}`, ErrEmptyChains},
		{"empty chain string", `{"chains":[""],"title":"t","attackers":[],"victims":[],"note":"n","attacked_at":1}`, ErrEmptyChains},
		{"empty title", `{"chains":["base"],"title":"","attackers":[],"victims":[],"note":"n","attacked_at":1}`, ErrEmptyTitle},
		{"zero attacked_at", `{"chains":["base"],"title":"t","attackers":[],"victims":[],"note":"n","attacked_at":0}`, ErrInvalidAttackAt},
		{"empty payload", ``, ErrPayloadDecode},
		{"unknown field", `{"chains":["base"],"title":"t","attackers":[],"victims":[],"note":"n","attacked_at":1,"oops":true}`, ErrPayloadDecode},
		{"junk", `not json`, ErrPayloadDecode},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodePostCreatePayload([]byte(tc.raw))
			if !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}
}

func TestEncodeResponse_Roundtrip(t *testing.T) {
	r := Response{
		Type:  TypeAck,
		MsgID: "msg-1",
		Results: []SubmissionResult{
			{Chain: "base", Status: "submitted", TxHash: "0xabc", PostID: "42"},
		},
	}
	b, err := EncodeResponse(r)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{`"type":"ack"`, `"msg_id":"msg-1"`, `"chain":"base"`, `"tx_hash":"0xabc"`, `"post_id":"42"`} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %s", want, s)
		}
	}
}

func TestEncodeResponse_OmitsEmptyFields(t *testing.T) {
	// On a top-level decode failure we have no msg_id; verify it's omitted.
	r := Response{Type: TypeNack, Error: "bad json"}
	b, err := EncodeResponse(r)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if strings.Contains(s, "msg_id") {
		t.Errorf("msg_id should be omitted: %s", s)
	}
	if !strings.Contains(s, `"error":"bad json"`) {
		t.Errorf("missing error: %s", s)
	}
}
