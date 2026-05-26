# example-otomato

A cookie-cutter Otomato workflow that monitors a set of security X
accounts, classifies each tweet against a list of DeFi protocols using
AI, and on a positive hit POSTs the detection to a hosted relay +
sends email alerts.

Use this as a starting point. Swap out the accounts and protocols in
`tracking.json`, point `.env` at your relay, and run `npm run create`.

---

## What you'll build

After running `npm run create`, you get a live automated pipeline inside
[builder.otomato.xyz](https://builder.otomato.xyz/). It looks like this:

![Otomato workflow builder — thatsRekt detector pipeline](assets/otomato-workflow.png)

Each column is one protocol branch. Every tweet from the monitored
accounts flows through a keyword pre-filter, then an AI classification
block (`"Return 'true' ONLY if this tweet describes a hack of <Protocol>"`),
then a condition gate that routes positive hits to the relay webhook +
email action nodes at the bottom.

**Want more alert channels?** The workflow is fully editable in the
Otomato builder after creation. Otomato supports Telegram bots, Slack
webhooks, Discord, PagerDuty, and any HTTPS endpoint as action nodes.
Open your workflow at [builder.otomato.xyz](https://builder.otomato.xyz/),
then ask your LLM to add the node type you need — or follow the
[Otomato action docs](https://docs.otomato.xyz/otomato-docs/) to wire
them in manually. You don't need to touch this script again once the
workflow exists; just edit it visually in the builder.

---

## How it works

```
twitter accounts (triggers — OR-combined)
          │  any tweet fires
          ▼
       SPLIT (fan-out, one branch per protocol)
          │
          ├──► AI("is this tweet a hack of Aave?")     → IF(eq "true") ─┬─► POST relay /detect
          ├──► AI("... Sky ...")                        → IF(eq "true") ─┤   (tweet body, metadata in headers)
          ├──► AI("... Ethena ...")                     → IF(eq "true") ─┤
          └──► AI("... Ether.fi ...")                   → IF(eq "true") ─└─► SEND_EMAIL × alertEmails
```

The AI returns the literal string `"true"` or `"false"`. The IF gate
routes to the relay + email actions only on `"true"`. No structured
output, no JSON — Otomato's binary classification is the right tool for
this pattern.

The relay receives a plain-text POST at `/detect` with tweet metadata
in headers. It synthesizes the on-chain title from `X-Protocol` +
a snippet of the tweet body.

---

## Prerequisites

- Node 20+
- An **Otomato account and API key**
  - Sign up at [app.otomato.xyz](https://app.otomato.xyz)
  - Once logged in, go to **Settings → API Keys** (or directly:
    [app.otomato.xyz/settings](https://app.otomato.xyz/settings)) and
    generate a key. This is the value for `OTOMATO_API_KEY` in `.env`.
- A **running relay** with a public URL — Railway, fly.io, ngrok, or
  any HTTPS endpoint the Otomato cloud can reach. See
  [`relay/README.md`](../relay/README.md) for setup.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure your environment

```bash
cp .env.example .env
```

Open `.env` and fill in the four required values:

| Variable           | What to put there |
|--------------------|-------------------|
| `OTOMATO_API_KEY`  | Your key from https://app.otomato.xyz/settings |
| `WEBHOOK_BASE_URL` | Public URL of your hosted relay, no trailing slash. E.g. `https://thatsrekt-production.up.railway.app` |
| `WEBHOOK_TOKEN`    | The bearer token your relay validates (`RELAY_PROVIDER_TOKEN` or equivalent env var on the relay) |
| `WEBHOOK_CHAIN`    | Chain the relay is configured for (e.g. `ethereum`, `base`, `anvil-eth`) |

### 3. Customize tracking.json

`tracking.json` controls which X accounts are monitored and which
protocols the AI classifies for. The file ships with a working template:

**Twitter accounts** — the five most-followed security feeds:
```json
"monitoredAccounts": [
  { "username": "CertiKAlert",    "includeRetweets": false },
  { "username": "zachxbt",        "includeRetweets": true  },
  { "username": "peckshield",     "includeRetweets": false },
  { "username": "lookonchain",    "includeRetweets": true  },
  { "username": "PeckShieldAlert","includeRetweets": true  }
]
```

- Set `includeRetweets: true` if you want retweets from that account to
  also trigger the pipeline. Useful for aggregators like zachxbt;
  less useful for sources that retweet noise.

**Protocols** — add, remove, or edit entries:
```json
"protocols": [
  {
    "name": "Aave",
    "twitterHandle": "aave",
    "keywords": ["aave", "AAVE", "$AAVE"]
  },
  ...
]
```

- `name` — used in the AI prompt, email subject, and the `X-Protocol`
  header sent to the relay.
- `twitterHandle` — optional. If present it's included in the AI prompt
  so the model can recognise `@mentions`.
- `keywords` — matched as **exact tokens** (not substrings). Add the
  ticker symbol variations you care about.

**Alert emails** — everyone who should receive an email when a hit fires:
```json
"alertEmails": ["your_email@example.com"]
```

Each address becomes one `SEND_EMAIL` node per protocol branch. Keep
this list short — it multiplies nodes.

### 4. Create the workflow

```bash
npm run create
```

Output:
```
Building "thatsRekt detector":
  5 X triggers
  4 protocol branches
  1 email recipients per branch
  → 26 total nodes
  webhook: https://your-relay.up.railway.app/detect  (chain=ethereum)

Workflow created — id: <uuid>
State: active
Workflow id saved to ./workflow-ids.json
```

The workflow is now live on Otomato. Any tweet from the monitored
accounts will be classified; hits fire the relay webhook + email.

---

## Verify

```bash
npm run check
```

Reads `workflow-ids.json` and prints the live state of each workflow:

```
[OK]  thatsRekt detector                active               <uuid>
```

---

## Update the workflow

Otomato has **no delta-update API**. To change the workflow:

1. Stop the old one from https://app.otomato.xyz (or delete it).
2. Edit `tracking.json` or `.env` as needed.
3. Re-run `npm run create`.

---

## Files

| Path                    | Purpose |
|-------------------------|---------|
| `tracking.json`         | Editorial config: X accounts, protocols, alert emails |
| `.env`                  | Deployment secrets + relay URL (gitignored) |
| `.env.example`          | Documented template — copy to `.env` and fill in |
| `src/config.ts`         | Zod-validated loader for `tracking.json` + env |
| `src/prompt.ts`         | Per-protocol AI classification prompt builder |
| `src/workflow.ts`       | Pure workflow builder (triggers → split → branches → edges) |
| `src/create.ts`         | `npm run create` entrypoint |
| `src/check.ts`          | `npm run check` entrypoint |
| `src/otomato-types.ts`  | SDK type augmentations |
| `workflow-ids.json`     | Auto-written after create; gitignored |

---

## Wire shape sent to the relay

```
POST {WEBHOOK_BASE_URL}/detect
Authorization:      Bearer ${WEBHOOK_TOKEN}
Content-Type:       text/plain
X-Idempotency-Key:  ${tweetId}
X-Tweet-URL:        ${tweetURL}
X-Tweet-Account:    ${account}
X-Tweet-Timestamp:  ${timestamp}
X-Chain:            ${WEBHOOK_CHAIN}
X-Protocol:         Aave
X-Tweet-Images:     ${images}

body: ${tweetContent}   ← raw tweet text, no JSON wrapping
```

The relay synthesizes the on-chain title from `X-Protocol` + a
sanitized snippet of the body.
