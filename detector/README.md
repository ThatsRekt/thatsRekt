# thatsRekt detector

A small TypeScript app with two modes:

1. **`npm run mock`** — for local dev. POSTs a fake detection directly
   to the local relay, no Otomato cloud, no ngrok. This is the dev
   loop most of the time.
2. **`npm run deploy`** — for production. Builds + ships an Otomato
   workflow that monitors 8 X accounts, classifies each tweet against
   18 protocols, and on a positive hit fires a webhook back to the
   relay (over ngrok in staging, public DNS in prod) plus emails the
   alert recipients.

The mock and the real workflow speak the **same `/detect` contract** —
plain-text body, metadata in headers — so behavior verified against the
mock works against prod.

> **The relay is DAMM-internal.** It holds a private key and signs txs
> autonomously. Other whitelisted posters submit through their own
> wallets/tooling against the contract directly, not through the
> relay. The relay represents DAMM's automated AI-detected alert
> pipeline only.

## Pipeline

```
8 X account triggers
        │ any tweet fires
        ▼
   Split (parallel fan-out)
        │
        ├──► AI("true/false: is this tweet a hack of Aave?") ──► IF(eq "true") ─┬─► HTTP_REQUEST → relay /detect
        ├──► AI(... Lido ...)                                  ──► IF(eq "true") ─┤   (raw tweet body, metadata in headers)
        ├──► ...                                                                  └─► 5× SEND_EMAIL (jerry, bauti, team, one, bouda)
        └──► 18 protocol branches total
```

## Local dev (mock — no Otomato, no ngrok)

```bash
# from repo root:
cd ops && make lan-up && make anvil-bootstrap && make relay-up
cd ../detector && npm install
npm run mock
```

What happens: the mock reads the relay's bearer token from
`/tmp/thatsrekt-relay.token` (written by `make relay-up`), constructs
the same `/detect` envelope Otomato would send, and POSTs it to
`http://127.0.0.1:8080/detect`. The relay signs and submits a real
on-chain `post(...)`. Watch it land at `http://localhost:5173`.

Override defaults with flags:

```bash
npm run mock -- --protocol Lido
npm run mock -- --protocol Aave --tweet "Aave V3 drained, $12M moved"
npm run mock -- --images https://pbs.twimg.com/media/a.jpg,https://pbs.twimg.com/media/b.jpg
npm run mock -- --account peckshield --idem-key my-test-1
```

The Makefile target `make detector-mock MOCK_ARGS="--protocol Lido"` is
the same thing.

## Production deploy (real Otomato, real X accounts)

```bash
cp .env.example .env
# edit .env:
#   OTOMATO_API_KEY=<your key>
#   WEBHOOK_BASE_URL=<your public/ngrok URL — e.g. https://abcd.ngrok-free.app>
#   WEBHOOK_TOKEN=<must match RELAY_PROVIDER_TOKEN on the running relay>
#   WEBHOOK_CHAIN=anvil-eth
npm install
npm run deploy
```

For staging against the local stack, run `make detector-up` first —
that brings up relay + ngrok + writes the webhook fields into `.env`
for you, then you set `OTOMATO_API_KEY` and run the deploy.

Output:

```
Building "thatsRekt detector":
  8 X triggers
  18 protocol branches
  5 email recipients per branch
  → 153 total nodes
  webhook: https://abcd.ngrok-free.app/detect (chain=anvil-eth)
Workflow created — id: <uuid>
State: active
Workflow id saved to ./workflow-ids.local.json
```

## Verify

```bash
npm run check
```

Reads the saved workflow id and asks Otomato for current state.

## Redeploy (after editing tracking.json or env)

```bash
npm run redeploy
```

Stops the previously deployed workflow and ships a fresh one. Otomato
has no in-place delta-update; redeploy is the only way to change
config.

## Files

| Path                        | Purpose |
|-----------------------------|---------|
| `tracking.json`             | Editorial config: monitored X accounts, protocols, alert emails |
| `.env`                      | Deployment-time secrets + the webhook target (gitignored) |
| `src/config.ts`             | Zod-validated config loader (tracking.json + env) |
| `src/prompt.ts`             | Per-protocol AI classification prompt |
| `src/workflow.ts`           | Pure workflow builder (triggers + split + branches + edges) |
| `src/deploy.ts`             | `npm run deploy` entrypoint (prod) |
| `src/check.ts`              | `npm run check` entrypoint |
| `src/redeploy.ts`           | `npm run redeploy` entrypoint |
| `src/mock.ts`               | `npm run mock` — local-dev fake detection (no Otomato) |
| `src/otomato-types.ts`      | Type augmentation for `otomato-sdk@2.0.557` (its `.d.ts` is stale relative to runtime) |
| `workflow-ids.local.json`   | Auto-written after deploy; gitignored |

## Wire shape sent to the relay

```
POST {WEBHOOK_BASE_URL}/detect
Authorization: Bearer ${WEBHOOK_TOKEN}
Content-Type: text/plain
X-Idempotency-Key: ${tweetId}
X-Tweet-URL:       ${tweetURL}
X-Tweet-Account:   ${account}
X-Tweet-Timestamp: ${timestamp}
X-Chain:           ${WEBHOOK_CHAIN}
X-Protocol:        Aave
X-Tweet-Images:    ${images}        (Otomato serializes the array; relay parses defensively)

body: ${tweetContent}                (raw tweet text — no JSON wrapping)
```

The relay synthesizes the on-chain title server-side from
`X-Protocol` + a sanitized snippet of the body. Image URLs (if any)
are appended to the on-chain `note` for the frontend to render.

## What the workflow does NOT do

- **No structured AI output.** Otomato's AI block is binary-classification-
  oriented and the downstream IF gate only supports `eq`/`neq` (no
  substring match). Trying to ship `{hacked, title, attackers, victims}`
  through Otomato's IF gate doesn't work; we instead let the AI just
  say "true" or "false" and have the relay synthesize the title.
- **No address extraction.** v1 posts have empty `attackers[]` /
  `victims[]`. A future enhancement is to regex-extract `0x...{40}`
  matches from the tweet body in the relay; or to add a second AI step
  that returns a structured payload after classification.
- **No multi-chain dispatch.** Single chain (`WEBHOOK_CHAIN`) per
  workflow. Multi-chain fan-out is a relay sub-phase B concern.

## Background

Patterned on Jerry's prior work (`rektSDK`) which deployed an
email-only version of this workflow at Otomato. We rebuilt it from
scratch in TS rather than forking the rektSDK code, keeping the same
otomato-sdk patterns but adapting the workflow shape to add the
on-chain submission and (eventually) richer alert content.
