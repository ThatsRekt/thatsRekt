import { describe, expect, test } from 'bun:test'
import { buildDonationPortalPlan } from '../src/processor.ts'
import { buildPortalConfig } from '../src/portal.ts'

const PORTAL = buildPortalConfig({
  dataset: 'base-mainnet',
  environment: { PORTAL_URL: 'https://portal.example.test/datasets' },
})

const DONEE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'
const DONEE_TOPIC = `0x${DONEE.slice(2).padStart(64, '0')}`

describe('Donations Portal source plan', () => {
  test('uses Portal-only historical ingestion with a finalized bounded range', () => {
    const plan = buildDonationPortalPlan({
      portal: PORTAL,
      startBlock: 50_517_211,
      toBlock: 50_527_450,
      donee: DONEE,
      doneeTopic: DONEE_TOPIC,
      erc20TokenAddresses: ['0x1111111111111111111111111111111111111111'],
    })

    expect(plan.historySource).toBe('portal')
    expect(plan.range).toEqual({ from: 50_517_211, to: 50_527_450 })
    expect(plan.transactionRecipient).toBe(DONEE)
    expect(plan.transferFilters).toEqual([
      {
        address: '0x1111111111111111111111111111111111111111',
        topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        topic2: DONEE_TOPIC,
      },
    ])
  })

  test('rejects an inverted Portal block range before any source is built', () => {
    expect(() =>
      buildDonationPortalPlan({
        portal: PORTAL,
        startBlock: 101,
        toBlock: 100,
        donee: DONEE,
        doneeTopic: DONEE_TOPIC,
        erc20TokenAddresses: [],
      }),
    ).toThrow('Portal range end must not precede start')
  })
})
