/**
 * Entry point — single-run bot.
 *
 * Loads config, runs one forwarding cycle, logs results, exits 0 on success.
 * Non-zero exit on config / connection errors (not on per-row forward
 * failures — those are logged individually and the bot still exits 0 so
 * Fargate doesn't retry the whole batch immediately).
 */

import { loadConfig } from './config.js'
import { metaPool } from './db.js'
import { runForwardingCycle } from './run.js'

async function main(): Promise<void> {
  const config = loadConfig()

  const telegramConfig = {
    botToken: config.TG_BOT_TOKEN,
    channelId: config.TG_CHANNEL_ID,
  }

  // Override the pool's connection string from config. The metaPool singleton
  // reads META_DB_URL at module init time, which is populated from config, so
  // this works correctly as long as META_DB_URL is set in env before import.
  const results = await runForwardingCycle({ telegramConfig })

  const forwarded = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)

  console.log(
    `[guardian-apply-bot] done: ${forwarded.length} forwarded, ${failed.length} failed`,
  )

  if (forwarded.length > 0) {
    for (const r of forwarded) {
      if (r.ok) {
        console.log(`  forwarded id=${r.id} -> message_id=${r.messageId}`)
      }
    }
  }

  if (failed.length > 0) {
    for (const r of failed) {
      if (!r.ok) {
        console.error(`  failed id=${r.id}: ${r.error}`)
      }
    }
  }

  // Drain pool before exit.
  await metaPool.end()
}

main().catch((err) => {
  console.error('[guardian-apply-bot] fatal:', err)
  process.exit(1)
})
