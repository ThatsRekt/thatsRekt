/**
 * Processor ERC20 e2e test — anvil mainnet fork + real Postgres.
 *
 * Acceptance criteria from #207:
 *   - Impersonate a USDC whale on a mainnet fork.
 *   - Transfer USDC from the whale to the thatsrekt.eth Safe.
 *   - Run the processor RPC-only (no GATEWAY_URL; START_BLOCK = fork block).
 *   - Assert a `donation` row lands with correct symbol/decimals/amount.
 *   - Also transfer a NON-allowlisted token to the Safe and assert NO row.
 *
 * Hard requirements (DAMM standard):
 *   - Real anvil mainnet fork (no mock RPC).
 *   - Real Postgres container (no mock DB).
 *   - No silent skips: if required env/binaries are absent the test fails
 *     loudly with a clear message.
 *
 * Setup (same Postgres as the native e2e test — different DB name):
 *   docker run --rm -d -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   # Set FORK_URL to any Ethereum archive RPC:
 *   export FORK_URL=https://lb.routeme.sh/rpc/1/YOUR_KEY
 *   bun run build
 *   bun test test/processor.erc20.e2e.test.ts
 *
 * The test forks Ethereum mainnet so that USDC and other real ERC20s exist at
 * their canonical addresses. It uses a high port (18546) to avoid conflicts
 * with the native ETH e2e test (18545).
 *
 * FINALITY_CONFIRMATION=0 is set so the processor treats all blocks as final.
 * The anvil fork uses instant-mine mode (no block-time) for determinism.
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
const DONATION_SAFE_LOWER = DONATION_SAFE.toLowerCase()

// USDC on Ethereum mainnet (allowlisted, 6 decimals).
// Verified on-chain: decimals()=6, symbol()="USDC"
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

// Binance 14 hot wallet — known USDC whale with billions of USDC.
// Impersonated via anvil_impersonateAccount for the test transfer.
const USDC_WHALE = '0x28C6c06298d514Db089934071355E5743bf21d60'

// Non-allowlisted token — a well-known token that is intentionally NOT in
// our allowlist (UNI). Used to prove the anti-spam drop works.
// UNI is a legitimate token but not in our donation allowlist.
const UNI_ADDRESS = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'
// UNI whale (Uniswap governance timelock)
const UNI_WHALE = '0x1a9C8182C09F50C8318d769245beA52c32BE35BC'

// 100 USDC = 100 * 10^6 = 100_000_000 raw units.
const USDC_DONATION_RAW = '100000000'
const USDC_DONATION_NORM = '100'

// 50 UNI — non-allowlisted, should produce no row.
const UNI_DONATION_RAW = '50000000000000000000' // 50 * 10^18

// Anvil port for the fork — different from native test (18545).
const ANVIL_FORK_PORT = 18546
const ANVIL_FORK_CHAIN_ID = 1

// Fork URL — required env var for the ERC20 e2e test.
// Skip the test with a clear message if not set.
const FORK_URL = process.env.FORK_URL ?? process.env.RPC_ETHEREUM_HTTP ?? ''

const TEST_DB_NAME = 'donations_erc20_test'
const TEST_DB_URL =
  process.env.TEST_ERC20_DB_URL ??
  `postgres://postgres:postgres@localhost:5432/${TEST_DB_NAME}`

const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres'

// ---------------------------------------------------------------------------
// Helpers (mirrors processor.e2e.test.ts)
// ---------------------------------------------------------------------------

const waitForPort = (port: number, timeoutMs = 30_000): Promise<void> =>
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

const ANVIL_RPC = `http://127.0.0.1:${ANVIL_FORK_PORT}`

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Skip loudly if no fork URL is configured.
  if (!FORK_URL) {
    throw new Error(
      'ERC20 e2e test requires a mainnet fork URL. ' +
        'Set FORK_URL or RPC_ETHEREUM_HTTP env var to an Ethereum archive RPC endpoint.',
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

  // Start anvil forking Ethereum mainnet.
  // instant-mine mode (no --block-time) so we control block production.
  anvilProc = spawn(
    'anvil',
    [
      '--port', String(ANVIL_FORK_PORT),
      '--chain-id', String(ANVIL_FORK_CHAIN_ID),
      '--fork-url', FORK_URL,
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )

  // Fork takes longer to start than a blank chain.
  await waitForPort(ANVIL_FORK_PORT, 60_000)

  // Set up Postgres — create test DB if not exists.
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

describe('processor ERC20 e2e — anvil mainnet fork + real Postgres', () => {
  let startBlock: number
  let usdcTxHash: string
  let uniTxHash: string

  test(
    'transfer allowlisted USDC to Safe and non-allowlisted UNI to Safe',
    async () => {
      // Record fork block so we set START_BLOCK to it.
      const blockNumOut = await runCommand('cast', [
        'block-number',
        '--rpc-url', ANVIL_RPC,
      ])
      startBlock = parseInt(blockNumOut.trim(), 10)

      // Impersonate USDC whale.
      await runCommand('cast', [
        'rpc',
        '--rpc-url', ANVIL_RPC,
        'anvil_impersonateAccount',
        USDC_WHALE,
      ])

      // Transfer 100 USDC (100_000_000 raw units) from whale to the Safe.
      // ERC20 transfer(address to, uint256 amount) = sighash 0xa9059cbb
      const usdcOut = await runCommand('cast', [
        'send',
        '--rpc-url', ANVIL_RPC,
        '--from', USDC_WHALE,
        '--unlocked',
        USDC_ADDRESS,
        'transfer(address,uint256)',
        DONATION_SAFE,
        USDC_DONATION_RAW,
      ])
      const usdcHashMatch = usdcOut.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/)
      if (!usdcHashMatch) throw new Error(`Could not extract USDC tx hash: ${usdcOut}`)
      usdcTxHash = usdcHashMatch[1]!

      // Impersonate UNI whale.
      await runCommand('cast', [
        'rpc',
        '--rpc-url', ANVIL_RPC,
        'anvil_impersonateAccount',
        UNI_WHALE,
      ])

      // Transfer 50 UNI from whale to the Safe (UNI is NOT allowlisted).
      const uniOut = await runCommand('cast', [
        'send',
        '--rpc-url', ANVIL_RPC,
        '--from', UNI_WHALE,
        '--unlocked',
        UNI_ADDRESS,
        'transfer(address,uint256)',
        DONATION_SAFE,
        UNI_DONATION_RAW,
      ])
      const uniHashMatch = uniOut.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/)
      if (!uniHashMatch) throw new Error(`Could not extract UNI tx hash: ${uniOut}`)
      uniTxHash = uniHashMatch[1]!
    },
    30_000,
  )

  test(
    'run processor — USDC donation row lands, UNI row absent',
    async () => {
      // Run the processor from startBlock.
      await runProcessor(
        {
          CHAIN_SLUG: 'ethereum',
          RPC_ETHEREUM_HTTP: ANVIL_RPC,
          DONATIONS_DB_URL: TEST_DB_URL,
          START_BLOCK_ETHEREUM: String(startBlock),
          FINALITY_CONFIRMATION: '0',
          // No GATEWAY_URL — RPC-only mode.
        },
        30_000,
      )

      // Assert: USDC donation row landed with correct fields.
      const { rows: usdcRows } = await pool.query<{
        id: string
        from_address: string
        token_address: string
        token_symbol: string
        token_decimals: number
        amount_raw: string
        amount_norm: string
        chain_id: number
        chain_slug: string
        log_index: number
      }>(
        `SELECT id, from_address, token_address, token_symbol, token_decimals,
                amount_raw::text AS amount_raw, amount_norm::text AS amount_norm,
                chain_id, chain_slug, log_index
           FROM donation
           WHERE tx_hash = $1`,
        [usdcTxHash.toLowerCase()],
      )

      expect(usdcRows).toHaveLength(1)
      const usdcRow = usdcRows[0]!
      expect(usdcRow.token_symbol).toBe('USDC')
      expect(usdcRow.token_decimals).toBe(6)
      expect(usdcRow.token_address).toBe(USDC_ADDRESS.toLowerCase())
      expect(usdcRow.amount_raw).toBe(USDC_DONATION_RAW)
      expect(usdcRow.amount_norm).toBe(USDC_DONATION_NORM)
      expect(usdcRow.from_address).toBe(USDC_WHALE.toLowerCase())
      expect(usdcRow.chain_id).toBe(ANVIL_FORK_CHAIN_ID)
      expect(usdcRow.chain_slug).toBe('ethereum')
      expect(usdcRow.log_index).not.toBeNull()
      expect(usdcRow.log_index).toBeGreaterThanOrEqual(0)

      // Assert: UNI donation row is absent (UNI is NOT allowlisted).
      const { rows: uniRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM donation WHERE tx_hash = $1`,
        [uniTxHash.toLowerCase()],
      )
      expect(uniRows[0]!.count).toBe('0')
    },
    40_000,
  )

  test(
    'second processor run — USDC row count stays at 1 (idempotency)',
    async () => {
      await runProcessor(
        {
          CHAIN_SLUG: 'ethereum',
          RPC_ETHEREUM_HTTP: ANVIL_RPC,
          DONATIONS_DB_URL: TEST_DB_URL,
          START_BLOCK_ETHEREUM: String(startBlock),
          FINALITY_CONFIRMATION: '0',
        },
        20_000,
      )

      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM donation WHERE tx_hash = $1`,
        [usdcTxHash.toLowerCase()],
      )
      expect(rows[0]!.count).toBe('1')
    },
    30_000,
  )
})
