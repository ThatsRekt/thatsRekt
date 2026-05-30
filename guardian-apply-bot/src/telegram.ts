/**
 * Thin Telegram Bot API client — `sendMessage` only.
 *
 * Uses the built-in `fetch` (Node 18+). No third-party SDK; the surface we
 * need is a single HTTP POST.
 *
 * The Telegram leg in the e2e test uses a captured fixture of the real Bot
 * API `sendMessage` JSON response shape. The fixture is captured from a real
 * API call (see test/fixtures/sendMessage.json) so contract drift is caught.
 * Live-bot provisioning (BotFather + real channel) is deferred to slice #177
 * HITL.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  readonly botToken: string
  readonly channelId: string
}

// ---------------------------------------------------------------------------
// Response schema (Zod at the API boundary)
// ---------------------------------------------------------------------------

/**
 * Subset of the Telegram `sendMessage` response we actually need.
 * The `ok: true` path carries `result.message_id` (number).
 * We coerce to string for storage in the text column.
 */
export const SendMessageOkSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    message_id: z.number().int().positive(),
  }),
})

export const SendMessageErrSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string(),
})

export const SendMessageResponseSchema = z.discriminatedUnion('ok', [
  SendMessageOkSchema,
  SendMessageErrSchema,
])

export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class TelegramError extends Error {
  readonly code: number
  constructor(params: { code: number; description: string }) {
    super(`Telegram API error ${params.code}: ${params.description}`)
    this.name = 'TelegramError'
    this.code = params.code
  }
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

const TELEGRAM_API_BASE = 'https://api.telegram.org'

/**
 * Post a message to the configured channel.
 *
 * @returns The `message_id` as a string (matches `forwarded_message_id TEXT`).
 * @throws TelegramError on API-level failures, or Error on network failures.
 */
export async function sendMessage(params: {
  config: TelegramConfig
  text: string
  parseMode?: 'HTML' | 'Markdown'
}): Promise<string> {
  const { config, text, parseMode = 'HTML' } = params

  const url = `${TELEGRAM_API_BASE}/bot${config.botToken}/sendMessage`
  const body = JSON.stringify({
    chat_id: config.channelId,
    text,
    parse_mode: parseMode,
  })

  let rawResponse: unknown
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    rawResponse = await res.json()
  } catch (err) {
    throw new Error(
      `Network error calling Telegram sendMessage: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parsed = SendMessageResponseSchema.safeParse(rawResponse)
  if (!parsed.success) {
    throw new Error(
      `Unexpected Telegram API response shape: ${parsed.error.message}\nRaw: ${JSON.stringify(rawResponse)}`,
    )
  }

  const response = parsed.data
  if (!response.ok) {
    throw new TelegramError({
      code: response.error_code,
      description: response.description,
    })
  }

  return String(response.result.message_id)
}
