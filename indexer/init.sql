-- =============================================================================
-- Per-chain database provisioning for the thatsRekt indexer.
-- =============================================================================
-- Mounted at /docker-entrypoint-initdb.d/ in the postgres container. The
-- official postgres image runs files in this directory exactly once — when
-- the data directory is empty (i.e. first boot, or after `docker compose
-- down -v` wipes the volume).
--
-- Each chain gets its own logical database on the shared cluster. Per-chain
-- isolation at the data level (a bad migration on one chain can't touch
-- another) without the ops surface of N postgres processes.
--
-- Adding a new chain: add a CREATE DATABASE line and bump the indexer
-- chain registry (src/chains.ts). After: `docker compose down -v` to wipe
-- the volume and trigger re-init, OR run the CREATE DATABASE manually.
-- =============================================================================

CREATE DATABASE thatsrekt_anvil;
CREATE DATABASE thatsrekt_sepolia;
CREATE DATABASE thatsrekt_base;
