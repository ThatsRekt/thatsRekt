import { describe, expect, test } from 'bun:test'
import type { PoolClient } from 'pg'
import { indexDonationBlocks, type DonationBlock } from '../src/processor.ts'
import { TRANSFER_TOPIC0 } from '../src/tokenAllowlist.ts'

const DONEE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'
const USDS = '0xdc035d45d973e3ec169d2276ddab16f1e407384f'
// netrim.eth's EOA signs execTransaction on a Safe he owns; the USDS leaves the Safe.
const SIGNER = '0x5920ca4a51d93052f111e90c387f70bcf723ea3f'
const SAFE = '0x371b75388b95073e903648abbb205df1295f5ee3'
const TX = '0x0cffcb1003ab4fc7ba1046bf345ed570af5d2de9b1bbc23ef298f194ecb98da7'

const topic = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`

const fakeStore = () => {
  const inserts: unknown[][] = []
  const store = {
    query: async (_sql: string, params: unknown[]) => {
      inserts.push(params)
      return { rows: [], rowCount: 1 }
    },
  } as unknown as PoolClient
  return { store, inserts }
}

const safeUsdsBlock = (transactions: DonationBlock['transactions']): DonationBlock => ({
  header: { height: 26_334_638, timestamp: Date.parse('2026-11-03T13:41:11Z') },
  transactions,
  logs: [{
    address: USDS,
    topics: [TRANSFER_TOPIC0, topic(SAFE), topic(DONEE)],
    data: '0x00000000000000000000000000000000000000000000003635c9adc5dea00000',
    transactionHash: TX,
    logIndex: 235,
  }],
})

describe('ERC20 donation signer attribution', () => {
  test('records the Safe as donor and the transaction signer alongside it', async () => {
    const { store, inserts } = fakeStore()
    await indexDonationBlocks({
      blocks: [safeUsdsBlock([{ to: SAFE, from: SIGNER, hash: TX, value: 0n }])],
      store,
      chainId: 1,
      chainSlug: 'ethereum',
      donee: DONEE,
    })

    expect(inserts).toHaveLength(1)
    const params = inserts[0]!
    expect(params[3]).toBe(SAFE) // from_address
    expect(params[5]).toBe('USDS') // token_symbol
    expect(params[8]).toBe('1000') // amount_norm
    expect(params[13]).toBe(SIGNER) // tx_from_address
  })

  test('leaves the signer null when the Portal returned no parent transaction', async () => {
    const { store, inserts } = fakeStore()
    await indexDonationBlocks({
      blocks: [safeUsdsBlock([])],
      store,
      chainId: 1,
      chainSlug: 'ethereum',
      donee: DONEE,
    })

    expect(inserts).toHaveLength(1)
    expect(inserts[0]![13]).toBeNull()
  })
})
