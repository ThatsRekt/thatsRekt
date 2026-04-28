# =============================================================================
# thatsRekt — top-level orchestration
# =============================================================================
# Cross-layer commands for the dual-anvil + Mesh + frontend dev stack.
# Run from anywhere — paths are absolute relative to this Makefile.
#
# Common workflows:
#
#   make lan-up               # full LAN stack up (compose + frontend + Mesh)
#   make lan-info             # print the host's LAN IP + the URLs to share
#   make anvil-bootstrap      # deploy thatsRekt to both anvils (idempotent)
#   make lan-down             # stop everything (compose + frontend)
#   make dev-reset            # nuked something? full re-bootstrap in one shot
#   make help                 # this list
# =============================================================================

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
INDEXER := $(ROOT)/indexer
CONTRACTS := $(ROOT)/contracts
FRONTEND := $(ROOT)/frontend
RELAY := $(ROOT)/relay
DETECTOR := $(ROOT)/detector
SCRIPTS := $(ROOT)/ops/scripts

# All three compose files merged: base stack + anvil overlay + LAN overlay.
COMPOSE := docker compose -f $(INDEXER)/docker-compose.yml \
                          -f $(INDEXER)/docker-compose.anvil.yml \
                          -f $(INDEXER)/docker-compose.lan.yml

# Foreground vite-dev pid file so `make lan-down` can stop it.
VITE_PID := /tmp/thatsrekt-vite.pid

# Relay + ngrok pid/token files (managed by ops/scripts/*.sh).
RELAY_PID := /tmp/thatsrekt-relay.pid
RELAY_TOKEN := /tmp/thatsrekt-relay.token
RELAY_LOG := /tmp/thatsrekt-relay.log
NGROK_PID := /tmp/thatsrekt-ngrok.pid
NGROK_URL := /tmp/thatsrekt-ngrok.url
NGROK_LOG := /tmp/thatsrekt-ngrok.log

.PHONY: help
help:
	@awk 'BEGIN{FS=":.*##"} /^[a-z-]+:.*##/ { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: lan-up
lan-up: ## Bring up the full LAN stack (db + processors + Mesh + frontend dev). FAST: reuses cached images. Use `lan-rebuild` if source changed.
	@echo "==> Starting compose stack (db, anvils, processors, graphqls, mesh)"
	cd $(INDEXER) && $(COMPOSE) up -d
	@echo "==> Starting frontend dev server (LAN-bound on :5173)"
	@if [ -f $(VITE_PID) ] && kill -0 $$(cat $(VITE_PID)) 2>/dev/null; then \
		echo "    vite already running (pid $$(cat $(VITE_PID)))"; \
	else \
		cd $(FRONTEND) && (pnpm dev:lan > /tmp/thatsrekt-vite.log 2>&1 & echo $$! > $(VITE_PID)); \
		echo "    vite started (pid $$(cat $(VITE_PID))) — logs at /tmp/thatsrekt-vite.log"; \
	fi
	@$(MAKE) -s lan-info

.PHONY: lan-rebuild
lan-rebuild: ## SLOW: rebuild the squid + mesh images and bring up. Use only when indexer/src or mesh/src changed.
	@echo "==> Rebuilding squid + mesh images (this is the slow path; use lan-up otherwise)"
	cd $(INDEXER) && $(COMPOSE) build
	@$(MAKE) -s lan-up

.PHONY: lan-restart
lan-restart: ## Restart compose services without rebuild. Cheapest way to pick up env changes.
	cd $(INDEXER) && $(COMPOSE) restart

.PHONY: lan-down
lan-down: ## Stop the full LAN stack
	@echo "==> Stopping compose stack"
	cd $(INDEXER) && $(COMPOSE) stop
	@echo "==> Stopping frontend dev server"
	@if [ -f $(VITE_PID) ]; then \
		kill $$(cat $(VITE_PID)) 2>/dev/null || true; \
		rm -f $(VITE_PID); \
	fi

.PHONY: lan-info
lan-info: ## Print LAN URLs to share with teammates
	@echo ""
	@echo "═══════════════════════════════════════════════════════════════"
	@LAN_IP=$$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I | awk '{print $$1}'); \
	if [ -z "$$LAN_IP" ]; then LAN_IP="<could-not-detect>"; fi; \
	echo "  thatsRekt LAN endpoints:"; \
	echo ""; \
	echo "    Frontend:  http://$$LAN_IP:5173"; \
	echo "    GraphQL:   http://$$LAN_IP:4350/graphql"; \
	echo "    Anvil eth: http://$$LAN_IP:8545"; \
	echo "    Anvil base: http://$$LAN_IP:8546"; \
	echo "═══════════════════════════════════════════════════════════════"
	@echo ""

.PHONY: anvil-bootstrap
anvil-bootstrap: ## Deploy thatsRekt to both anvils + emit .deployed.<chain>.json
	@echo "==> Bootstrapping anvil-eth"
	@cd $(INDEXER) && $(COMPOSE) up -d anvil-eth
	@sleep 2
	@$(CONTRACTS)/script/anvil/bootstrap.sh anvil-eth
	@echo ""
	@echo "==> Bootstrapping anvil-base"
	@cd $(INDEXER) && $(COMPOSE) up -d anvil-base
	@sleep 2
	@ANVIL_RPC=http://localhost:8546 $(CONTRACTS)/script/anvil/bootstrap.sh anvil-base
	@echo ""
	@echo "==> Bootstrap complete. Copy the printed CONTRACT_* / START_BLOCK_*"
	@echo "    values into $(INDEXER)/.env, then \`make lan-up\`."

.PHONY: anvil-reset
anvil-reset: ## Wipe + re-deploy both anvils
	$(CONTRACTS)/script/anvil/reset.sh

.PHONY: dev-reset
dev-reset: ## Full local stack re-bootstrap: anvils → contracts → indexer/.env → drop+remigrate DBs → restart processors+mesh (and relay if running). The "I just nuked something, get me back" button.
	@$(SCRIPTS)/dev-reset.sh

.PHONY: clean
clean: ## Tear down the stack and wipe pgdata
	cd $(INDEXER) && $(COMPOSE) down -v
	@if [ -f $(VITE_PID) ]; then kill $$(cat $(VITE_PID)) 2>/dev/null || true; rm -f $(VITE_PID); fi
	@$(MAKE) -s relay-down ngrok-down
	rm -f $(CONTRACTS)/script/anvil/.deployed.*.json
	rm -f /tmp/thatsrekt-relay-eoa.{addr,key} $(RELAY_TOKEN) $(NGROK_URL)

# =============================================================================
# Detector pipeline
# =============================================================================
# The relay is DAMM-internal (single-tenant). There are two flows:
#
# ── LOCAL DEV (no Otomato, no ngrok) ──
#   1. make lan-up               — db, anvils, indexer, mesh, frontend
#   2. make anvil-bootstrap      — deploy thatsRekt to anvil-eth + anvil-base
#   3. make relay-up             — boot the Go relay (whitelists EOA, gen token)
#   4. make detector-mock        — fire ONE fake detection at the local relay
#                                  (override args via MOCK_ARGS="--protocol Lido")
#
# ── PROD-LIKE (real Otomato workflow over ngrok) ──
#   Same steps 1–3, then:
#   4. make detector-up          — adds ngrok + writes detector/.env
#   5. set OTOMATO_API_KEY in detector/.env
#   6. cd detector && npm run deploy
#   7. tweet from a monitored X account → on-chain post
#
# Teardown:
#   make detector-down   (stops relay + ngrok)
#   make clean           (full nuke including pgdata)
# =============================================================================

.PHONY: relay-up
relay-up: ## Start the relay against anvil-eth (whitelists EOA, generates token)
	@echo "==> Starting relay"
	@$(SCRIPTS)/start-relay.sh

.PHONY: relay-down
relay-down: ## Stop the relay
	@if [ -f $(RELAY_PID) ]; then \
		kill $$(cat $(RELAY_PID)) 2>/dev/null || true; \
		rm -f $(RELAY_PID); \
		echo "==> Relay stopped"; \
	fi

.PHONY: relay-logs
relay-logs: ## Tail the relay log
	@tail -f $(RELAY_LOG)

.PHONY: ngrok-up
ngrok-up: ## Start ngrok tunnel pointed at the relay
	@echo "==> Starting ngrok"
	@$(SCRIPTS)/start-ngrok.sh

.PHONY: ngrok-down
ngrok-down: ## Stop ngrok
	@if [ -f $(NGROK_PID) ]; then \
		kill $$(cat $(NGROK_PID)) 2>/dev/null || true; \
		rm -f $(NGROK_PID); \
		echo "==> Ngrok stopped"; \
	fi

.PHONY: ngrok-url
ngrok-url: ## Print the current ngrok public URL
	@if [ -f $(NGROK_URL) ]; then cat $(NGROK_URL); echo; fi

.PHONY: detector-env
detector-env: ## (Re-)write detector/.env from current relay + ngrok state
	@echo "==> Writing detector/.env"
	@$(SCRIPTS)/write-detector-env.sh

.PHONY: detector-up
detector-up: ## (PROD-like) Boot the Otomato bridge: relay + ngrok + detector/.env. For LOCAL DEV use `make relay-up && make detector-mock` instead.
	@$(MAKE) -s relay-up
	@$(MAKE) -s ngrok-up
	@$(MAKE) -s detector-env
	@echo ""
	@echo "═══════════════════════════════════════════════════════════════"
	@echo "  Otomato bridge ready (relay + ngrok + detector/.env)."
	@echo ""
	@echo "  This path is for testing the REAL Otomato workflow against"
	@echo "  the local stack. For local-only dev (no Otomato), use:"
	@echo "    make detector-mock  (fires a fake detection — no ngrok needed)"
	@echo ""
	@echo "  To ship the workflow to Otomato:"
	@echo "    set OTOMATO_API_KEY in $(DETECTOR)/.env"
	@echo "    cd $(DETECTOR) && npm install && npm run deploy"
	@echo ""
	@echo "  Tail logs: make relay-logs"
	@echo "  Tear down: make detector-down"
	@echo "═══════════════════════════════════════════════════════════════"

.PHONY: detector-down
detector-down: ## Stop relay + ngrok (leaves indexer + frontend running)
	@$(MAKE) -s relay-down ngrok-down

.PHONY: detector-deploy
detector-deploy: ## Run `npm run deploy` from the detector dir (requires OTOMATO_API_KEY)
	@cd $(DETECTOR) && npm run deploy

.PHONY: detector-smoke
detector-smoke: ## End-to-end smoke test (curl /detect → on-chain post) — requires lan-up + anvil-bootstrap + detector-up
	@$(SCRIPTS)/smoke-test-detector.sh

.PHONY: detector-mock
detector-mock: ## Fire ONE fake detection at the local relay (for dev). No Otomato, no ngrok needed. Pass args via MOCK_ARGS, e.g. `make detector-mock MOCK_ARGS="--protocol Lido"`
	@cd $(DETECTOR) && npm run --silent mock -- $(MOCK_ARGS)
