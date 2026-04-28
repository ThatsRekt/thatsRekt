// AI prompt — builds a per-protocol classification prompt.
//
// Otomato's AI block is purpose-built for binary classification: the
// model is steered to return a short answer, the IF gate downstream
// only supports `eq` / `neq` (no substring contains, no regex). The
// reliable contract is therefore: "answer with the literal string
// 'true' or 'false'".
//
// We keep the per-protocol disambiguation (keyword exact-token match,
// optional twitter handle) because false positives at this stage burn
// downstream resources (HTTP_REQUEST + N email actions × 18 branches
// per tweet). Conservative-by-default — when uncertain, "false".

import type { Protocol } from './config.js';

/**
 * Build the AI classification prompt for a single protocol branch.
 *
 * Output contract (enforced by the prompt itself, verified by Otomato's
 * downstream IF gate):
 *
 *   - return ONLY the literal string `true` or `false`
 *   - no JSON, no markdown, no leading/trailing whitespace, no prose
 *   - lowercase, exact match (`eq` is case-sensitive)
 *
 * The IF gate downstream is `result eq "true"`.
 */
export function buildDetectionPrompt(protocol: Protocol): string {
  const keywordList = protocol.keywords.join(', ');
  const handleClause = protocol.twitterHandle
    ? ` or directly tags/mentions the official account @${protocol.twitterHandle}`
    : '';

  return [
    `Task: classify whether the tweet describes an active security incident for the protocol "${protocol.name}".`,
    ``,
    `Output contract:`,
    `  - Reply with EXACTLY the literal lowercase string "true" or "false". Nothing else.`,
    `  - No JSON, no quotes around it, no punctuation, no prose, no whitespace.`,
    `  - The downstream gate compares your output with === "true" — any deviation fails the gate silently.`,
    ``,
    `Decision rules:`,
    ``,
    `1. Output "true" only if the tweet directly states ${protocol.name} (keywords: ${keywordList}${handleClause}) has been hacked, exploited, drained, is under attack, or is experiencing a serious security/funds incident.`,
    ``,
    `2. Output "false" for general price talk, governance votes, audits, partnerships, listings, positive announcements, criticisms, marketing, or any unrelated content. When uncertain, default to "false".`,
    ``,
    `3. Match keywords as EXACT, COMPLETE tokens. A keyword that appears only as a substring of a longer token does NOT count. Example: the keyword "tETH" must NOT match a tweet that contains only "stETH" or "wstETH". A token boundary is the start/end of the tweet OR a non-alphanumeric character on each side.`,
    ``,
    `4. A retweet of an unrelated post that happens to mention the protocol name in passing → "false". Only direct, primary reporting of an incident → "true".`,
    ``,
    `Reply now with EXACTLY one word: true or false.`,
  ].join('\n');
}
