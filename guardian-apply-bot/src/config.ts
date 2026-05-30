/**
 * Runtime config — all values from environment variables only.
 * No secrets on the command line.
 */

import { z } from 'zod'

const ConfigSchema = z.object({
  META_DB_URL: z.string().url('META_DB_URL must be a valid postgres:// URL'),
  TG_BOT_TOKEN: z
    .string()
    .min(1, 'TG_BOT_TOKEN is required')
    .regex(/^\d+:[\w-]+$/, 'TG_BOT_TOKEN must be in the format <id>:<token>'),
  TG_CHANNEL_ID: z
    .string()
    .min(1, 'TG_CHANNEL_ID is required'),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Load and validate config from env. Throws with a clear message listing
 * every missing/invalid variable — fail fast, fail loud.
 */
export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`guardian-apply-bot: config validation failed:\n${issues}`)
  }
  return result.data
}
