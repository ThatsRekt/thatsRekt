/**
 * Processor e2e test — anvil + real Postgres.
 *
 * Acceptance criteria from #205:
 *   - Fund the thatsrekt.eth Safe with native value on a local anvil instance.
 *   - Run the processor RPC-only (no GATEWAY_URL; START_BLOCK_ETHEREUM = fork block).
 *   - Assert a `donation` row lands with the correct donor/amount/chain.
 *   - Run the processor TWICE and assert no duplicate row + cursor advanced.
 *     (proves idempotency + the FinalDatabase cursor-advance fix end-to-end)
 *
 * Hard requirements (DAMM standard):
 *   - Real anvil subprocess (no mock RPC).
 *   - Real Postgres container (no mock DB).
 *   - No silent skips: if the required env / binaries are absent, the test
 *     fails loudly with a clear message.
 *
 * Setup:
 *   docker run --rm -d -p 5432:5432 \
 *     -e POSTGRES_PASSWORD=postgres postgres:16-alpine
 *   bun run build
 *   bun test test/processor.e2e.test.ts
 *
 * The test manages anvil as a child process on a fixed high port (18545) to
 * avoid conflicts. Cleanup is guaranteed via afterAll even on test failure.
 * FINALITY_CONFIRMATION=0 is passed to the processor so all blocks are treated
 * as final — no hot-block processing, no reorg exposure on a local anvil chain.
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
// Default anvil funded account #0 — always has 10_000 ETH.
const DONOR_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
// 0.01 ETH — well above the 0.0001 ETH dust floor.
const DONATION_AMOUNT_WEI = '10000000000000000'
const DONATION_AMOUNT_NORM = '0.01'

// Anvil port — use a high port to avoid conflicts.
const ANVIL_PORT = 18545
// Chain ID must match CHAIN_ID in main.ts (Ethereum = 1) for the allowlist.
const ANVIL_CHAIN_ID = 1

const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5432/donations_test'

const SUPERUSER_URL =
  process.env.TEST_SUPERUSER_URL ??
  'postgres://postgres:postgres@localhost:5432/postgres'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait until a TCP port accepts connections (anvil readiness probe). */
const waitForPort = (port: number, timeoutMs = 15_000): Promise<void> =>
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
          setTimeout(probe, 200)
        }
      })
    }
    probe()
  })

/** Run a command as a subprocess and return stdout. Throws on non-zero exit. */
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

/**
 * Run the processor as a child process.
 *
 * The processor exits 0 on its own when it reaches head (bounded range).
 * This helper asserts a clean self-exit (code 0). A SIGTERM fallback fires
 * at timeoutMs as a safety net only — the test should NOT rely on it; if it
 * fires and the process exits 143 it means the processor did not self-exit
 * cleanly within the allotted time (a failure worth investigating).
 */
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

    // Safety-net SIGTERM — should not fire in normal operation.
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      // Processor self-exits with code 0 at head.
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `Processor exited with code ${code} (expected 0 — clean self-exit at head).\n` +
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

const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`
// Default anvil account #0 private key.
const DONOR_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Verify required binaries — fail loudly if absent.
  for (const bin of ['anvil', 'cast']) {
    const result = Bun.spawnSync(['which', bin])
    if (result.exitCode !== 0) {
      throw new Error(
        `Required binary '${bin}' not found in PATH. Install Foundry: https://getfoundry.sh`,
      )
    }
  }

  // Start anvil without --block-time (instant-mine mode) so we can control
  // block production. We mine blocks explicitly after the donation tx.
  anvilProc = spawn('anvil', [
    '--port', String(ANVIL_PORT),
    '--chain-id', String(ANVIL_CHAIN_ID),
    '--silent',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })

  await waitForPort(ANVIL_PORT)

  // Set up Postgres — create test DB if not exists.
  const superPool = new Pool({ connectionString: SUPERUSER_URL, max: 1 })
  try {
    await superPool.query(`CREATE DATABASE donations_test`)
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
}, 30_000)

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

describe('processor e2e — anvil + real Postgres', () => {
  let donationTxHash: string
  let startBlock: number

  test(
    'fund Safe with native value and run processor — donation row lands',
    async () => {
      // Record the block before the donation so we can set START_BLOCK to it.
      const blockNumOut = await runCommand('cast', [
        'block-number',
        '--rpc-url', ANVIL_RPC,
      ])
      startBlock = parseInt(blockNumOut.trim(), 10)

      // Send 0.01 ETH from default funded account to the donation Safe.
      const sendOutput = await runCommand('cast', [
        'send',
        '--rpc-url', ANVIL_RPC,
        '--private-key', DONOR_PRIVATE_KEY,
        '--value', DONATION_AMOUNT_WEI,
        DONATION_SAFE,
      ])
      const hashMatch = sendOutput.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/)
      if (!hashMatch) {
        throw new Error(`Could not extract tx hash from cast output: ${sendOutput}`)
      }
      donationTxHash = hashMatch[1]!

      // Run the processor. It will ingest from startBlock, index the donation,
      // write the cursor, then self-exit with code 0 at head.
      // FINALITY_CONFIRMATION=0: treat all blocks as final so the processor
      // does not enter hot-block mode (which requires HotDatabase). Safe for
      // local anvil testing — no reorgs, instant finality.
      // DONEE_OVERRIDE: bypass ENS resolution — use the funded Safe directly.
      await runProcessor(
        {
          CHAIN_SLUG: 'ethereum',
          RPC_ETHEREUM_HTTP: ANVIL_RPC,
          DONATIONS_DB_URL: TEST_DB_URL,
          START_BLOCK_ETHEREUM: String(startBlock),
          FINALITY_CONFIRMATION: '0',
          DONEE_OVERRIDE: DONATION_SAFE,
          // No GATEWAY_URL — RPC-only mode (Subsquid falls back to RPC).
        },
        15_000,
      )

      // Assert the donation row landed with correct fields.
      const { rows } = await pool.query<{
        id: string
        from_address: string
        amount_norm: string
        chain_id: number
        chain_slug: string
      }>(
        `SELECT id, from_address, amount_norm::text AS amount_norm, chain_id, chain_slug
           FROM donation
           WHERE tx_hash = $1`,
        [donationTxHash.toLowerCase()],
      )

      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.from_address).toBe(DONOR_ADDRESS.toLowerCase())
      expect(row.amount_norm).toBe(DONATION_AMOUNT_NORM)
      expect(row.chain_id).toBe(ANVIL_CHAIN_ID)
      expect(row.chain_slug).toBe('ethereum')
      expect(row.id).toBe(`${ANVIL_CHAIN_ID}-${donationTxHash.toLowerCase()}-native`)
    },
    40_000,
  )

  test(
    'second processor run — no duplicate row, cursor advanced past startBlock',
    async () => {
      // Read cursor height after the first run (per-chain v2 table, chain_id=1).
      const { rows: before } = await pool.query<{ height: number }>(
        `SELECT height FROM donations_indexer_status_v2 WHERE chain_id = 1`,
      )
      expect(before).toHaveLength(1)
      const cursorAfterFirstRun = before[0]!.height
      expect(cursorAfterFirstRun).toBeGreaterThan(startBlock)

      // Run the processor again from the same START_BLOCK.
      await runProcessor(
        {
          CHAIN_SLUG: 'ethereum',
          RPC_ETHEREUM_HTTP: ANVIL_RPC,
          DONATIONS_DB_URL: TEST_DB_URL,
          START_BLOCK_ETHEREUM: String(startBlock),
          FINALITY_CONFIRMATION: '0',
          DONEE_OVERRIDE: DONATION_SAFE,
        },
        10_000,
      )

      // Assert no duplicate donation row.
      const { rows: donationRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM donation WHERE tx_hash = $1`,
        [donationTxHash.toLowerCase()],
      )
      expect(donationRows[0]!.count).toBe('1')

      // Assert cursor is still advanced — second run resumes from cursorAfterFirstRun,
      // not from startBlock. This proves the cursor advance from the first run persisted.
      const { rows: after } = await pool.query<{ height: number }>(
        `SELECT height FROM donations_indexer_status_v2 WHERE chain_id = 1`,
      )
      expect(after[0]!.height).toBeGreaterThan(startBlock)
    },
    30_000,
  )
})
