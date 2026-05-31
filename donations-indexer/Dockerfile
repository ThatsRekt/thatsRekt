# syntax=docker/dockerfile:1.7

# Multi-stage build: deps -> builder -> proddeps -> runtime.
# Final image contains only production node_modules, compiled JS in lib/,
# and no dev tooling. Mirrors the pattern in indexer/Dockerfile.

ARG NODE_VERSION=20-alpine

# --- Stage 1: install all deps (needed for build) ----------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Install bun for lockfile-compatible install, then use npm ci for prod.
# We use bun.lock so we reproduce exact versions.
RUN npm install -g bun@1.1.14
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- Stage 2: tsc compile ----------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN npm install -g bun@1.1.14
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN bun run build

# --- Stage 3: production-only deps -------------------------------------------
FROM node:${NODE_VERSION} AS proddeps
WORKDIR /app
RUN npm install -g bun@1.1.14
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

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
