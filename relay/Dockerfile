# syntax=docker/dockerfile:1.7

# Multi-stage build: builder (go build) -> runtime (alpine + statically-linked binary).
# Final image is alpine-based (~12MB) and contains the relay binary plus ca-certificates
# (needed for HTTPS RPC + webhook calls). Alpine over distroless so HEALTHCHECK can
# use wget — keeps the autoheal sidecar pattern working.

ARG GO_VERSION=1.24-alpine

# --- Stage 1: build -------------------------------------------------------------
FROM golang:${GO_VERSION} AS builder
WORKDIR /src

# Install dependencies first (cache-friendly: only re-runs on go.{mod,sum} change).
COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
COPY abi ./abi

# Statically-linked, stripped binary. CGO off — go-ethereum + gorilla/websocket
# both compile pure-Go.
ENV CGO_ENABLED=0 GOOS=linux
RUN go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/relay \
      ./cmd/relay

# --- Stage 2: runtime ----------------------------------------------------------
FROM alpine:3.20 AS runtime

# ca-certificates: needed for HTTPS to RPC providers + webhook callers.
# wget: used by the HEALTHCHECK below.
RUN apk add --no-cache ca-certificates wget && \
    addgroup -g 10001 relay && \
    adduser -u 10001 -G relay -S -h /nonexistent -s /sbin/nologin relay

COPY --from=builder /out/relay /usr/local/bin/relay

USER relay:relay

EXPOSE 8080

# Autoheal-compatible healthcheck (the relay registers /healthz unconditionally).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/relay"]
