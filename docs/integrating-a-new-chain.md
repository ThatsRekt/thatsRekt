# Runbook: integrating a new chain into thatsRekt

This checklist captures the exact procedure executed end-to-end when adding BNB Smart Chain
(chain 56) to the thatsRekt stack. Follow it in order. Each section is a gate: do not
move to the next section until the current one is complete and verified onchain / in prod.

**Reference implementation (BSC):**

- `thatsRekt#154`: address-parity CI gate
- `thatsRekt#155`: contracts CI (forge pinning)
- `damm-thatsrekt-relayer#122`: relayer per-chain config
- `damm-cloud#183`: relayer Lambda + SQS queue
- `hack-monitor-claw#74`: chain-56 dispatch routing
- `thatsRekt#156` + `damm-cloud#184`: indexer + Fargate instance
- `thatsRekt#157`: mesh chain entry
- `thatsRekt#158`: frontend liveIndexed promotion
- `damm-top-up-monitor#28`: gas monitor seed

---

## 0. Prerequisites and the address-parity invariant

The thatsRekt proxy **must deploy at the canonical CREATE2 address
`0xBfaEEE9662b4c037De24e5Caa65815350d57b89A` on every chain.** This is a hard
requirement. Breaking it means the cross-chain public registry is no longer a single
address, destroying trust and integration assumptions.

The address depends on a fixed tuple:

- CREATE2 factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C` (universal singleton; must
  be deployed on the target chain; check onchain before proceeding)
- Deployer EOA: `0xb5a6c8ca369e38050784e2a6793bee6447109340`
- The ORIGINAL canonical 6 `initialWhitelisters` (order matters): `0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4`, `0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45`, `0x9e8680dbbca1127add812abe209a10e621b385df`, `0x24c2167054a9a9e00f67233f1ebc4060501f54fa`, `0xe0396d6d738e726d39f96099b8f6a55d11184374`, `0xb5a6c8ca369e38050784e2a6793bee6447109340`
- Governance Safe: `0x59E4DBc95BD312A882Bb36b7f3E8298682340679`
- Exact bytecode from forge 1.5.1 + solc 0.8.25 + `via_ir = true`

**Do NOT use today's live whitelister set as the `initialWhitelisters` argument.**
The CREATE2 address is derived from bytecode + constructor args. Runtime state
(whitelisters) is reconciled post-deploy via governance (step 2). Deploy with the original
6-address canonical tuple; add everyone else afterwards.

### ⚠️ Bytecode is platform- AND forge-version-sensitive

`solc 0.8.25` with `via_ir = true` produces different bytecode on Linux vs macOS-arm64.
The canonical address `0xBfaEEE…89A` was produced on **macOS-arm64 with forge 1.5.1**.

- **Deploy MUST run on macOS-arm64.** Linux produces a different address.
- **forge version MUST be 1.5.1.** Newer versions (e.g. 1.7.1) produce different bytecode.
  Verify: `forge --version` must print `forge 1.5.1-...`. If not: `foundryup --install 1.5.1`.
- CI runs Linux; the parity gate is excluded from CI for this reason (see `thatsRekt#155`).
  Parity is enforced locally on the deploy machine before broadcast.

### Pre-flight gate (run on the deploy machine, macOS-arm64)

Before broadcasting anything:

```bash
cd contracts/
forge clean
forge test --match-test testCanonicalAddressParity -vv
```

The `CanonicalAddressParity` test drives the real `Deploy.deploy()` function and asserts all
5 addresses. It **must pass and print `0xBfaEEE9662b4c037De24e5Caa65815350d57b89A`**. If it
fails, STOP. Investigate before touching `--broadcast`.

Alternatively, run `PredictAddresses.s.sol`:

```bash
forge script script/PredictAddresses.s.sol \
  --sender 0xb5a6c8ca369e38050784e2a6793bee6447109340 \
  --rpc-url <new_chain_rpc>
```

Output must include `Proxy (canonical): 0xBfaEEE9662b4c037De24e5Caa65815350d57b89A`.

### ⚠️ Universal CREATE2 factory must be present on the new chain

```bash
cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url <new_chain_rpc>
```

Must return non-empty bytecode. If the factory is missing, the deploy will fail silently
(or deploy to a wrong address). Some chains require a separate factory bootstrap.

---

## 1. Deploy contracts

> **Who:** operator (controls deployer EOA `0xb5a6c8…9340`). HITL step.

- [ ] Verify the universal CREATE2 factory is deployed (see §0).
- [ ] Fund deployer EOA `0xb5a6c8ca369e38050784e2a6793bee6447109340` with the new chain's
      native token (estimate gas from a dry-run first; BSC example: ~0.0004 BNB at 0.05 gwei).
- [ ] Run the dry-run (no broadcast) to confirm the address before committing:
  ```bash
  forge script script/Deploy.s.sol \
    --rpc-url <new_chain_rpc> \
    --sender 0xb5a6c8ca369e38050784e2a6793bee6447109340 \
    -vvvv 2>&1 | tee /tmp/deploy-dryrun.log
  ```
  Verify the log prints proxy `0xBfaEEE9662b4c037De24e5Caa65815350d57b89A` and the 4
  supporting addresses (impl, upgradeTLC, addTLC, purgeTLC) match every other chain.
- [ ] Broadcast (stream to log file; do not pipe through tail):
  ```bash
  forge script script/Deploy.s.sol \
    --rpc-url <new_chain_rpc> \
    --broadcast \
    --slow \
    -vvvv 2>&1 | tee /tmp/deploy-broadcast.log
  ```
- [ ] Record the **deploy block number** from the broadcast output. You will need it for the
      indexer `startBlock` (step 4). BSC example: block `101156350`.
- [ ] Verify on the chain's block explorer:
  - Proxy at `0xBfaEEE9662b4c037De24e5Caa65815350d57b89A`
  - `owner()` == upgradeTLC `0xf6F807f095D6D09c1216ffBd6AaCBB73D8F02aB6` (the 7-day
    timelock, canonical on every chain). NOTE: this is **not** the governance Safe
    `0x59E4DBc95BD312A882Bb36b7f3E8298682340679`; the Safe is the upgradeTLC's _proposer_
    and the `swapOwner` target in step 2, never the proxy's `owner()`.
  - `whitelistAdmin()` == addTLC `0xB83AB5772f919BE72b4AaB98456eDdED5ad68D4f`
  - `whitelistRemover()` == operator `0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45`

---

## 2. Governance: whitelist parity + owner reconcile

> **Who:** operator (controls 2-of-5 governance Safe). HITL step. Starts the 3-day timelock.

The newly deployed proxy has the original 6 whitelisters. The live set on other chains has
grown. Reconcile by:

1. **swapOwner**: adjust the BSC Safe's owners to match other chains' current post-cutover
   owner set (this is immediate, no timelock).
2. **Add-TLC scheduleBatch**: schedule `addWhitelisted` for every address in the live
   mainnet set that is not in the initial 6, including the relayer poster EOA
   (`0xFe6B4dFf18D741e725c7c6922CCF69121B2fFFdb`). This has a **3-day timelock** before
   execute.

### Enumerate the current live whitelister set

```bash
# Scan WhitelistUpdated events on mainnet (or any already-integrated chain)
cast logs \
  --rpc-url https://lb.routeme.sh/rpc/1/3bd2e340-f97c-46b3-80ed-17975de5af89 \
  --address 0xBfaEEE9662b4c037De24e5Caa65815350d57b89A \
  --from-block <mainnet_deploy_block> \
  "WhitelistUpdated(address,bool)"
```

Alternatively, use the proposal script at `ops/scripts/propose-bsc-whitelist-parity.ts`
(worktree `thatsRekt-bsc-gov`, branch `bauti/bsc-whitelist-parity-proposal`); it reads the
live set from mainnet, diffs against the initial 6, and builds the MultiSendCallOnly batch.

### Build and propose the Safe batch

Use `ops/scripts/propose-bsc-whitelist-parity.ts` as the reference implementation.

The batch is: `[swapOwner(...), addTLC.scheduleBatch(addWhitelisted×N)]` via
`MultiSendCallOnly` (`onlyCalls: true`).

**⚠️ Safe signing gotcha:** when proposing via the Safe Transaction Service from a delegate
EOA, sign the raw `safeTxHash` digest (not `signMessage`). Using `signMessage` applies
EIP-191 prefix `\x19Ethereum Signed Message:\n32`, producing a hash the service cannot
recover. The service recovers the wrong signer address and rejects the proposal (HTTP 4xx).

```typescript
// CORRECT — sign the raw digest
const sig = await account.sign({ hash: safeTxHash });

// WRONG — do NOT use this; it EIP-191-prefixes the hash
const sig = await account.signMessage({ raw: safeTxHash });
```

The Safe Transaction Service URL for BSC:
`https://safe-transaction-bnb.safe.global/api/v1/safes/{safe}/multisig-transactions/`

### After proposing

- [ ] Confirm the proposal appears in the Safe UI with 0 confirmations.
- [ ] Collect 2-of-5 signatures from Safe owners.
- [ ] Execute: `swapOwner` lands immediately; it is NOT timelocked.
- [ ] Verify `swapOwner` result onchain: new owners match other chains.
- [ ] Wait 3 days for the Add-TLC timelock to mature.
- [ ] Execute `executeBatch` on the Add-TLC (executor role is open; any address can call it).
      Keep the salt from the `scheduleBatch` call; you'll need it:
  ```bash
  cast send 0xB83AB5772f919BE72b4AaB98456eDdED5ad68D4f \
    "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)" \
    [...] \
    --rpc-url <new_chain_rpc> \
    --private-key <any_funded_key>
  ```
- [ ] Fund the relayer poster EOA `0xFe6B4dFf18D741e725c7c6922CCF69121B2fFFdb` with native
      token on the new chain BEFORE the whitelist executes (else gas will be insufficient for
      the first post).

> **Apply-gate:** do NOT activate the relayer (step 3 Terraform apply) or hack-claw routing
> (step 3) until this step is complete and the poster is whitelisted onchain. Messages
> published to SQS before the poster is whitelisted will hit the contract, revert, and DLQ.

---

## 3. Relayer: per-chain Lambda + queue + hack-claw routing

Steps 3-5 can be worked in parallel during the 3-day timelock window, but **the Terraform
apply and hack-claw env var population must not go live** until the poster is whitelisted
(see apply-gate above).

### 3a. Relayer Go code: update all per-chain branches

Open a worktree against `damm-thatsrekt-relayer` (default branch: `main`).

**⚠️ Grep every per-chain branch across the whole service.** The relayer has three distinct
per-chain switch/map statements; missing any one causes silent correctness bugs.

Run this before writing any code:

```bash
grep -rn "switch chainID\|map\[uint64\]\|chainId ==" \
  internal/ cmd/ test/ 2>/dev/null
```

The three locations you must update for each new chain:

| Location            | File                                  | What to add                                                        |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `ReceiptTimeouts`   | `internal/broadcaster/broadcaster.go` | `<chainID>: <N> * time.Second`, pick conservatively (BSC: 90s)     |
| `perChainTipFloors` | `internal/broadcaster/broadcaster.go` | `<chainID>: new(big.Int).SetUint64(<wei>)`, BSC legacy gas: 1 gwei |
| `blocksForDuration` | `internal/idempotency/idempotency.go` | new `case <chainID>:` with `blockTimeSec = <N>`                    |

**`blocksForDuration` block-time rule:** use a conservative value rounded DOWN to the
nearest smaller number (more blocks = more scanning = safer). A value that is too high
→ shorter lookback → duplicate onchain posts.

BSC block time after the Maxwell hardfork is ~0.45s (sub-second). Do NOT use 1s.

```go
case 56: // BNB Smart Chain — ~0.45s/block post-Maxwell hardfork
    blockTimeSec = 0.4
```

Write an Anvil-fork e2e test for the new chain (`test/v21harness/`) mirroring the existing
per-chain test pattern. The test must:

1. Deploy thatsRekt onto an Anvil fork of the new chain.
2. Call `postAdd`, `postAmend`, `postRetract`.
3. Assert idempotency (duplicate SQS message → no second onchain tx).

Run before claiming done:

```bash
make lint   # golangci-lint v2 + gofmt — must be clean
make test   # full suite including the new chain
```

### 3b. Infrastructure (damm-cloud)

Open a worktree against `damm-cloud` (default branch: **`main`**, not `master`).

Add the new chain to the `for_each` sets in `terraform/lambdas.tf`:

- The Lambda function map (one entry per chain)
- The SQS FIFO queue map
- The event-source mapping

Add the new chain's RPC endpoint to the relayer's Secrets Manager entry
(`prod/thatsrekt-relayer/rpc`). The key convention follows the existing pattern (e.g.
`BSC_RPC_URL` for chain 56).

Reference: `damm-cloud#183` is the canonical single-entry add; the diff is minimal.

**⚠️ damm-cloud has no apply-on-merge CI.** Merging the Terraform PR is safe; it only
changes infra on `terraform apply`, which is a manual operator step. Plan (`terraform plan`)
reports zero destroys for a clean single-chain add.

**Apply-gate:** apply only after step 2 is complete (poster whitelisted). Until then, the
Lambda exists but inbound events would DLQ against an unwhitelisted address.

### 3c. hack-monitor-claw: add routing for the new chain

Open a worktree against `hack-monitor-claw`.

Add one entry to `CHAIN_ENV_VAR` in
`src/hackmonitorclaw/v2/chain_dispatch.py`:

```python
CHAIN_ENV_VAR: dict[int, str] = {
    31337: "THATSREKT_RELAY_QUEUE_URL_ANVIL",
    1:     "THATSREKT_RELAY_QUEUE_URL_MAINNET",
    10:    "THATSREKT_RELAY_QUEUE_URL_OPTIMISM",
    8453:  "THATSREKT_RELAY_QUEUE_URL_BASE",
    42161: "THATSREKT_RELAY_QUEUE_URL_ARBITRUM",
    56:    "THATSREKT_RELAY_QUEUE_URL_BSC",   # ← new chain
}
```

Then populate the env var (`THATSREKT_RELAY_QUEUE_URL_BSC`) in the hack-claw ECS task
definition / Secrets Manager entry. The queue URL is the SQS FIFO URL provisioned in step 3b.

**⚠️ Do not populate the env var until the Terraform apply from 3b is complete** (the queue
must exist before the claw tries to publish to it).

Reference: `hack-monitor-claw#74`.

---

## 4. Visibility: indexer → mesh → frontend

The thatsRekt visibility stack runs as **docker-compose on EC2** (`i-0f04208035a7b5a4b`),
accessed via SSM. It is NOT ECS Fargate. Each chain gets a trio of compose services:
`migrate-<chain>`, `processor-<chain>`, `graphql-<chain>`. Chains are activated by adding
the slug to `MESH_CHAINS` in Secrets Manager + redeploying the compose stack
(`IMAGE_TAG` = full git SHA, not short).

Three data-driven registries must stay in sync. Add the new chain to all three in the same
PR (or a tightly coupled pair of PRs: indexer+mesh together, then frontend). Two additional
non-data-driven surfaces must also be updated by hand (§4e); they are NOT derived from
`chains.ts` and NOT caught by the slug-coverage test.

### 4a. Indexer: `indexer/src/chains.ts`

Add a `ChainConfig` entry:

```typescript
bsc: {
  chainId: 56,
  slug: 'bsc',
  name: 'BNB Smart Chain',
  gateway: 'https://v2.archive.subsquid.io/network/binance-mainnet', // or null if no archive
  rpcEnvVar: 'RPC_BSC_HTTP',
  contractEnvVar: 'CONTRACT_BSC',
  startBlockEnvVar: 'START_BLOCK_BSC',
  finalityConfirmation: 15,
  rpcRateLimit: 10,
},
```

**`startBlock` = deploy block from step 1** (e.g. `101156350`). This prevents the processor
from scanning from genesis and saves hours of sync time.

**`gateway`:** check Subsquid's archive list before assuming one exists:

```bash
curl -s https://cdn.subsquid.io/archives/evm.json | jq '.[] | select(.network | test("bsc|binance"))'
```

If no archive exists, set `gateway: null` and the processor falls back to RPC-only mode
(slower initial sync, same correctness).

Also add to `indexer/db/init.sql` (the DB init for the new chain's schema) and the
`indexer/docker-compose.yml` production compose file (new `migrate-bsc`, `processor-bsc`,
`graphql-bsc` service trio). Port numbers must not collide with existing services.

Reference: `thatsRekt#156` + `damm-cloud#184`.

### 4b. Mesh: `mesh/src/chains.ts`

Add a `ChainEntry`:

```typescript
{
  chainId: 56,
  slug: 'bsc',
  name: 'BNB Smart Chain',
  prefix: 'Bsc_',
  endpoint: process.env.GRAPHQL_BSC_URL ?? 'http://graphql-bsc:4362/graphql',
  registryAddress: '0xBfaEEE9662b4c037De24e5Caa65815350d57b89A',
},
```

The `prefix` value drives GraphQL schema stitching. It must be unique, must not contain
hyphens (GraphQL field names cannot), and must be consistent with the slug-to-prefix bridge
in the frontend (step 4c).

The `endpoint` port must match the `graphql-<chain>` compose service port from step 4a.

**⚠️ Cross-repo stale checkout footgun:** if your worktree checked out `damm-cloud` before
`damm-cloud#184` merged, it will falsely report `GRAPHQL_BSC_URL` as unwired. Run
`git fetch origin && git log origin/main -3` in the `damm-cloud` clone before trusting any
"missing" claims about cross-repo state. `damm-cloud` default branch is `main`, not `master`.

Reference: `thatsRekt#157`.

### 4c. Frontend: `frontend/src/lib/chains.ts` and `queries.ts`

Two changes required:

**1. Flip `liveIndexed` to `true`** in `frontend/src/lib/chains.ts`:

```typescript
bsc: {
  chainId: 56,
  slug: 'bsc',
  name: 'BNB Smart Chain',
  badge: 'bsc',
  explorer: 'https://bscscan.com',
  isLocalFork: false,
  isTestnet: false,
  liveIndexed: true,   // ← was false (archive-only)
},
```

**2. Add a `SLUG_TO_PREFIX` entry** in `frontend/src/lib/queries.ts`:

```typescript
export const SLUG_TO_PREFIX: Record<string, string> = {
  "anvil-eth": "AnvilEth",
  "anvil-base": "AnvilBase",
  sepolia: "Sepolia",
  ethereum: "Ethereum",
  base: "Base",
  "base-sepolia": "BaseSepolia",
  optimism: "Optimism",
  arbitrum: "Arbitrum",
  bsc: "Bsc", // ← new chain — prefix must match mesh/src/chains.ts `prefix` without trailing _
};
```

**⚠️ liveIndexed chains MUST have a `SLUG_TO_PREFIX` entry.** A `liveIndexed: true` chain
without a matching entry causes `/post/<slug>/<id>` to 500. The slug-coverage test in
`frontend/test/slug-coverage.test.ts` enforces this invariant; it will fail CI if you
promote a chain without adding the prefix bridge.

Reference: `thatsRekt#158`.

### 4d. Activate on prod

Once all three registry PRs are merged and images are built:

1. Update `MESH_CHAINS` in Secrets Manager to include the new chain slug.
2. Rewire the compose stack on EC2 `i-0f04208035a7b5a4b` via SSM:
   ```bash
   IMAGE_TAG=<full_git_sha>  # never short SHA, compose pull fails
   # Update INDEXER_TAG / MESH_TAG / FRONTEND_TAG overrides as needed
   ```
3. The public TG notifier is chain-agnostic (reads the unified mesh feed); no change
   required there.

### 4e. Non-data-driven surfaces: README table + OG explorer map

> **Who:** any integrator. Done in the same PR as 4a-4c (or as a follow-up patch before
> closing the integration issue). These two surfaces are NOT derived from `chains.ts` and
> are NOT covered by the slug-coverage test; they must be updated by hand.

**⚠️ This is exactly why BSC was partially integrated.** Both surfaces were missed because
no checklist item reminded the integrator to update them. Do not let the next chain slip.

#### README.md: canonical-address chain table

Add the new chain's row to the table in `README.md` (under the
`0xBfaEEE9662b4c037De24e5Caa65815350d57b89A` address block). Follow the existing format:

```markdown
| <Chain Name> | <chainId> | [<explorer-label>](<explorer_url>/address/0xBfaEEE9662b4c037De24e5Caa65815350d57b89A) |
```

Example (BSC, chain 56):

```markdown
| BNB Smart Chain | 56 | [bscscan](https://bscscan.com/address/0xBfaEEE9662b4c037De24e5Caa65815350d57b89A) |
```

The table lives at roughly lines 21-26 of `README.md`. Keep rows ordered by integration
date (append to the bottom of the table).

#### mesh/src/og.ts: explorerAddressUrl map

Add an entry for the new chain's slug to the `base` object inside `explorerAddressUrl`
in `mesh/src/og.ts`. This map drives the `author.url` field in the Article JSON-LD block
that social-card crawlers (Google, Telegram, Discord) consume.

```typescript
const base: Record<string, string> = {
  "anvil-eth": "",
  "anvil-base": "",
  sepolia: "https://sepolia.etherscan.io",
  base: "https://basescan.org",
  "base-sepolia": "https://sepolia.basescan.org",
  optimism: "https://optimistic.etherscan.io",
  ethereum: "https://etherscan.io", // add if missing
  arbitrum: "https://arbiscan.io", // add if missing
  bsc: "https://bscscan.com", // ← new chain example
};
```

> **Note:** as of the BSC integration (2026-05), `ethereum` and `arbitrum` were also
> missing from this map. Any integrator adding a new chain should check whether the
> already-live chains are present and add any that are absent in the same PR.

- [ ] README.md chain table row added.
- [ ] `mesh/src/og.ts` `explorerAddressUrl` map entry added (and any already-live chains
      that were missing have been backfilled).

---

## 5. Gas monitor

Open a worktree against `damm-top-up-monitor`.

Add the new chain to `KMS_EOA_CHAINS` in the seed script. For BSC (chain 56), the support
registries (`threshold`, `<CHAIN>_JSON_RPC` env var) were already wired; verify they exist
before adding a new chain:

```bash
# Check that the chain's RPC env var is pre-wired in the monitor's chain registry
grep -n "56\|BSC\|bnb" src/monitor/chains.ts  # or equivalent
```

If the chain is not pre-wired, add it to the chain registry first (threshold + RPC + display
name), then add it to the seed.

Apply the seed script and deploy **paired with funding the poster**: if the poster is
below-threshold at the moment the monitor first polls, it will immediately fire an alert.
Fund first, then apply+deploy.

Reference: `damm-top-up-monitor#28`.

---

## 6. Funding and end-to-end validation

- [ ] Fund deployer EOA `0xb5a6c8…9340` with enough native token for the deploy gas (step 1).
- [ ] Fund relayer poster `0xFe6B4dFf18D741e725c7c6922CCF69121B2fFFdb` with enough native
      token for at least 100 onchain posts (step 2 + step 5).
- [ ] Once the 3-day timelock has elapsed and `executeBatch` is run: verify the poster is
      listed as a whitelister on the new chain's proxy:
  ```bash
  cast call 0xBfaEEE9662b4c037De24e5Caa65815350d57b89A \
    "isWhitelisted(address)(bool)" \
    0xFe6B4dFf18D741e725c7c6922CCF69121B2fFFdb \
    --rpc-url <new_chain_rpc>
  # must return true
  ```
- [ ] Trigger a real end-to-end event: submit a `createPost` action for the new chain
      (either via hack-claw re-emit or by manually enqueuing the SQS message). Confirm:
  - [ ] Onchain: `post()` tx lands at `0xBfaEEE…89A` on the new chain.
  - [ ] Indexer: the event is processed (check `processor-<chain>` logs).
  - [ ] Mesh: the post appears in the unified GraphQL feed.
  - [ ] Frontend: the post renders with the correct chain badge and explorer links.
  - [ ] Public TG channel: the notifier fires the alert.

---

## Appendix: gotchas reference

| #   | Gotcha                                                                                    | Impact                                                                                                                                               | Fix                                                                                                |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| G1  | Canonical bytecode is **macOS-arm64 + forge 1.5.1** only                                  | Deploy on Linux or wrong forge version → wrong address → parity broken                                                                               | Deploy from macOS-arm64; verify forge version; run parity gate before broadcast                    |
| G2  | Universal CREATE2 factory may not be deployed on new chain                                | `forge script --broadcast` silently deploys to wrong address                                                                                         | `cast code 0x4e59b…4956C` must return non-empty bytecode first                                     |
| G3  | Safe signing: `signMessage` vs `account.sign`                                             | `signMessage` EIP-191-prefixes → service recovers wrong signer → HTTP 4xx proposal rejection                                                         | Use `account.sign({ hash: safeTxHash })` (signs raw digest only)                                   |
| G4  | Relayer has three per-chain branches, not one                                             | Missing `blocksForDuration` case → dedup lookback 5h instead of 24h → duplicate onchain posts                                                        | `grep -rn "switch chainID\|map\[uint64\]"` before writing code; add a case to all three            |
| G5  | `blocksForDuration` rounds wrong direction                                                | Using `ceil` or a safe round → shorter lookback → missed dedup window                                                                                | Round DOWN (use a block time slightly shorter than reality → more blocks → safer)                  |
| G6  | Stale cross-repo checkout                                                                 | Worktree for repo A was cut before a critical PR merged in repo B → falsely reports "X is missing"                                                   | `git fetch origin && git log origin/main -3` in every cross-repo clone before relying on its state |
| G7  | `damm-cloud` default branch is `main`; `thatsRekt` is `master`                            | Grepping `origin/master` in damm-cloud finds nothing                                                                                                 | Note the default branch per repo; fetch + check `origin/main` for damm-cloud                       |
| G8  | `liveIndexed: true` without a `SLUG_TO_PREFIX` entry                                      | `/post/<slug>/<id>` 500s                                                                                                                             | The slug-coverage test enforces it; add to both places atomically                                  |
| G9  | Compose stack uses full git SHA for `IMAGE_TAG`, not short SHA                            | `compose pull` fails silently on short SHA → old image runs                                                                                          | Always use the full 40-char SHA                                                                    |
| G10 | Apply-gate: Terraform apply + hack-claw routing before poster is whitelisted              | Events published to SQS reach the contract, reverts, DLQ fills up                                                                                    | Apply infra and activate routing only AFTER `executeBatch` confirms the poster is whitelisted      |
| G11 | Gas monitor seed without prior funding                                                    | Monitor fires immediate below-threshold alert                                                                                                        | Fund poster first, then apply seed + deploy                                                        |
| G12 | `README.md` chain table and `mesh/src/og.ts` `explorerAddressUrl` map are NOT data-driven | New chain silently absent from the public README and from Article JSON-LD `author.url` in social cards; slug-coverage test does NOT catch either gap | Update both by hand in §4e; they are not derived from `chains.ts` and no CI gate enforces them     |

### Known limitation: silent drop for non-integrated chains

Hacks on chains not yet integrated into thatsRekt are **silently dropped** at the
hack-claw publish boundary. When `chain_dispatch.py` cannot resolve a queue URL for a
`chain_id` (i.e., the chain is not in `CHAIN_ENV_VAR` and `SQS_ACTION_QUEUE_URL` is unset),
it raises `ChainQueueMisconfiguredError`. The caller logs the error but does not alert;
the action never enters SQS and is never posted onchain. There is no retry, no DLQ, no
public TG alert.

**This is a known, accepted limitation** (operator decision). Adding a new chain to the
stack is the only remedy. Operators integrating a new chain may want to search hack-claw
logs for historical `ChainQueueMisconfiguredError` entries referencing the new `chain_id`
to identify hacks that should be backfilled once posting is live.
