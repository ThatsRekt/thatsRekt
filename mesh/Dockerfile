# syntax=docker/dockerfile:1.7

# Multi-stage build for the thatsRekt Mesh gateway. Mirrors the indexer's
# Dockerfile pattern: deps → builder → proddeps → runtime, alpine-based.

ARG NODE_VERSION=20-alpine
ARG PNPM_VERSION=10.33.2

# --- Stage 1: full deps (incl. tsx + tsc for build) ------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- Stage 2: tsc compile --------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
RUN node_modules/.bin/tsc

# --- Stage 3: production-only deps ----------------------------------------
FROM node:${NODE_VERSION} AS proddeps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- Stage 4: slim runtime -------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=builder /app/lib ./lib
COPY package.json ./
USER node
CMD ["node", "lib/server.js"]
