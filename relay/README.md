# thatsRekt relay server (sub-phase A)

A Go websocket service that receives hack alerts from an external AI
detection provider and submits them on-chain to the thatsRekt registry as
a whitelisted poster. Sub-phase A scope: single chain, env-key signer,
`post.create` only. See `tasks/relay-server-design.md` (in the repo root)
for the full design and the boundary against sub-phases B/C.

## What this build implements

- Websocket endpoint at `:8080/ws` (configurable).
- Bearer-token auth on the upgrade handshake; bad/missing token returns
  HTTP 401 BEFORE any websocket frames are exchanged.
- Wire envelope decode with strict structural validation (unknown fields
  rejected on payloads).
- `post.create` submission against one configured chain, env-key signer.
- Receipt-wait + decode of `PostCreated` to populate `post_id` in the ack.
- 15-minute in-memory dedup ring; replays the cached response instead of
  re-submitting.
- Structured JSON logs via `log/slog`.

## What this build does NOT implement (deferred)

- Multi-chain dispatch (`chains: ["base","ethereum"]`, `chains: "all"`).
- Per-chain worker pool / explicit nonce manager.
- AWS KMS / PKCS#11 signers.
- `post.amend_*` / `post.add_*` message types.
- Prometheus metrics.
- Rate limiting.

## Build

```sh
go build ./...
```

## Test

```sh
go test ./...
go test -race ./...
```

Unit coverage:
- envelope + payload decode (valid, malformed, missing fields, unknown fields)
- response encoding (omitempty handling, success + error shapes)
- dedup ring (TTL, FIFO eviction, concurrent get/put, fake-clock expiry)
- ws server (auth, ack happy path, dedup replay, malformed nack, ping/pong)

## Run

Configuration is environment-only for sub-phase A.

| Var | Required | Description |
|-----|----------|-------------|
| `RELAY_PROVIDER_TOKEN` | yes | Bearer token clients must send. |
| `RELAY_PRIVATE_KEY` | yes | Hex-encoded ECDSA private key (with or without `0x`). |
| `RELAY_RPC_URL` | yes | RPC endpoint for the configured chain. |
| `RELAY_CONTRACT_ADDRESS` | yes | thatsRekt proxy address. |
| `RELAY_CHAIN_ID` | yes | Numeric EIP-155 chain id. The relay verifies this against the RPC at startup and refuses to start on mismatch. |
| `RELAY_CHAIN_NAME` | no | Default `base`. The string clients put in `chains:[...]` to address this relay. |
| `RELAY_LISTEN_ADDR` | no | Default `:8080`. |
| `RELAY_WS_PATH` | no | Default `/ws`. |
| `RELAY_DEDUP_WINDOW` | no | Default `15m`. Go duration syntax. |
| `RELAY_RECEIPT_TIMEOUT` | no | Default `60s`. |
| `RELAY_LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`. Default `info`. |

Example:

```sh
RELAY_PROVIDER_TOKEN=dev-secret \
RELAY_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
RELAY_RPC_URL=http://127.0.0.1:8545 \
RELAY_CONTRACT_ADDRESS=0x... \
RELAY_CHAIN_ID=31337 \
RELAY_CHAIN_NAME=anvil-eth \
go run ./cmd/relay
```

## Wire protocol

Inbound message:

```json
{
  "type": "post.create",
  "id": "msg-<uuid>",
  "timestamp": "2026-04-27T22:00:00Z",
  "payload": {
    "chains": ["base"],
    "title": "Aave drainer detected",
    "attackers": ["0xdead..."],
    "victims": ["0xbeef..."],
    "note": "Initial scoping",
    "attacked_at": 1777340000
  }
}
```

Successful response:

```json
{
  "type": "ack",
  "msg_id": "msg-<uuid>",
  "results": [
    {
      "chain": "base",
      "status": "submitted",
      "tx_hash": "0x...",
      "post_id": "42"
    }
  ]
}
```

Failure response (validation failure or chain submission failure):

```json
{
  "type": "nack",
  "msg_id": "msg-<uuid>",
  "error": "payload.title is empty"
}
```

The relay also responds to `{"type":"ping","id":"..."}` with
`{"type":"pong","msg_id":"..."}` for keepalive.

## Validation policy (pure relay)

The relay validates only:

- envelope shape (type, id, timestamp present)
- `chains` non-empty (no auto-fill)
- `title` non-empty (the contract enforces the byte cap)
- `attacked_at > 0`
- addresses in `attackers` / `victims` are 20-byte hex (so we don't
  silently submit malformed-but-valid-looking data)

Everything else — title byte cap, address-array length cap, dedup,
authorization (`isWhitelisted`), `attacked_at` not-in-future — is the
contract's policy. If the chain rejects, the relay returns a nack with the
RPC error verbatim.

## Layout

```
relay/
├── cmd/relay/main.go              # entrypoint, env config, http+ws wiring
├── internal/
│   ├── ws/
│   │   ├── server.go              # gorilla/websocket handler + dispatch
│   │   ├── codec.go               # envelope/payload encode/decode + validation
│   │   ├── auth.go                # constant-time bearer-token compare
│   │   ├── codec_test.go
│   │   └── server_test.go         # auth + ack + dedup + nack + ping/pong
│   ├── dispatcher/
│   │   ├── dispatcher.go          # SubmitPostCreate against configured chains
│   │   └── receipt.go             # WaitMined + PostCreated log decode
│   ├── signer/
│   │   ├── signer.go              # interface — extension seam for KMS/PKCS#11
│   │   └── env.go                 # env-key implementation
│   ├── chain/
│   │   └── client.go              # ethclient + binding wrapper, chain-id verify
│   ├── thatsrekt/
│   │   └── thatsrekt.go           # abigen-generated bindings (DO NOT EDIT)
│   └── dedup/
│       ├── ring.go                # in-memory TTL cache
│       └── ring_test.go
├── abi/
│   └── ThatsRekt.json             # canonical ABI, copied from indexer/abi
├── scripts/
│   ├── smoke-test.sh              # end-to-end test against fresh anvil
│   └── wsclient/main.go           # one-shot ws client used by smoke test
├── go.mod
├── go.sum
└── README.md
```

The `abi/ThatsRekt.json` is the same file as `indexer/abi/ThatsRekt.json`.
The bindings under `internal/thatsrekt/` are regenerated with:

```sh
abigen --abi abi/ThatsRekt.json --pkg thatsrekt --type ThatsRekt \
       --out internal/thatsrekt/thatsrekt.go
```

## End-to-end smoke test

`scripts/smoke-test.sh` runs the full path: spins up anvil on port 18545,
deploys thatsRekt via the existing `contracts/script/anvil/bootstrap.sh`,
generates a fresh EOA and whitelists it (impersonating the timelock),
launches the relay against that EOA, and exercises:

1. Valid `post.create` produces an ack with non-empty `tx_hash` and `post_id`.
2. On-chain `postCount() == 1` and `postTitle(1)` matches the sent title.
3. Replaying the same envelope `id` returns the cached ack and does NOT
   submit a second tx (`postCount` stays at 1).
4. A malformed message (empty title) returns a nack whose `error` mentions
   the field.

Run it from any working directory; it locates the repo root via
`scripts/` ancestry.

```sh
./relay/scripts/smoke-test.sh
```

Prereqs on PATH: `anvil`, `cast`, `forge`, `jq`, `go`.

The script uses anvil port `18545` and relay port `18080` to avoid
conflicting with a long-running anvil from the indexer's docker setup.

## Security notes

- The env-key signer holds the private key in process memory for the
  process lifetime. For any deployment that posts to mainnet, switch to
  KMS — that's the sub-phase B work.
- The chain id is bound into the signer at construction time. Replay
  protection cannot be bypassed by passing a different chain id at submit
  time.
- The relay verifies the RPC's reported chain id against the configured
  chain id at startup. A wrong RPC pointing at a different chain refuses
  to start instead of silently signing a tx for the wrong chain.
- Bearer-token compare is constant-time (modulo a length-leak that's
  acceptable for an operator-set token).
- The websocket upgrade rejects unauthenticated requests with HTTP 401
  BEFORE the upgrade completes, so the auth boundary is HTTP-level.
