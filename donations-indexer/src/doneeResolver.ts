/**
 * doneeResolver — resolve the current thatsrekt.eth donation address
 * from ENS AddrChanged logs on Ethereum mainnet.
 *
 * Design:
 * - Uses a single `eth_getLogs` call (raw fetch JSON-RPC, no new dependency).
 * - Filter is resolver-agnostic (no `address` filter) — works across resolver upgrades.
 * - Topics: [AddrChanged topic0, namehash(thatsrekt.eth)]
 * - The highest-block log is taken as the current mapping.
 * - Data word (32 bytes): last 20 bytes = address (left-padded).
 * - Zero address or cleared name → null; caller falls back to seed.
 * - Any failure (RPC error, network, malformed response, no logs) → loud
 *   console.warn + return fallback. Never throws. Never returns 0x0.
 *
 * History:
 * - Block 24952292: jerry's wallet (0x9e8680db…1b385df)
 * - Block 25031705: governance safe (0x59e4dbc9…340679)
 */

/**
 * keccak256("AddrChanged(bytes32,address)")
 * Computed with: cast keccak "AddrChanged(bytes32,address)"
 */
export const ADDRCHANGED_TOPIC0 =
  '0x52d7d861f09ab3d26239d492e8968629f95e9e318cf0b73bfddc441522a15fd2'

/**
 * namehash("thatsrekt.eth")
 * Computed with: cast namehash thatsrekt.eth
 */
export const THATSREKT_ENS_NAMEHASH =
  '0x6dfbf6357dc05b7c231e63a0fd428fd2138b381eb15bfbd6bc51705ca4117726'

/**
 * The Ethereum mainnet block from which to start scanning for AddrChanged logs.
 * Chosen before the first known thatsrekt.eth AddrChanged event (block 24952292).
 */
export const ENS_HISTORY_FROM_BLOCK = 24_900_000

// ---------------------------------------------------------------------------
// Pure functions — unit-testable without any I/O
// ---------------------------------------------------------------------------

/**
 * Extract a lowercased 0x-prefixed Ethereum address from an AddrChanged `data`
 * word (a 32-byte value, hex-encoded without 0x prefix, 64 hex chars).
 *
 * The address is left-padded to 32 bytes, so the address lives in the last 20
 * bytes (40 hex chars) of the 64-char string.
 *
 * Returns null for:
 * - Malformed data (length !== 64)
 * - Zero address (0x000...000) — indicates a cleared ENS record
 */
export function addressFromAddrChangedData(data: string): string | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data
  if (hex.length !== 64) return null

  const addrHex = hex.slice(24) // last 40 chars = last 20 bytes
  const addr = '0x' + addrHex.toLowerCase()

  // Zero address = cleared record
  if (addr === '0x0000000000000000000000000000000000000000') return null

  return addr
}

/**
 * From a list of AddrChanged logs, return the address in the log at the
 * highest block number.
 *
 * blockNumber may be a numeric decimal string (hex-string "0x..." or plain
 * number). Hex strings are parsed with parseInt(x, 16).
 *
 * Returns null if:
 * - logs is empty
 * - the address in the highest-block log is zero / malformed
 */
export function latestDoneeFromLogs(
  logs: ReadonlyArray<{ blockNumber: string | number; data: string }>,
): string | null {
  if (logs.length === 0) return null

  const parseBlockNumber = (bn: string | number): number => {
    if (typeof bn === 'number') return bn
    if (bn.startsWith('0x') || bn.startsWith('0X')) return parseInt(bn, 16)
    return parseInt(bn, 10)
  }

  let best: { blockNumber: number; data: string } | null = null
  for (const log of logs) {
    const bn = parseBlockNumber(log.blockNumber)
    if (best === null || bn > best.blockNumber) {
      best = { blockNumber: bn, data: log.data }
    }
  }

  if (best === null) return null
  return addressFromAddrChangedData(best.data)
}

// ---------------------------------------------------------------------------
// RPC-backed resolver
// ---------------------------------------------------------------------------

interface AddrChangedLog {
  readonly blockNumber: string
  readonly data: string
}

interface RpcResponse {
  readonly result?: unknown
  readonly error?: { message: string }
}

/**
 * Resolve the current thatsrekt.eth address from ENS AddrChanged logs.
 *
 * Defensive contract:
 * - Any failure (missing rpcUrl, RPC error, network error, no logs, zero addr)
 *   logs a loud console.warn and returns `fallback.toLowerCase()`.
 * - Never throws.
 * - Never returns the zero address.
 * - Logs (info level) if the resolved donee differs from the fallback.
 *
 * @param rpcUrl     Ethereum mainnet JSON-RPC URL.
 * @param fallback   Seed donee address — returned on any failure path.
 * @param namehash   ENS namehash for thatsrekt.eth (default: THATSREKT_ENS_NAMEHASH).
 * @param fromBlock  Earliest block to scan (default: ENS_HISTORY_FROM_BLOCK).
 */
export async function resolveCurrentDonee({
  rpcUrl,
  fallback,
  namehash = THATSREKT_ENS_NAMEHASH,
  fromBlock = ENS_HISTORY_FROM_BLOCK,
}: {
  rpcUrl: string
  fallback: string
  namehash?: string
  fromBlock?: number
}): Promise<string> {
  const fallbackAddr = fallback.toLowerCase()

  if (!rpcUrl) {
    console.warn(
      '[doneeResolver] No ENS_RPC_URL configured — using seed donee:',
      fallbackAddr,
    )
    return fallbackAddr
  }

  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [
        {
          fromBlock: '0x' + fromBlock.toString(16),
          toBlock: 'latest',
          topics: [ADDRCHANGED_TOPIC0, namehash],
          // No `address` filter — resolver-agnostic (works across resolver upgrades)
        },
      ],
    })

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    if (!response.ok) {
      console.warn(
        `[doneeResolver] RPC HTTP ${response.status} ${response.statusText} — using seed donee:`,
        fallbackAddr,
      )
      return fallbackAddr
    }

    const json = (await response.json()) as RpcResponse

    if (json.error) {
      console.warn(
        '[doneeResolver] RPC error:',
        json.error.message,
        '— using seed donee:',
        fallbackAddr,
      )
      return fallbackAddr
    }

    if (!Array.isArray(json.result)) {
      console.warn(
        '[doneeResolver] Unexpected RPC result (not an array) — using seed donee:',
        fallbackAddr,
      )
      return fallbackAddr
    }

    const logs = json.result as AddrChangedLog[]
    const resolved = latestDoneeFromLogs(logs)

    if (resolved === null) {
      console.warn(
        '[doneeResolver] No valid AddrChanged logs found (empty or zero addr) — using seed donee:',
        fallbackAddr,
      )
      return fallbackAddr
    }

    if (resolved !== fallbackAddr) {
      console.log(
        '[doneeResolver] Resolved donee from ENS:',
        resolved,
        '(differs from seed:',
        fallbackAddr + ')',
      )
    }

    return resolved
  } catch (err) {
    console.warn(
      '[doneeResolver] Failed to resolve ENS donee:',
      err instanceof Error ? err.message : String(err),
      '— using seed donee:',
      fallbackAddr,
    )
    return fallbackAddr
  }
}
