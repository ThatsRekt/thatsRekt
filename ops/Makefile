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
#   make help                 # this list
# =============================================================================

ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
INDEXER := $(ROOT)/indexer
CONTRACTS := $(ROOT)/contracts
FRONTEND := $(ROOT)/frontend

# All three compose files merged: base stack + anvil overlay + LAN overlay.
COMPOSE := docker compose -f $(INDEXER)/docker-compose.yml \
                          -f $(INDEXER)/docker-compose.anvil.yml \
                          -f $(INDEXER)/docker-compose.lan.yml

# Foreground vite-dev pid file so `make lan-down` can stop it.
VITE_PID := /tmp/thatsrekt-vite.pid

.PHONY: help
help:
	@awk 'BEGIN{FS=":.*##"} /^[a-z-]+:.*##/ { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: lan-up
lan-up: ## Bring up the full LAN stack (db + processors + Mesh + frontend dev)
	@echo "==> Starting compose stack (db, anvils, processors, graphqls, mesh)"
	cd $(INDEXER) && $(COMPOSE) up -d --build
	@echo "==> Starting frontend dev server (LAN-bound on :5173)"
	@if [ -f $(VITE_PID) ] && kill -0 $$(cat $(VITE_PID)) 2>/dev/null; then \
		echo "    vite already running (pid $$(cat $(VITE_PID)))"; \
	else \
		cd $(FRONTEND) && (pnpm dev:lan > /tmp/thatsrekt-vite.log 2>&1 & echo $$! > $(VITE_PID)); \
		echo "    vite started (pid $$(cat $(VITE_PID))) — logs at /tmp/thatsrekt-vite.log"; \
	fi
	@$(MAKE) -s lan-info

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

.PHONY: clean
clean: ## Tear down the stack and wipe pgdata
	cd $(INDEXER) && $(COMPOSE) down -v
	@if [ -f $(VITE_PID) ]; then kill $$(cat $(VITE_PID)) 2>/dev/null || true; rm -f $(VITE_PID); fi
	rm -f $(CONTRACTS)/script/anvil/.deployed.*.json
