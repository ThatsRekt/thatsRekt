# thatsRekt — local validation stack

Self-contained `docker compose` stack that runs the full thatsRekt pipeline
on your laptop, pointed at Base Sepolia. Use this to validate end-to-end
behaviour (post → index → mesh → frontend) against a freshly-deployed
testnet contract before touching prod.

```
+---------+      +-------------------------+      +-------+      +----------+
|  user   | -->  | frontend (nginx :5173)  | -->  | mesh  | -->  | graphql  | --> postgres
| browser |      |  + /graphql proxy       |      | :4350 |      | :4357    |     :5433
+---------+      +-------------------------+      +-------+      +----------+
                                                                       ^
                                                                       |
                                                                  processor
                                                                  (Subsquid + Sepolia RPC)
```

The stack pulls the SAME images that prod uses out of DAMM's prod ECR — it
always reflects what's last shipped, no local builds required.

## What's in the stack

| Service                  | Host port              | Notes                                                      |
| ------------------------ | ---------------------- | ---------------------------------------------------------- |
| `db` (postgres:16-alpine)| `127.0.0.1:5433`       | `5433` to avoid colliding with `damm-tunnel` at `5432`.    |
| `migrate-base-sepolia`   | (one-shot)             | Runs `squid-typeorm-migration apply`, exits 0.             |
| `processor-base-sepolia` | (internal)             | Pulls Subsquid base-sepolia archive + Sepolia RPC.         |
| `graphql-base-sepolia`   | `127.0.0.1:4357`       | Per-chain squid GraphQL (handy for direct queries).        |
| `mesh`                   | `127.0.0.1:4350`       | Cross-chain stitching gateway (configured for Sepolia only).|
| `frontend` (nginx)       | `127.0.0.1:5173`       | SPA bundle + `/graphql` reverse-proxy to `mesh`.           |

What's intentionally NOT here:

- **Base mainnet** (`processor-base` / `graphql-base`) — the local stack
  focuses on Sepolia. Add it later by appending the matching services to
  `docker-compose.yml` and the matching DB to `init.sql`.
- **Notifier (Telegram)** — not needed to validate the indexer / frontend
  pipeline.
- **Autoheal** — manual `docker compose restart <svc>` is fine on a
  single host.
- **TLS / certbot** — local stack is HTTP only.
- **AWS Secrets Manager** — env vars come straight from `.env`.

## Prerequisites

- Docker Desktop running.
- AWS CLI configured with the `admin` profile (for the one-time ECR login).
- A Sepolia proxy address + the block where it was deployed (read off the
  redeploy subagent's output / Foundry broadcast JSON).

## One-time setup

```sh
# 1. Log into the prod ECR so docker can pull the images.
#    Tokens last ~12h — re-run if `docker compose pull` later 401s.
aws ecr get-login-password --region us-west-2 --profile admin \
  | docker login --username AWS --password-stdin 465910372065.dkr.ecr.us-west-2.amazonaws.com

# 2. Copy the env template.
cp .env.example .env

# 3. Open .env and fill in:
#    - POSTGRES_PASSWORD   → any non-empty value (local only)
#    - CONTRACT_BASE_SEPOLIA → the Sepolia proxy address from the latest deploy
#    - START_BLOCK_BASE_SEPOLIA → the block where it was deployed
$EDITOR .env
```

## Running the stack

```sh
docker compose up -d                  # detached
docker compose logs -f                # tail logs
docker compose ps                     # service health
docker compose down                   # stop (keep DB volume)
docker compose down -v                # nuke the DB and start fresh next time
```

After `docker compose down -v`, the next `up` re-runs `init.sql` (creates
the `thatsrekt_base_sepolia` database) and re-runs `migrate-base-sepolia`
(applies the indexer's typeorm migrations).

## Validating the stack is healthy

Run these in order — each one tests one more layer of the stack.

```sh
# 1. Frontend (HTML).
curl -s http://localhost:5173/ | head -5
# Expected: <!DOCTYPE html> ... and the SPA bundle.

# 2. Per-chain squid GraphQL — direct.
curl -s -X POST http://localhost:4357/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ posts(limit:1){ id } }"}'
# Expected: {"data":{"posts":[]}}  (or with items if Sepolia has been posted to)

# 3. Mesh gateway — direct.
curl -s -X POST http://localhost:4350/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ posts(limit:1){ items { id } } }"}'
# Expected: {"data":{"posts":{"items":[]}}}

# 4. Mesh via the frontend's /graphql reverse-proxy (full prod-shape path).
curl -s -X POST http://localhost:5173/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ posts(limit:1){ items { id } } }"}'
# Expected: same as (3).

# 5. Indexer DB has the expected tables.
docker compose exec db psql -U postgres -d thatsrekt_base_sepolia -c '\dt'
# Expected: post, attacker, voter, migrations, etc.
```

If all five succeed, you can post a transaction on the Sepolia contract
and watch it propagate up through (DB) → squid → mesh → frontend.

## Common gotchas

### Frontend `VITE_GRAPHQL_ENDPOINT` is baked at build time

The prod frontend image is built with `VITE_GRAPHQL_ENDPOINT=/graphql`
(relative). The bundle's chain registry / `REGISTRY_PROXIES` are also baked
in at build time. **If the Sepolia proxy address changes**, the frontend
image will keep pointing at the old one until it's rebuilt and re-pushed
to ECR. To validate against a fresh proxy locally, either:

- Wait for the next prod build (CI rebuilds the image when the contract
  config changes), or
- Use the `indexer/docker-compose.yml` dev stack in the repo root, which
  builds the frontend image locally with the new proxy baked in.

### Port 5173 is taken by another Vite dev server

If you already have a Vite dev server running on `5173`, change the host
port in `docker-compose.yml`:

```yaml
frontend:
  ports:
    - "127.0.0.1:5174:80"   # was 5173
```

The same applies to `5433` (postgres) and `4350` (mesh).

### `docker compose pull` returns `denied: Your authorization token has expired`

Re-run the ECR login from the one-time setup section. ECR auth tokens
expire ~12h after `docker login`.

### Indexer is stuck at block 0 / not progressing

Check the processor logs:

```sh
docker compose logs -f processor-base-sepolia
```

Common causes:

- `START_BLOCK_BASE_SEPOLIA` is set far ahead of the actual deploy block —
  fix `.env` and restart.
- Sepolia public RPC is rate-limiting — swap `RPC_BASE_SEPOLIA` for a
  paid endpoint.
- The Subsquid base-sepolia archive is behind head (rare) — the processor
  will catch up when it advances.

### Mesh returns "schema not found" / chain mismatch errors

Confirm `MESH_CHAINS=base-sepolia` in `.env` matches what's actually
running in compose. If you add Base mainnet later, both the env var and
the matching `GRAPHQL_BASE_URL` must be set on the `mesh` service.

## File map

```
local-stack/
├── docker-compose.yml   # the stack (Sepolia-only)
├── .env.example         # template — copy to .env and fill in
├── init.sql             # creates thatsrekt_base_sepolia on first boot
├── nginx.conf           # frontend container's nginx (SPA + /graphql proxy)
└── README.md            # this file
```

The shape mirrors `damm-cloud/thatsrekt/public/` (the prod EC2 stack) so
fixes here can usually be ported there with minimal translation.
