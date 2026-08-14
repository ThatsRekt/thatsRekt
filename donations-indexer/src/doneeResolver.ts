/**
 * doneeResolver — resolve the current thatsrekt.eth donation address from ENS
 * on Ethereum mainnet.
 *
 * Resolution makes two dependent raw JSON-RPC eth_calls at latest:
 * 1. ENS Registry resolver(bytes32) to locate the current resolver.
 * 2. That resolver's addr(bytes32) to locate the current donee.
 *
 * Any failure logs a warning and returns the lowercased seed donee.
 */

/**
 * The canonical Ethereum mainnet ENS Registry.
 */
export const ENS_REGISTRY_ADDRESS =
  '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e'

/**
 * selector for resolver(bytes32)
 */
export const ENS_REGISTRY_RESOLVER_SELECTOR = '0x0178b8bf'

/**
 * selector for addr(bytes32)
 */
export const ENS_RESOLVER_ADDR_SELECTOR = '0x3b3b57de'

/**
 * namehash("thatsrekt.eth")
 * Computed with: cast namehash thatsrekt.eth
 */
export const THATSREKT_ENS_NAMEHASH =
  '0x6dfbf6357dc05b7c231e63a0fd428fd2138b381eb15bfbd6bc51705ca4117726'

/**
 * Encodes a bytes32 ENS namehash argument after a four-byte function selector.
 */
export function encodeNamehashCallData(
  selector: string,
  namehash: string,
): string {
  return selector + namehash.slice(2)
}

/**
 * Decodes an ABI-encoded address return word.
 *
 * An address return must be an exact 0x-prefixed 32-byte hexadecimal word with
 * twelve zero padding bytes. Zero addresses and malformed words are rejected.
 */
export function addressFromAbiAddressWord(result: unknown): string | null {
  if (
    typeof result !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(result) ||
    !/^0{24}$/.test(result.slice(2, 26))
  ) {
    return null
  }

  const address = '0x' + result.slice(26).toLowerCase()
  return address === '0x0000000000000000000000000000000000000000'
    ? null
    : address
}

interface RpcResponse {
  readonly result?: unknown
  readonly error?: { message: string }
}

async function ethCall({
  rpcUrl,
  to,
  data,
}: {
  rpcUrl: string
  to: string
  data: string
}): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status} ${response.statusText}`)
  }

  const json = (await response.json()) as RpcResponse
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`)
  }

  return json.result
}

/**
 * Resolve the current thatsrekt.eth address from ENS.
 *
 * Defensive contract:
 * - Any failure (missing rpcUrl, RPC error, network error, malformed result,
 *   zero resolver, zero donee) logs a warning and returns
 *   `fallback.toLowerCase()`.
 * - Never throws.
 * - Never returns the zero address.
 * - Logs (info level) if the resolved donee differs from the fallback.
 */
export async function resolveCurrentDonee({
  rpcUrl,
  fallback,
  namehash = THATSREKT_ENS_NAMEHASH,
}: {
  rpcUrl: string
  fallback: string
  namehash?: string
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
    const resolver = addressFromAbiAddressWord(
      await ethCall({
        rpcUrl,
        to: ENS_REGISTRY_ADDRESS,
        data: encodeNamehashCallData(ENS_REGISTRY_RESOLVER_SELECTOR, namehash),
      }),
    )

    if (resolver === null) {
      console.warn(
        '[doneeResolver] No valid ENS resolver found — using seed donee:',
        fallbackAddr,
      )
      return fallbackAddr
    }

    const resolved = addressFromAbiAddressWord(
      await ethCall({
        rpcUrl,
        to: resolver,
        data: encodeNamehashCallData(ENS_RESOLVER_ADDR_SELECTOR, namehash),
      }),
    )

    if (resolved === null) {
      console.warn(
        '[doneeResolver] No valid ENS donee found — using seed donee:',
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
