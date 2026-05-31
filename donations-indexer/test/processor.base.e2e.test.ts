/**
 * Processor Base e2e test — anvil Base fork + real Postgres.
 *
 * Acceptance criteria from #209:
 *   - Fork Base mainnet on a local anvil instance (chain_id=8453).
 *   - Fund the thatsrekt.eth Safe with native ETH on the fork.
 *   - Impersonate a USDC whale on Base and transfer USDC to the Safe
 *     (USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, 6 decimals).
 *   - Run the processor with CHAIN_SLUG=base.
 *   - Assert rows land with chain_id=8453 / chain_slug='base'.
 *   - Assert native donation row has correct ETH symbol + amount.
 *   - Assert USDC donation row has decimals=6 (not 18 — chain-specific check).
 *   - Assert per-chain cursor isolation: chain_id=8453 row in
 *     donations_indexer_status_v2, distinct from any chain_id=1 row.
 *   - Run the processor twice — assert no duplicate rows.
 *
 * Hard requirements (DAMM standard):
 *   - Real anvil Base fork (no mock RPC).
 *   - Real Postgres container (no mock DB).
 *   - FORK_BASE_URL or FORK_URL env var required — fail loudly if absent.
 *
 * Setup:
 *   docker run --rm -d -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   export FORK_BASE_URL=https://lb.routeme.sh/rpc/8453/<key>
 *   bun run build
 *   bun test test/processor.base.e2e.test.ts
 *
 * The test forks Base mainnet so USDC and other Base ERC20s exist at their
 * canonical addresses. It uses port 18547 to avoid conflicts with ETH tests
 * (18545=native-eth, 18546=erc20-eth).
 *
 * FINALITY_CONFIRMATION=0 treats all blocks as final (no hot-block phase).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import pkg from 'pg'

const { Pool } = pkg

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DONATION_SAFE = '0x59E4DBc95BD312A882Bb36b7f3E8298682340679'

// USDC on Base mainnet — native Circle USDC (not USDbC).
// Verified on-chain: decimals()=6, symbol()="USDC"
// cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "decimals()(uint8)" --rpc-url <base-rpc>
// => 6
const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

// Coinbase USDC whale on Base — large USDC holder used for impersonation.
// Coinbase Base bridge contract has a large USDC balance.
const USDC_WHALE_BASE = '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A'

// 0.01 ETH native donation — well above 0.0001 ETH floor.
const NATIVE_DONATION_WEI = '10000000000000000'
const NATIVE_DONATION_NORM = '0.01'

// 50 USDC = 50 * 10^6 = 50_000_000 raw units.
const USDC_DONATION_RAW = '50000000'
const USDC_DONATION_NORM = '50'

// Base chain id.
const BASE_CHAIN_ID = 8453

// Anvil port for Base fork — distinct from ETH tests.
const ANVIL_BASE_PORT = 18547

// Fork URL — prefer FORK_BASE_URL, fall back to FORK_URL if set and caller
// wants to use a Base-compatible RPC from the env.
const FORK_BASE_URL =
  process.env.FORK_BASE_URL ??
  process.env.RPC_BASE_HTTP ??
  ''

const TEST_DB_NAME = 'donations_base_test'
const TEST_DB_URL =
  process.env.TEST_BASE_DB_URL ??
  `postgres://postgres:postgres@localhost:5432/${TEST_DB_NAME}`

const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres'

// Default anvil funded account #0 — always has 10_000 ETH.
const DONOR_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DONOR_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// ---------------------------------------------------------------------------
// Helpers (mirrors processor.e2e.test.ts)
// ---------------------------------------------------------------------------

const waitForPort = (port: number, timeoutMs = 60_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const probe = () => {
      const sock = createConnection(port, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() > deadline) {
          reject(new Error(`Port ${port} not reachable after ${timeoutMs}ms`))
        } else {
          setTimeout(probe, 300)
        }
      })
    }
    probe()
  })

const runCommand = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: string[] = []
    const err: string[] = []
    proc.stdout?.on('data', (d: Buffer) => out.push(d.toString()))
    proc.stderr?.on('data', (d: Buffer) => err.push(d.toString()))
    proc.on('close', (code) => {
      if (code === 0) resolve(out.join(''))
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${err.join('')}`))
    })
  })

const runProcessor = (env: Record<string, string>, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn('node', ['lib/main.js'], {
      env: { ...process.env, ...env },
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const stdoutLines: string[] = []
    const stderrLines: string[] = []

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutLines.push(chunk.toString())
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrLines.push(chunk.toString())
    })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      // SIGTERM results in code null or 143 — both acceptable.
      if (code === null || code === 0 || code === 143) {
        resolve()
      } else {
        reject(
          new Error(
            `Processor exited unexpectedly with code ${code}\n` +
              `stdout: ${stdoutLines.join('')}\n` +
              `stderr: ${stderrLines.join('')}`,
          ),
        )
      }
    })
  })

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let anvilProc: ChildProcess | null = null
let pool: InstanceType<typeof Pool>

const ANVIL_RPC = `http://127.0.0.1:${ANVIL_BASE_PORT}`

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Skip loudly if no Base fork URL is configured.
  if (!FORK_BASE_URL) {
    throw new Error(
      'Base e2e test requires a Base mainnet fork URL. ' +
        'Set FORK_BASE_URL or RPC_BASE_HTTP env var to a Base archive RPC endpoint.',
    )
  }

  // Verify required binaries — fail loudly if absent.
  for (const bin of ['anvil', 'cast']) {
    const result = Bun.spawnSync(['which', bin])
    if (result.exitCode !== 0) {
      throw new Error(
        `Required binary '${bin}' not found in PATH. Install Foundry: https://getfoundry.sh`,
      )
    }
  }

  // Start anvil forking Base mainnet.
  // chain-id=8453 matches Base mainnet so chain-specific logic in the processor fires.
  anvilProc = spawn(
    'anvil',
    [
      '--port', String(ANVIL_BASE_PORT),
      '--chain-id', String(BASE_CHAIN_ID),
      '--fork-url', FORK_BASE_URL,
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  // Fork takes time to start.
  await waitForPort(ANVIL_BASE_PORT, 60_000)

  // Set up Postgres.
  const superPool = new Pool({ connectionString: SUPERUSER_URL, max: 1 })
  try {
    await superPool.query(`CREATE DATABASE ${TEST_DB_NAME}`)
  } catch (err: unknown) {
    const pgErr = err as { code?: string }
    if (pgErr.code !== '42P04') throw err // 42P04 = duplicate_database
  } finally {
    await superPool.end()
  }

  pool = new Pool({ connectionString: TEST_DB_URL, max: 5 })

  // Clean slate for every test run.
  await pool.query(`DROP TABLE IF EXISTS donation`)
  await pool.query(`DROP TABLE IF EXISTS donations_indexer_status`)
  await pool.query(`DROP TABLE IF EXISTS donations_indexer_status_legacy`)
  await pool.query(`DROP TABLE IF EXISTS donations_indexer_status_v2`)
}, 90_000)

afterAll(async () => {
  if (anvilProc) {
    anvilProc.kill('SIGTERM')
    anvilProc = null
  }
  await pool?.end()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processor Base e2e — anvil Base fork + real Postgres', () => {
  let startBlock: number
  let nativeTxHash: string
  let usdcTxHash: string

  test(
    'fund Safe with native ETH and transfer USDC to Safe on Base fork',
    async () => {
      // Record fork block.
      const blockNumOut = await runCommand('cast', [
        'block-number',
        '--rpc-url', ANVIL_RPC,
      ])
      startBlock = parseInt(blockNumOut.trim(), 10)

      // Send 0.01 ETH (native) from default funded account to the Safe.
      const nativeOut = await runCommand('cast', [
        'send',
        '--rpc-url', ANVIL_RPC,
        '--private-key', DONOR_PRIVATE_KEY,
        '--value', NATIVE_DONATION_WEI,
        DONATION_SAFE,
      ])
      const nativeHashMatch = nativeOut.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/)
      if (!nativeHashMatch) throw new Error(`Could not extract native tx hash: ${nativeOut}`)
      nativeTxHash = nativeHashMatch[1]!

      // Impersonate USDC whale on Base.
      await runCommand('cast', [
        'rpc',
        '--rpc-url', ANVIL_RPC,
        'anvil_impersonateAccount',
        USDC_WHALE_BASE,
      ])

      // Transfer 50 USDC from whale to the Safe.
      const usdcOut = await runCommand('cast', [
        'send',
        '--rpc-url', ANVIL_RPC,
        '--from', USDC_WHALE_BASE,
        '--unlocked',
        USDC_BASE_ADDRESS,
        'transfer(address,uint256)',
        DONATION_SAFE,
        USDC_DONATION_RAW,
      ])
      const usdcHashMatch = usdcOut.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/)
      if (!usdcHashMatch) throw new Error(`Could not extract USDC tx hash: ${usdcOut}`)
      usdcTxHash = usdcHashMatch[1]!
    },
    30_000,
  )

  test(
    'run processor with CHAIN_SLUG=base — native ETH and USDC donation rows land',
    async () => {
      await runProcessor(
        {
          CHAIN_SLUG: 'base',
          RPC_BASE_HTTP: ANVIL_RPC,
          DONATIONS_DB_URL: TEST_DB_URL,
          START_BLOCK_BASE: String(startBlock),
          FINALITY_CONFIRMATION: '0',
          // No GATEWAY_URL — RPC-only mode.
        },
        30_000,
      )

      // Assert native ETH donation row.
      const { rows: nativeRows } = await pool.query<{
        id: string
        from_address: string
        chain_id: number
        chain_slug: string
        token_symbol: string
        token_decimals: number
        token_address: string | null
        amount_norm: string
      }>(
        `SELECT id, from_address, chain_id, chain_slug,
                token_symbol, token_decimals, token_address,
                amount_norm::text AS amount_norm
           FROM donation
           WHERE tx_hash = $1`,
        [nativeTxHash.toLowerCase()],
      )

      expect(nativeRows).toHaveLength(1)
      const nativeRow = nativeRows[0]!
      expect(nativeRow.chain_id).toBe(BASE_CHAIN_ID)
      expect(nativeRow.chain_slug).toBe('base')
      expect(nativeRow.token_symbol).toBe('ETH')
      expect(nativeRow.token_decimals).toBe(18)
      expect(nativeRow.token_address).toBeNull()
      expect(nativeRow.amount_norm).toBe(NATIVE_DONATION_NORM)
      expect(nativeRow.from_address).toBe(DONOR_ADDRESS.toLowerCase())
      expect(nativeRow.id).toBe(`${BASE_CHAIN_ID}-${nativeTxHash.toLowerCase()}-native`)

      // Assert USDC donation row — key check: decimals=6 (Base USDC is 6, not 18).
      const { rows: usdcRows } = await pool.query<{
        id: string
        from_address: string
        chain_id: number
        chain_slug: string
        token_symbol: string
        token_decimals: number
        token_address: string
        amount_raw: string
        amount_norm: string
        log_index: number
      }>(
        `SELECT id, from_address, chain_id, chain_slug,
                token_symbol, token_decimals, token_address,
                amount_raw::text AS amount_raw, amount_norm::text AS amount_norm,
                log_index
           FROM donation
           WHERE tx_hash = $1`,
        [usdcTxHash.toLowerCase()],
      )

      expect(usdcRows).toHaveLength(1)
      const usdcRow = usdcRows[0]!
      expect(usdcRow.chain_id).toBe(BASE_CHAIN_ID)
      expect(usdcRow.chain_slug).toBe('base')
      expect(usdcRow.token_symbol).toBe('USDC')
      // Crucial: Base USDC is 6 decimals, not 18 — this is the cross-chain
      // decimal verification the spec requires.
      expect(usdcRow.token_decimals).toBe(6)
      expect(usdcRow.token_address).toBe(USDC_BASE_ADDRESS.toLowerCase())
      expect(usdcRow.amount_raw).toBe(USDC_DONATION_RAW)
      expect(usdcRow.amount_norm).toBe(USDC_DONATION_NORM)
      expect(usdcRow.from_address).toBe(USDC_WHALE_BASE.toLowerCase())
      expect(usdcRow.log_index).not.toBeNull()
      expect(usdcRow.log_index).toBeGreaterThanOrEqual(0)
    },
    40_000,
  )

  test(
    'per-chain cursor isolation — chain_id=8453 row present in donations_indexer_status_v2',
    async () => {
      // Assert cursor row exists for Base (chain_id=8453).
      const { rows: cursorRows } = await pool.query<{ chain_id: number; height: number }>(
        `SELECT chain_id, height FROM donations_indexer_status_v2 WHERE chain_id = $1`,
        [BASE_CHAIN_ID],
      )
      expect(cursorRows).toHaveLength(1)
      expect(cursorRows[0]!.chain_id).toBe(BASE_CHAIN_ID)
      expect(cursorRows[0]!.height).toBeGreaterThan(startBlock)

      // Assert no chain_id=1 (Ethereum) cursor row was created — this processor
      // only touches its own chain's cursor.
      const { rows: ethCursorRows } = await pool.query<{ chain_id: number }>(
        `SELECT chain_id FROM donations_indexer_status_v2 WHERE chain_id = 1`,
      )
      expect(ethCursorRows).toHaveLength(0)
    },
    5_000,
  )

  test(
    'second processor run — no duplicate rows, cursor still advanced',
    async () => {
      // Read cursor before second run.
      const { rows: before } = await pool.query<{ height: number }>(
        `SELECT height FROM donations_indexer_status_v2 WHERE chain_id = $1`,
        [BASE_CHAIN_ID],
      )
      const cursorBefore = before[0]!.height

      await runProcessor(
        {
          CHAIN_SLUG: 'base',
          RPC_BASE_HTTP: ANVIL_RPC,
          DONATIONS_DB_URL: TEST_DB_URL,
          START_BLOCK_BASE: String(startBlock),
          FINALITY_CONFIRMATION: '0',
        },
        20_000,
      )

      // Assert no duplicate native row.
      const { rows: nativeCount } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM donation WHERE tx_hash = $1`,
        [nativeTxHash.toLowerCase()],
      )
      expect(nativeCount[0]!.count).toBe('1')

      // Assert no duplicate USDC row.
      const { rows: usdcCount } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM donation WHERE tx_hash = $1`,
        [usdcTxHash.toLowerCase()],
      )
      expect(usdcCount[0]!.count).toBe('1')

      // Cursor still advanced from first run.
      const { rows: after } = await pool.query<{ height: number }>(
        `SELECT height FROM donations_indexer_status_v2 WHERE chain_id = $1`,
        [BASE_CHAIN_ID],
      )
      expect(after[0]!.height).toBeGreaterThanOrEqual(cursorBefore)
    },
    30_000,
  )
})
