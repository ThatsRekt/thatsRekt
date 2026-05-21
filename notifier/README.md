# thatsRekt notifier

Long-running Go service that polls the public thatsRekt GraphQL gateway for new posts and broadcasts them to a Telegram channel with cosmetic ✓/✗ vote buttons.

## Why

The on-chain registry already supports `confirm` / `disconfirm` from any whitelisted poster. This service is a **read-side amplifier** — it pushes alerts out to a Telegram audience that may not be running browser tabs against the site.

Each message is a **self-contained v2 on-chain alert**: a header line (`🚨 HACK VERIFIED`), a relative-time + attacked-chain line, a revision counter, a one-line summary, attacker/victim addresses linked to block explorers, exploit tx hashes, and source attribution — all derived directly from the on-chain note. No reliance on Telegram link-preview OG cards. The vote buttons are purely Telegram-side engagement signals; canonical truth lives on-chain.

## Footprint

- **Container**: `FROM scratch` final image, ~10–12 MB. Just a static Go binary + CA certs.
- **Memory**: ~20 MB resident. No persistent connections except long-poll to Telegram.
- **State**: a single ~few-KB JSON blob in S3. No database, no Redis, no DynamoDB.
- **Cost**: a 256 MB / 0.25 vCPU Fargate task running 24/7 is ~$3–5/mo.

## Architecture

```
┌──────────────────┐   poll /graphql every 10s    ┌──────────────────┐
│  thatsRekt Mesh  │◄─────────────────────────────│                  │
│   (GraphQL)      │                              │                  │
└──────────────────┘                              │                  │
                                                  │     notifier     │  long-poll
┌──────────────────┐                              │      (Go)        │◄──────────┐
│  S3 state        │◄────flush every 15s──────────│                  │           │
│  (JSON blob)     │                              │                  │     ┌─────┴─────┐
└──────────────────┘                              └────┬─────────────┘     │ Telegram  │
                                                       │                   │  Bot API  │
                                                       │ sendMessage /     └─────┬─────┘
                                                       │ editMessageReplyMarkup  │
                                                       ▼                         │
                                                ┌──────────────┐                 │
                                                │  Channel     │◄────────────────┘
                                                └──────────────┘
```

Two goroutines:

1. **Poll loop** — every `POLL_INTERVAL_SECONDS` (default 10), `GET posts(limit, offset)`, dedupe against per-chain high-water marks in `Store`, post each new one to Telegram, record the resulting `message_id`.
2. **Callback loop** — long-polls `getUpdates` for `callback_query` events. On a press, mutate the cosmetic counter in `Store`, edit the message's reply_markup to refresh the keyboard, ack the callback so the user's client stops spinning.

State is flushed to S3 on a 15-second timer + on clean shutdown.

## Configuration

| env | required | default | notes |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | from @BotFather |
| `CHANNEL_ID` | yes | — | `@thatsrekt_alerts` for public channels, or numeric `-100…` |
| `STATE_S3_BUCKET` | yes | — | bucket holding the state JSON |
| `STATE_S3_KEY` | no | `thatsrekt-notifier/state.json` | object key inside the bucket |
| `GRAPHQL_URL` | no | `https://thatsrekt.com/graphql` | thatsRekt Mesh endpoint |
| `POLL_INTERVAL_SECONDS` | no | `10` | how often to poll for new posts |
| `FETCH_LIMIT` | no | `25` | how many posts to ask for per cycle |

### IAM

The service's task role needs:

- `s3:GetObject`, `s3:PutObject` on `arn:aws:s3:::<STATE_S3_BUCKET>/<STATE_S3_KEY>`

That's it — Telegram and thatsRekt's GraphQL are public-internet HTTP, no AWS perms required.

## Local dev

```bash
cd notifier
go mod download

BOT_TOKEN=…  CHANNEL_ID=@thatsrekt_alerts \
STATE_S3_BUCKET=damm-thatsrekt-notifier-state \
AWS_PROFILE=admin \
go run ./cmd/notifier
```

A `BOT_TOKEN` is needed even for local dev — there's no mock layer. Use a personal test bot pointed at a private test channel; flip the env vars to prod when satisfied.

## Multi-chain readiness

The poll loop calls the unified `posts(limit, offset)` query without specifying chains. When thatsRekt deploys to Optimism / Arbitrum / etc., posts on the new chain start appearing in the Mesh response automatically and the bot picks them up with no code change. Per-chain dedup prevents whipsaw when one chain catches up to a delayed indexer for another.

## Deploy

The CI workflow at `.github/workflows/build.yml` already iterates a `services` matrix; add `notifier` to that list and push a `notifier:latest` image to ECR. The damm-cloud Terraform for the Fargate task / IAM role / log group lives in [`damm-cloud/terraform/thatsrekt-notifier.tf`](https://github.com/DAMM-Cap/damm-cloud) (separate PR).
