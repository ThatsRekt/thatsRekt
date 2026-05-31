import type {
  AddressEntity,
  Donation,
  EditEntity,
  EditKind,
  FeedPost,
  PostDetail,
  SortOption,
  ConfirmDirection,
  ConfirmationEntity,
} from './queries'

// Realistic dummy data so the UI can be inspected without a running indexer.
// Toggled via VITE_USE_MOCK_DATA=true in .env.

const SLOWMIST = '0xa1b2c3d4e5f60718192a3b4c5d6e7f80a1b2c3d4'
const BLOCKSEC = '0xb2c3d4e5f60718192a3b4c5d6e7f80a1b2c3d4e5'
const PECKSHIELD = '0xc3d4e5f60718192a3b4c5d6e7f80a1b2c3d4e5f6'
const HIRYUU = '0xd4e5f60718192a3b4c5d6e7f80a1b2c3d4e5f607'
const NUMEN = '0xe5f60718192a3b4c5d6e7f80a1b2c3d4e5f60718'

const ATTACKER_EOA_1 = '0xdead000000000000000000000000000000000001'
const ATTACKER_EOA_2 = '0xdead000000000000000000000000000000000002'
const ATTACKER_EOA_3 = '0xdead000000000000000000000000000000000003'
const ATTACKER_LAUNDER_1 = '0xbad0000000000000000000000000000000000010'
const ATTACKER_LAUNDER_2 = '0xbad0000000000000000000000000000000000011'

const BRIDGE_VICTIM = '0x4200000000000000000000000000000000000010'
const VAULT_VICTIM = '0xc0ffee0000000000000000000000000000000099'
const POOL_VICTIM = '0xfeed000000000000000000000000000000000aaa'
const STAKING_VICTIM = '0xb1ade0000000000000000000000000000000bbbb'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

// ---- typed builders --------------------------------------------------------

const addr = (id: string, score: string, isVictim = false, appearances = 1): AddressEntity => ({
  id: id.toLowerCase(),
  attackerScore: score,
  attackerAppearances: appearances,
  isVictim,
})

const v = (
  id: string,
  confirmer: string,
  oldDirection: ConfirmDirection,
  newDirection: ConfirmDirection,
  blockNumber: number,
  timestamp: string,
): ConfirmationEntity => ({
  id,
  confirmer: { id: confirmer.toLowerCase() },
  oldDirection,
  newDirection,
  blockNumber,
  timestamp,
})

const e = (
  id: string,
  kind: EditKind,
  blockNumber: number,
  timestamp: string,
  payload: Partial<Pick<EditEntity, 'newNote' | 'newTitle' | 'addedAttackers' | 'addedVictims'>> = {},
): EditEntity => ({
  id,
  kind,
  newNote: payload.newNote ?? null,
  newTitle: payload.newTitle ?? null,
  addedAttackers: payload.addedAttackers ?? null,
  addedVictims: payload.addedVictims ?? null,
  blockNumber,
  timestamp,
})

// ---- per-post records -----------------------------------------------------

const POST_42: PostDetail = {
  id: '42',
  poster: { id: SLOWMIST },
  attackedAt: iso(NOW - 6 * HOUR),
  lastUpdatedAt: iso(NOW - 1 * HOUR),
  title: "Bridge exploit on Mochi vault",
  note:
    'Active bridge exploit in progress. Attacker drained ~$4.2M from the bridge contract on Base. Funds are being moved through ETH bridge — flagging the attacker EOA + downstream laundering addresses. Full thread incoming on our channel.',
  confirmations: 4,
  disconfirmations: 0,
  netScore: 4,
  removed: false,
  createdAtBlock: 0,
  createdAtTimestamp: iso(NOW - 5 * HOUR),
  removedAtTimestamp: null,
  purged: false,
  purgedAtTimestamp: null,
  attackerLinks: [
    { address: addr(ATTACKER_EOA_1, '7', false, 2) },
    { address: addr(ATTACKER_LAUNDER_1, '4', false, 1) },
    { address: addr(ATTACKER_LAUNDER_2, '4', false, 1) },
  ],
  victimLinks: [{ address: addr(BRIDGE_VICTIM, '0', true) }],
  confirmationLog: [
    v('0xtx1-1', BLOCKSEC, 'None', 'Up', 18450010, iso(NOW - 4.8 * HOUR)),
    v('0xtx2-3', PECKSHIELD, 'None', 'Up', 18450055, iso(NOW - 4.5 * HOUR)),
    v('0xtx3-2', HIRYUU, 'None', 'Up', 18450122, iso(NOW - 4 * HOUR)),
    v('0xtx4-1', NUMEN, 'None', 'Up', 18450199, iso(NOW - 3 * HOUR)),
  ],
  edits: [
    e('0xtx5-1', 'AmendNote', 18450350, iso(NOW - 2 * HOUR), {
      newNote:
        'Active bridge exploit in progress. Attacker drained ~$4.2M from the bridge contract on Base. Funds are being moved through ETH bridge — flagging the attacker EOA + downstream laundering addresses. Full thread incoming on our channel.',
    }),
    e('0xtx6-2', 'AddAttackers', 18450410, iso(NOW - 1 * HOUR), {
      addedAttackers: [ATTACKER_LAUNDER_1, ATTACKER_LAUNDER_2],
    }),
  ],
}

const POST_41: PostDetail = {
  id: '41',
  poster: { id: BLOCKSEC },
  attackedAt: iso(NOW - 30 * HOUR),
  lastUpdatedAt: iso(NOW - 28 * HOUR),
  title: "Drainer detected on Aave v3",
  note:
    'Flash-loan based price manipulation against the lending pool. ~$1.1M lost. Attacker used a single tx to manipulate the oracle and liquidate underwater positions at a discount.',
  confirmations: 3,
  disconfirmations: 0,
  netScore: 3,
  removed: false,
  createdAtBlock: 0,
  createdAtTimestamp: iso(NOW - 29 * HOUR),
  removedAtTimestamp: null,
  purged: false,
  purgedAtTimestamp: null,
  attackerLinks: [{ address: addr(ATTACKER_EOA_2, '3', false, 1) }],
  victimLinks: [{ address: addr(POOL_VICTIM, '0', true) }],
  confirmationLog: [
    v('0xtx10-1', SLOWMIST, 'None', 'Up', 18380000, iso(NOW - 28 * HOUR)),
    v('0xtx11-2', PECKSHIELD, 'None', 'Up', 18380120, iso(NOW - 27 * HOUR)),
    v('0xtx12-1', HIRYUU, 'None', 'Up', 18380302, iso(NOW - 26 * HOUR)),
  ],
  edits: [],
}

const POST_40: PostDetail = {
  id: '40',
  poster: { id: PECKSHIELD },
  attackedAt: iso(NOW - 3 * DAY),
  lastUpdatedAt: iso(NOW - 2.5 * DAY),
  title: "Suspicious withdraw from Compound",
  note:
    'Re-entrancy on a yield vault — checks-effects-interactions ordering bug. Attacker withdrew ~$320k before the team could pause. Pause activated, recovery negotiations ongoing.',
  confirmations: 2,
  disconfirmations: 0,
  netScore: 2,
  removed: false,
  createdAtBlock: 0,
  createdAtTimestamp: iso(NOW - 3 * DAY),
  removedAtTimestamp: null,
  purged: false,
  purgedAtTimestamp: null,
  attackerLinks: [{ address: addr(ATTACKER_EOA_3, '2', false, 1) }],
  victimLinks: [
    { address: addr(VAULT_VICTIM, '0', true) },
    { address: addr(STAKING_VICTIM, '0', true) },
  ],
  confirmationLog: [
    v('0xtx20-1', SLOWMIST, 'None', 'Up', 18290000, iso(NOW - 2.9 * DAY)),
    v('0xtx21-2', BLOCKSEC, 'None', 'Up', 18290444, iso(NOW - 2.7 * DAY)),
  ],
  edits: [
    e('0xtx22-1', 'AddVictims', 18290601, iso(NOW - 2.5 * DAY), {
      addedVictims: [STAKING_VICTIM],
    }),
  ],
}

const POST_39: PostDetail = {
  id: '39',
  poster: { id: HIRYUU },
  attackedAt: iso(NOW - 4 * DAY),
  lastUpdatedAt: iso(NOW - 3.5 * DAY),
  title: "Fake airdrop phishing wave",
  note:
    'Suspected exit scam from a small farm contract. Attacker drained the LP. Posting for visibility — TVL was modest (~$60k).',
  confirmations: 1,
  disconfirmations: 3,
  netScore: -2,
  removed: false,
  createdAtBlock: 0,
  createdAtTimestamp: iso(NOW - 3.9 * DAY),
  removedAtTimestamp: null,
  purged: false,
  purgedAtTimestamp: null,
  attackerLinks: [{ address: addr('0xdeadc0de00000000000000000000000000000099', '-2') }],
  victimLinks: [{ address: addr('0xfa1100000000000000000000000000000000ee00', '0', true) }],
  confirmationLog: [
    v('0xtx30-1', NUMEN, 'None', 'Up', 18200000, iso(NOW - 3.8 * DAY)),
    v('0xtx31-2', SLOWMIST, 'None', 'Down', 18200400, iso(NOW - 3.7 * DAY)),
    v('0xtx32-1', BLOCKSEC, 'None', 'Down', 18200555, iso(NOW - 3.6 * DAY)),
    v('0xtx33-2', PECKSHIELD, 'None', 'Down', 18200800, iso(NOW - 3.5 * DAY)),
  ],
  edits: [],
}

const POST_38: PostDetail = {
  id: '38',
  poster: { id: NUMEN },
  attackedAt: iso(NOW - 5 * DAY),
  lastUpdatedAt: iso(NOW - 4 * DAY),
  title: "Retracted: false-positive migration",
  note: 'False alarm — turns out the suspicious tx was a legitimate migration. Retracting.',
  confirmations: 0,
  disconfirmations: 0,
  netScore: 0,
  removed: true,
  createdAtBlock: 0,
  createdAtTimestamp: iso(NOW - 4.5 * DAY),
  removedAtTimestamp: iso(NOW - 4 * DAY),
  purged: false,
  purgedAtTimestamp: null,
  attackerLinks: [{ address: addr('0xa1ar0000000000000000000000000000000000aa', '0') }],
  victimLinks: [],
  confirmationLog: [],
  edits: [],
}

const POST_37: PostDetail = {
  id: '37',
  poster: { id: SLOWMIST },
  attackedAt: iso(NOW - 30 * 60 * 1000),
  lastUpdatedAt: iso(NOW - 25 * 60 * 1000),
  title: "Test alert · seed",
  note:
    'Just-detected: anomalous outflow from a stablecoin issuer treasury. Investigating; will update.',
  confirmations: 0,
  disconfirmations: 0,
  netScore: 0,
  removed: false,
  createdAtBlock: 0,
  createdAtTimestamp: iso(NOW - 25 * 60 * 1000),
  removedAtTimestamp: null,
  purged: false,
  purgedAtTimestamp: null,
  attackerLinks: [{ address: addr('0xfreshff00000000000000000000000000000fff0', '0') }],
  victimLinks: [{ address: addr('0xfreshff00000000000000000000000000000fee1', '0', true) }],
  confirmationLog: [],
  edits: [],
}

const ALL_POSTS: PostDetail[] = [POST_42, POST_41, POST_40, POST_39, POST_37, POST_38]

// ---- mock fetchers --------------------------------------------------------

const toFeed = (p: PostDetail): FeedPost => ({
  id: p.id,
  poster: p.poster,
  attackedAt: p.attackedAt,
  title: p.title,
  note: p.note,
  confirmations: p.confirmations,
  disconfirmations: p.disconfirmations,
  netScore: p.netScore,
  purged: p.purged,
  createdAtTimestamp: p.createdAtTimestamp,
  attackerLinks: p.attackerLinks,
  victimLinks: p.victimLinks,
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function mockFetchFeed(
  limit = 50,
  sort: SortOption = 'newest',
): Promise<FeedPost[]> {
  await delay(150)
  const live = ALL_POSTS.filter((p) => !p.removed)
  const sorted = [...live].sort((a, b) => {
    const at = new Date(a.createdAtTimestamp).getTime()
    const bt = new Date(b.createdAtTimestamp).getTime()
    return sort === 'oldest' ? at - bt : bt - at
  })
  return sorted.slice(0, limit).map(toFeed)
}

export async function mockFetchPostDetail(id: string): Promise<PostDetail | null> {
  await delay(120)
  return ALL_POSTS.find((p) => p.id === id) ?? null
}

// ---- mock donations --------------------------------------------------------

const MOCK_DONATIONS: readonly Donation[] = Object.freeze([
  {
    id: '1-0xmock001-native',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
    tokenAddress: null,
    tokenSymbol: 'ETH',
    tokenDecimals: 18,
    amountRaw: '500000000000000000',
    amountNorm: '0.5',
    txHash: '0xmock001mock001mock001mock001mock001mock001mock001mock001mock001mock001',
    logIndex: null,
    blockNumber: 20_100_001,
    blockTimestamp: iso(NOW - 2 * HOUR),
  },
  {
    id: '1-0xmock002-native',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: '0xab5801a7d398351b8be11c439e05c5b3259aec9b',
    tokenAddress: null,
    tokenSymbol: 'ETH',
    tokenDecimals: 18,
    amountRaw: '1000000000000000000',
    amountNorm: '1',
    txHash: '0xmock002mock002mock002mock002mock002mock002mock002mock002mock002mock002',
    logIndex: null,
    blockNumber: 20_100_000,
    blockTimestamp: iso(NOW - 5 * HOUR),
  },
  {
    id: '1-0xmock003-native',
    chainId: 1,
    chainSlug: 'ethereum',
    fromAddress: '0x1234567890abcdef1234567890abcdef12345678',
    tokenAddress: null,
    tokenSymbol: 'ETH',
    tokenDecimals: 18,
    amountRaw: '100000000000000000',
    amountNorm: '0.1',
    txHash: '0xmock003mock003mock003mock003mock003mock003mock003mock003mock003mock003',
    logIndex: null,
    blockNumber: 20_099_999,
    blockTimestamp: iso(NOW - 1 * DAY),
  },
])

export async function mockFetchDonations(limit = 50, offset = 0): Promise<Donation[]> {
  await delay(120)
  return [...MOCK_DONATIONS].slice(offset, offset + limit)
}
