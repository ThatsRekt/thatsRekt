# thatsRekt Frontend

Static, IPFS-compatible web app that browses the thatsRekt registry. Two views:

- **Feed** — most recent posts (excludes retracted), click into a card for details.
- **Post detail** — full post fields plus a chronological timeline of votes and edits.

## Stack

| Concern | Choice |
|---------|--------|
| Build tool | Vite |
| Framework | React 19 + TypeScript |
| Styling | Tailwind v3 |
| Routing | `react-router-dom` with `HashRouter` (IPFS gateway safe) |
| Data | `@tanstack/react-query` + `graphql-request` |
| GraphQL endpoint | env-configurable via `VITE_GRAPHQL_ENDPOINT` (default `http://localhost:4350/graphql`) |

## Prereqs

- Node.js ≥ 20
- pnpm ≥ 10
- A running indexer with GraphQL exposed (default: `cd ../indexer && docker compose up -d --build`)

## Local dev

```bash
pnpm install
cp .env.example .env  # set VITE_PUBLIC_RPC_* HTTPS URLs; adjust GraphQL if needed
pnpm dev              # http://localhost:5173
```

## Production build

```bash
pnpm build
# outputs to dist/

pnpm preview          # http://localhost:4173 — smoke-test the static bundle
```

`dist/` contains:
- `index.html` (with relative asset paths via `base: './'`)
- `assets/` (chunked JS + CSS + sourcemaps off)
- `favicon.svg`

Total bundle size: ~330 KB uncompressed, ~99 KB gzipped (split into a React chunk, a query/graphql chunk, and the app entry).

## Docker (containerized prod build)

A multi-stage `Dockerfile` produces an `nginx:alpine`-based image that serves `dist/` on port 80. nginx config is intentionally NOT baked in — runtime environments mount their own. The expected prod pattern is to mount a config that adds a `/graphql` reverse-proxy in front of the bundle so the SPA and the Mesh gateway share an origin (the bundle was built with `VITE_GRAPHQL_ENDPOINT=/graphql` for exactly this reason).

```bash
docker build -t thatsrekt-frontend ./frontend
docker run --rm -p 8080:80 thatsrekt-frontend
# http://localhost:8080 — serves the static bundle with no proxy (useful smoke test)
```

Build configuration:

| Build arg | Default | Purpose |
|-----------|---------|---------|
| `VITE_GRAPHQL_ENDPOINT` | `/graphql` | Relative path for same-origin Mesh proxy. Override with absolute URL for cross-origin deploys. |
| `VITE_PUBLIC_RPC_ETHEREUM_URL` | required HTTPS URL | Browser-side Ethereum RPC endpoint. |
| `VITE_PUBLIC_RPC_BASE_URL` | required HTTPS URL | Browser-side Base RPC endpoint. |
| `VITE_PUBLIC_RPC_ARBITRUM_URL` | required HTTPS URL | Browser-side Arbitrum RPC endpoint. |
| `VITE_PUBLIC_RPC_OPTIMISM_URL` | required HTTPS URL | Browser-side Optimism RPC endpoint. |
| `VITE_PUBLIC_RPC_BSC_URL` | required HTTPS URL | Browser-side BNB Chain RPC endpoint. |
| `VITE_PUBLIC_RPC_POLYGON_URL` | required HTTPS URL | Browser-side Polygon RPC endpoint. |
| `VITE_USE_MOCK_DATA` | `false` | Set `true` to bake in the mock dataset instead of querying GraphQL. |
| `VITE_SHOW_LOCAL_FORKS` | `false` | Set `true` to expose anvil-* chains in the UI selector. |

Default `VITE_GRAPHQL_ENDPOINT=/graphql` makes the bundle **domain-agnostic**: the same image works on EC2 public DNS today and on a real domain later, no rebuild on domain change.

The six public RPC variables are required and validated as HTTPS URLs. Production
uses browser-safe RouteMesh keys restricted to the public thatsRekt domains; no
RPC endpoint is hard-coded as a fallback.

## IPFS hosting (when ready)

The build is intentionally constrained for IPFS hosting:

- **Relative paths** (`base: './'`): assets resolve correctly under any gateway prefix (`https://<gateway>/ipfs/<cid>/...`).
- **HashRouter**: client routes live in the URL fragment (`/#/post/123`), so deep links work without server-side `index.html` fallback.
- **No SSR, no API routes**: pure CSR.
- **All env config inlined at build time**: the deployed bundle is fully self-contained.

To pin (when Phase 7 of the indexer rollout is ready):

```bash
pnpm build
ipfs add -r dist/
# Then publish CID via ENS contenthash for thatsrekt.eth.
```

## Configuration

`.env` (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `VITE_GRAPHQL_ENDPOINT` | URL of the squid GraphQL server. Inlined at build time. |

## Plan

Implementation plan + decision log: [`tasks/frontend-plan.md`](./tasks/frontend-plan.md).
