/**
 * Pure message formatter for guardian applications.
 *
 * Produces a Telegram HTML-formatted string for a single application row.
 * Pure: no IO, no side effects, deterministic output. Safe to test without
 * any DB or network.
 *
 * Style rules:
 * - No em-dashes anywhere (house rule). Use " - " or ": " instead.
 * - "onchain" (no hyphen) — house spelling.
 * - HTML entities escaped for Telegram's parseMode=HTML.
 */

import type { ApplicationRow } from './db.js'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Extra-contacts parsing
// ---------------------------------------------------------------------------

const ExtraContactSchema = z.array(
  z.object({
    type: z.enum(['telegram', 'email', 'signal', 'twitter']),
    value: z.string().min(1),
  }),
)

type ExtraContact = z.infer<typeof ExtraContactSchema>[number]

/**
 * Parse `extra_contacts` JSONB. Returns an empty array when absent, null,
 * or malformed — the formatter gracefully omits the section.
 */
export function parseExtraContacts(raw: unknown): readonly ExtraContact[] {
  if (raw === null || raw === undefined) return []
  const parsed = ExtraContactSchema.safeParse(raw)
  return parsed.success ? parsed.data : []
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/** Escape the four HTML special chars Telegram cares about in HTML parse mode. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

const CONTACT_TYPE_LABEL: Record<ApplicationRow['primary_contact_type'], string> = {
  telegram: 'Telegram',
  email: 'Email',
  signal: 'Signal',
  twitter: 'Twitter / X',
}

/**
 * Format a single guardian application for Telegram HTML output.
 *
 * Output is suitable for `sendMessage` with `parse_mode=HTML`.
 * Sections:
 *   - Header: "New Guardian Application"
 *   - Submission ID + timestamp
 *   - Primary contact
 *   - Additional contacts (if any)
 *   - Justification (blockquote)
 *   - Source IP hash (if present)
 */
export function formatApplication(row: ApplicationRow): string {
  const extraContacts = parseExtraContacts(row.extra_contacts)

  const header = '<b>New Guardian Application</b>'
  const idLine = `<b>ID:</b> ${escapeHtml(row.id)}`
  const dateLine = `<b>Submitted:</b> ${escapeHtml(row.created_at.toISOString())}`

  const typeLabel = CONTACT_TYPE_LABEL[row.primary_contact_type]
  const primaryLine = `<b>Primary contact (${escapeHtml(typeLabel)}):</b> ${escapeHtml(row.primary_contact_value)}`

  const extraLines =
    extraContacts.length > 0
      ? [
          '<b>Additional contacts:</b>',
          ...extraContacts.map(
            (c) =>
              `  - ${escapeHtml(CONTACT_TYPE_LABEL[c.type] ?? c.type)}: ${escapeHtml(c.value)}`,
          ),
        ].join('\n')
      : null

  const justificationBlock = [
    '<b>Justification:</b>',
    `<blockquote>${escapeHtml(row.justification)}</blockquote>`,
  ].join('\n')

  const ipLine =
    row.source_ip_hash !== null && row.source_ip_hash !== undefined
      ? `<b>Source IP hash:</b> <code>${escapeHtml(row.source_ip_hash)}</code>`
      : null

  const parts = [header, idLine, dateLine, primaryLine]
  if (extraLines !== null) parts.push(extraLines)
  parts.push(justificationBlock)
  if (ipLine !== null) parts.push(ipLine)

  return parts.join('\n')
}
