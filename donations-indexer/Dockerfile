# syntax=docker/dockerfile:1.7

# Multi-stage build: deps -> builder -> proddeps -> runtime.
# Final image contains only production node_modules, compiled JS in lib/,
# and no dev tooling.
#
# Bun stages use the official oven/bun alpine image (bun preinstalled);
# npm-installing bun on a node base fails to resolve its platform package.
# `--ignore-scripts` skips package lifecycle scripts: the only deps with
# install scripts here are the OPTIONAL native ws addons (utf-8-validate,
# bufferutil, via websocket@1.0.35) which fail to node-gyp-compile under
# bun's bundled node and aren't needed by an HTTP-RPC processor — websocket
# falls back to its pure-JS path when they're absent. No dep in this tree
# requires a build step at install time. Runtime is node:20-alpine (same
# musl base) since the entrypoint is `node lib/main.js`.

ARG NODE_VERSION=20-alpine
ARG BUN_IMAGE=oven/bun:1.1.14-alpine

# --- Stage 1: install all deps (needed for build) ----------------------------
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# bun.lock pins exact versions; --frozen-lockfile reproduces them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# --- Stage 2: tsc compile ----------------------------------------------------
FROM ${BUN_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN bun run build

# --- Stage 3: production-only deps -------------------------------------------
FROM ${BUN_IMAGE} AS proddeps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# --- Stage 4: slim runtime ---------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=builder /app/lib ./lib
COPY package.json ./

# Use the unprivileged `node` user that ships with the official image.
USER node

CMD ["node", "lib/main.js"]
