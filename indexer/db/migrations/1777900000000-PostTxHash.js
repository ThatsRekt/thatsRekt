module.exports = class PostTxHash1777900000000 {
    name = 'PostTxHash1777900000000'

    async up(db) {
        // Add `createdAtTxHash` to `post`. Nullable so existing rows (indexed
        // before this migration) keep working; posts indexed after will have
        // the hash of the PostCreated transaction populated by the processor.
        await db.query(`ALTER TABLE "post" ADD "created_at_tx_hash" text`)
    }

    async down(db) {
        await db.query(`ALTER TABLE "post" DROP COLUMN "created_at_tx_hash"`)
    }
}
