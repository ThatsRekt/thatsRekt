import { describe, expect, test } from 'bun:test'
import { createLogger } from '@subsquid/logger'
import { createReconciler, noopReconciler } from '../src/reconcile'
import { functions } from '../src/abi/ThatsRekt'

const CONTRACT = '0xbfaeee9662b4c037de24e5caa65815350d57b89a'
const silentLog = createLogger('test:reconcile')

// Real getPost() return payload, hand-decoded from an actual eth_call
// against mainnet post #55 (confirmations=1, disconfirmations=0) — the
// exact drift this module exists to catch.
const encodeGetPostResult = ({
  poster = '0xfe6b4dff18d741e725c7c6922ccf69121b2fffdb',
  attackedAt = 0x6aaf0130,
  confirmations,
  disconfirmations,
  removed = false,
  attackers = ['0x1572f2af7696b39c85e3221cde8efb640f86c362'],
  victims = ['0xaea46a60368a7bd060eec7df8cba43b7ef41ad85'],
  lastUpdatedAt = 0x6aaf01b3,
}: {
  poster?: string
  attackedAt?: number
  confirmations: number
  disconfirmations: number
  removed?: boolean
  attackers?: string[]
  victims?: string[]
  lastUpdatedAt?: number
}): string => {
  // Hand-assembles the ABI head/tail layout for getPost's tuple return
  // (poster, attackedAt, confirmations, disconfirmations, removed,
  // attackers offset, victims offset, lastUpdatedAt, then the two dynamic
  // arrays) — the same layout verified by hand against a live mainnet
  // eth_call for post #55 while diagnosing the original bug report.
  const word = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, '0')
  const addr = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const arrWord = (arr: string[]): string => word(arr.length) + arr.map(addr).join('')

  const attackersOffset = 8 * 32 // 8 head words
  const attackersBytes = 32 + 32 * attackers.length
  const victimsOffset = attackersOffset + attackersBytes

  const head =
    addr(poster) +
    word(attackedAt) +
    word(confirmations) +
    word(disconfirmations) +
    word(removed ? 1 : 0) +
    word(attackersOffset) +
    word(victimsOffset) +
    word(lastUpdatedAt)
  const tail = arrWord(attackers) + arrWord(victims)
  return '0x' + head + tail
}

describe('createReconciler', () => {
  test('returns a no-op when no RPC URL is configured', async () => {
    const reconciler = createReconciler({
      rpcUrl: undefined,
      contractAddress: CONTRACT,
      log: silentLog,
    })
    expect(await reconciler.fetchOnchainCounts(55n)).toBeUndefined()
  })

  test('noopReconciler always resolves undefined', async () => {
    expect(await noopReconciler.fetchOnchainCounts(1n)).toBeUndefined()
  })

  test('decodes confirmations/disconfirmations from a real getPost() payload', async () => {
    let capturedBody: any
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: encodeGetPostResult({ confirmations: 1, disconfirmations: 0 }),
        }),
      } as Response
    }) as typeof fetch

    const reconciler = createReconciler({
      rpcUrl: 'https://rpc.example.test',
      contractAddress: CONTRACT,
      log: silentLog,
      fetchImpl,
    })

    const result = await reconciler.fetchOnchainCounts(55n)
    expect(result).toEqual({ confirmations: 1, disconfirmations: 0 })

    // Calldata targets the right contract and encodes postId=55 (0x37).
    expect(capturedBody.method).toBe('eth_call')
    expect(capturedBody.params[0].to).toBe(CONTRACT)
    expect(capturedBody.params[0].data).toBe(functions.getPost.encode({ id: 55n }))
    expect(capturedBody.params[1]).toBe('latest')
  })

  test('returns undefined and does not throw on an RPC error response', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'execution reverted' },
        }),
      }) as Response) as typeof fetch

    const reconciler = createReconciler({
      rpcUrl: 'https://rpc.example.test',
      contractAddress: CONTRACT,
      log: silentLog,
      fetchImpl,
    })
    expect(await reconciler.fetchOnchainCounts(55n)).toBeUndefined()
  })

  test('returns undefined and does not throw on a non-OK HTTP status', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch

    const reconciler = createReconciler({
      rpcUrl: 'https://rpc.example.test',
      contractAddress: CONTRACT,
      log: silentLog,
      fetchImpl,
    })
    expect(await reconciler.fetchOnchainCounts(55n)).toBeUndefined()
  })

  test('returns undefined and does not throw when fetch itself rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const reconciler = createReconciler({
      rpcUrl: 'https://rpc.example.test',
      contractAddress: CONTRACT,
      log: silentLog,
      fetchImpl,
    })
    expect(await reconciler.fetchOnchainCounts(55n)).toBeUndefined()
  })

  test('aborts and returns undefined when the RPC hangs past the timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    const reconciler = createReconciler({
      rpcUrl: 'https://rpc.example.test',
      contractAddress: CONTRACT,
      log: silentLog,
      fetchImpl,
      timeoutMs: 10,
    })
    expect(await reconciler.fetchOnchainCounts(55n)).toBeUndefined()
  })
})
