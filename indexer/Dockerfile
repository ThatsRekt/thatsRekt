# syntax=docker/dockerfile:1.7

# Multi-stage build: deps -> builder -> proddeps -> runtime.
# Final image is alpine-based and contains only production node_modules,
# compiled JS in lib/, the ABI, the GraphQL schema, and committed migrations.

ARG NODE_VERSION=20-alpine
ARG PNPM_VERSION=10.33.2

# --- Stage 1: install all deps (needed for codegen + build) -----------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# --- Stage 2: codegen + tsc compile ----------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml .npmrc tsconfig.json schema.graphql squid.yaml ./
COPY abi ./abi
COPY src ./src
RUN pnpm codegen && pnpm build

# --- Stage 3: production-only deps -----------------------------------------
FROM node:${NODE_VERSION} AS proddeps
WORKDIR /app
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

# --- Stage 4: slim runtime --------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production node_modules and compiled output only.
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=builder /app/lib ./lib

# Static assets needed at runtime by the processor and GraphQL server.
COPY abi ./abi
COPY schema.graphql squid.yaml package.json ./
COPY db ./db

# Use the unprivileged `node` user that ships with the official image.
USER node

# Default command — override per service in docker-compose.
CMD ["node", "lib/main.js"]
