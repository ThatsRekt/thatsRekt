# syntax=docker/dockerfile:1.7

# Multi-stage build: builder (vite build) -> runtime (nginx alpine).
# Final image is alpine-based and contains only the static `dist/` bundle
# served by nginx. nginx config is intentionally NOT baked in — runtime
# environments mount their own (e.g. damm-cloud's prod compose adds a
# /graphql reverse-proxy in front of the bundle). Standalone use falls
# back to the nginx:alpine default config (serves /usr/share/nginx/html
# on :80) — useful for local prod-image smoke tests.

ARG NODE_VERSION=20-alpine
ARG PNPM_VERSION=10.33.2

# --- Stage 1: install + tsc + vite build -----------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Install dependencies first (cache-friendly: only re-runs on lockfile change).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build inputs.
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts postcss.config.js tailwind.config.js index.html ./
COPY public ./public
COPY src ./src

# Build-time env. `VITE_GRAPHQL_ENDPOINT=/graphql` (relative) makes the
# bundle domain-agnostic — the same image works on EC2 public DNS today
# and on a real domain later, no rebuild needed.
ARG VITE_GRAPHQL_ENDPOINT=/graphql
ARG VITE_USE_MOCK_DATA=false
ARG VITE_SHOW_LOCAL_FORKS=false
ARG VITE_SHOW_TESTNETS=false
# Cloudflare Turnstile public site key. Empty default on purpose: an unset
# build arg leaves the runtime fallback to Cloudflare's always-pass TEST
# site key (see ApplyForm.tsx), so local and non-prod image builds need no
# real key. Prod CI passes the real key via --build-arg. The site key is
# public (it ships in the bundle); the secret key lives only in mesh env.
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_GRAPHQL_ENDPOINT=${VITE_GRAPHQL_ENDPOINT}
ENV VITE_USE_MOCK_DATA=${VITE_USE_MOCK_DATA}
ENV VITE_SHOW_LOCAL_FORKS=${VITE_SHOW_LOCAL_FORKS}
ENV VITE_SHOW_TESTNETS=${VITE_SHOW_TESTNETS}
ENV VITE_TURNSTILE_SITE_KEY=${VITE_TURNSTILE_SITE_KEY}

RUN pnpm build

# --- Stage 2: nginx runtime -------------------------------------------------
FROM nginx:alpine AS runtime

# Static bundle.
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx default config (from the base image) serves /usr/share/nginx/html
# on :80 with no proxy. Override at runtime by mounting a custom config
# at /etc/nginx/conf.d/default.conf:
#
#   docker run -v ./public.conf:/etc/nginx/conf.d/default.conf:ro ...
#
# The damm-cloud prod compose mounts a config that adds /graphql ->
# mesh:4350 reverse-proxy, so the SPA and the GraphQL gateway share an
# origin and the bundle's relative-path fetches just work.

EXPOSE 80
