# =============================================================================
# thatsRekt notifier — Telegram channel bot
# =============================================================================
# Multi-stage build → final `FROM scratch` image (~10–12 MB) with the
# static binary + ca-certificates (needed for HTTPS to the Telegram API,
# Mesh GraphQL, and S3).
#
# CGO disabled and the binary is fully static so `FROM scratch` works.
# =============================================================================

# --- builder ----------------------------------------------------------------
# Go 1.26.10+ denylists the eight compromised eMudhra intermediate CA keys in
# crypto/x509 (CVE-2026-111943). The notifier is a TLS client (Telegram, Mesh,
# S3), so it must be built with it. Pinned by digest.
FROM golang:1.26.10-alpine@sha256:27f2d3b83cfc5803c8078f8e730af0f7c431bf067afaec8f60a36fb763187cba AS builder

WORKDIR /src

# Cache dependencies separately from source (rebuild only on go.mod change).
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Static build flags:
#   -trimpath    → reproducible builds (strip $GOPATH from binary)
#   -ldflags     → strip symbol table + DWARF, smaller binary
#   CGO_ENABLED=0 → no glibc dependency, runs on `scratch`
RUN CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/notifier \
    ./cmd/notifier

# --- runtime ----------------------------------------------------------------
FROM scratch

# CA roots so HTTPS works (api.telegram.org, thatsrekt.com, S3).
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# Run as a non-root uid even though `scratch` has no /etc/passwd. Fargate
# accepts numeric uids fine; this is defense-in-depth in case the binary
# ever gets a CVE that breaks out.
USER 65532:65532

COPY --from=builder /out/notifier /notifier

ENTRYPOINT ["/notifier"]
