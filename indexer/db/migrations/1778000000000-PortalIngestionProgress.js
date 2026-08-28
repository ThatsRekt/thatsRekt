module.exports = class PortalIngestionProgress1778000000000 {
    name = 'PortalIngestionProgress1778000000000'

    async up(db) {
        // TypeormDatabase normally creates this state table on its first connect.
        // The trigger must exist before that connect so durable progress is recorded
        // in the same transaction as the first cursor advance.
        await db.query(`CREATE SCHEMA IF NOT EXISTS squid_processor`)
        await db.query(
            `CREATE TABLE IF NOT EXISTS squid_processor.status (` +
                `id int4 primary key, ` +
                `height int4 not null, ` +
                `hash text DEFAULT '0x', ` +
                `nonce int4 DEFAULT 0` +
                `)`
        )
        await db.query(
            `CREATE TABLE IF NOT EXISTS squid_processor.portal_ingestion_progress (` +
                `id int4 primary key CHECK (id = 0), ` +
                `cursor_height int4 not null, ` +
                `cursor_hash text not null, ` +
                `durable_progress_at_ms bigint` +
                `)`
        )
        // Existing cursors predate this metric, so retain the real cursor but leave
        // its time unknown rather than manufacturing a fresh durable-progress age.
        await db.query(
            `INSERT INTO squid_processor.portal_ingestion_progress (` +
                `id, cursor_height, cursor_hash, durable_progress_at_ms` +
                `) ` +
                `SELECT 0, height, hash, NULL FROM squid_processor.status WHERE id = 0 ` +
                `ON CONFLICT (id) DO NOTHING`
        )
        await db.query(
            `INSERT INTO squid_processor.portal_ingestion_progress (` +
                `id, cursor_height, cursor_hash, durable_progress_at_ms` +
                `) VALUES (0, -1, '0x', NULL) ON CONFLICT (id) DO NOTHING`
        )
        await db.query(`
            CREATE OR REPLACE FUNCTION squid_processor.record_portal_ingestion_progress()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF NEW.height > OLD.height THEN
                    INSERT INTO squid_processor.portal_ingestion_progress (
                        id,
                        cursor_height,
                        cursor_hash,
                        durable_progress_at_ms
                    ) VALUES (
                        0,
                        NEW.height,
                        NEW.hash,
                        floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        cursor_height = EXCLUDED.cursor_height,
                        cursor_hash = EXCLUDED.cursor_hash,
                        durable_progress_at_ms = EXCLUDED.durable_progress_at_ms;
                END IF;
                RETURN NEW;
            END;
            $$
        `)
        await db.query(
            `DROP TRIGGER IF EXISTS portal_ingestion_progress_after_status_update ` +
                `ON squid_processor.status`
        )
        await db.query(`
            CREATE TRIGGER portal_ingestion_progress_after_status_update
            AFTER UPDATE OF height, hash ON squid_processor.status
            FOR EACH ROW
            WHEN (NEW.height > OLD.height)
            EXECUTE FUNCTION squid_processor.record_portal_ingestion_progress()
        `)
    }

    async down() {
        // Additive operational state is intentionally retained on migration rollback.
    }
}
