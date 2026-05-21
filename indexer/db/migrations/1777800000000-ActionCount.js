module.exports = class ActionCount1777800000000 {
    name = 'ActionCount1777800000000'

    async up(db) {
        // Add `actionCount` to `post`. Default 1 so existing rows represent
        // posts that were created (the create action itself) without any
        // recorded amendments — a safe minimum. The processor initialises
        // new posts to 1 on PostCreated and increments on every amendment
        // event, so rows written after this migration will have the correct
        // running total. Rows predating the migration keep 1 as a lower
        // bound; a full re-index from genesis would fill exact values.
        await db.query(`ALTER TABLE "post" ADD "action_count" integer NOT NULL DEFAULT 1`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "post" DROP COLUMN "action_count"`)
    }
}
