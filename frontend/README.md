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
cp .env.example .env  # adjust VITE_GRAPHQL_ENDPOINT if needed
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

A multi-stage `Dockerfile` produces an `nginx:alpine`-based image that serves `dist/` on port 80. nginx config is intentionally NOT baked in — runtime environments mount their own (e.g. damm-cloud's prod compose adds a `/graphql` reverse-proxy in front of the bundle so the SPA and the Mesh gateway share an origin).

```bash
docker build -t thatsrekt-frontend ./frontend
docker run --rm -p 8080:80 thatsrekt-frontend
# http://localhost:8080 — serves the static bundle with no proxy (useful smoke test)
```

Build args (all optional):

| Build arg | Default | Purpose |
|-----------|---------|---------|
| `VITE_GRAPHQL_ENDPOINT` | `/graphql` | Relative path for same-origin Mesh proxy. Override with absolute URL for cross-origin deploys. |
| `VITE_USE_MOCK_DATA` | `false` | Set `true` to bake in the mock dataset instead of querying GraphQL. |
| `VITE_SHOW_LOCAL_FORKS` | `false` | Set `true` to expose anvil-* chains in the UI selector. |

Default `VITE_GRAPHQL_ENDPOINT=/graphql` makes the bundle **domain-agnostic**: the same image works on EC2 public DNS today and on a real domain later, no rebuild on domain change.

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
