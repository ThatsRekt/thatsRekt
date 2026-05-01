-- =============================================================================
-- thatsRekt — local stack postgres init (Base Sepolia only).
-- =============================================================================
-- Mounted at /docker-entrypoint-initdb.d/ in the postgres container. The
-- official postgres image runs files in this directory exactly once — when
-- the data directory is empty (i.e. first boot, or after `docker compose
-- down -v` wipes the named volume).
--
-- The local stack only provisions the base-sepolia DB. If you want to add
-- another chain locally, append the matching CREATE DATABASE line AND add
-- the corresponding processor/graphql/migrate services to docker-compose.yml.
-- =============================================================================

CREATE DATABASE thatsrekt_base_sepolia;
