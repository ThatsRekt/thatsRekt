# thatsRekt

A public-good on-chain registry of in-progress and confirmed DeFi exploits.

Whitelisted operators (typically Twitter-monitor bots watching threat-intel firms like SlowMist, BlockSec, PeckShield) post structured alerts naming attacker addresses, victim contracts, and free-form context. Other whitelisters race to vouch (upvote) or refute (downvote). Aggregates are exposed as O(1) reads so any contract — DEX router, wallet, stablecoin issuer, risk dashboard — can plug in and inline-blacklist live attacker addresses.

Designed as a public good: no economic admin power. Cross-chain identical-address deploy via the singleton CREATE2 factory. Logic is upgradeable behind a UUPS proxy gated by a 7-day TimelockController, with a separate 3-day TimelockController for poster onboarding (see [Deployment Architecture](#deployment-architecture)).

## Deployment Architecture

Five contracts are deployed per chain, all via CREATE2 with constant salts so addresses are identical across chains. **Canonical v1.2.0 proxy: `0xBfaEEE9662b4c037De24e5Caa65815350d57b89A`** — live on Ethereum, Base, Arbitrum One, Optimism since 2026-05-07.

1. **Implementation** (`ThatsRekt.sol`) — the logic contract. Held privately behind the proxy; integrators never call it directly. Salt is versioned per impl release. Current: `thatsRekt.impl.v1.2.0`. A new implementation gets a new address; the proxy `delegatecall`s into whichever impl is wired in via `upgradeToAndCall`.
2. **Upgrade TimelockController** (OpenZeppelin) — owns the proxy and gates every upgrade and every owner-level role rotation. **7-day delay**. Multisig as proposer; bauti.eth as canceller (cross-canceller invariant — proposer ≠ canceller, so a compromise of one principal cannot push *and* hide an op). Executor list permissive (`[multisig, address(0)]`). Salt: `thatsRekt.upgradeTimelock.v3`.
3. **Add TimelockController** (OpenZeppelin) — holds the `whitelistAdmin` slot. **3-day delay**; same role split as the upgrade TLC. Used to onboard new posters and to rotate the admin role itself. Salt: `thatsRekt.addTimelock.v3`.
4. **Purge TimelockController** (OpenZeppelin) — holds the `purgeAdmin` slot. **1-day delay**. bauti.eth as proposer, multisig as canceller (cross-canceller, opposite role split from upgrade/add TLCs). Used for governance-driven content purges (`purgePost`). Salt: `thatsRekt.purgeTimelock.v3`.
5. **ERC1967Proxy** — the canonical permanent address, what integrators bake in. Owned by the upgrade TimelockController; `whitelistAdmin` = add TLC; `whitelistRemover` = bauti.eth; `purgeAdmin` = purge TLC; `purgeRemover` = bauti.eth. Salt is versioned (current: `thatsRekt.proxy.v3`) — bumping it on a fresh deploy intentionally produces a NEW canonical address with no state carryover from prior versions.

The multisig has no direct upgrade authority. Every upgrade follows the standard OZ TimelockController flow: propose with `schedule(...)`, wait 7 days, then `execute(...)` with the same args. Pseudocode:

```solidity
bytes memory call = abi.encodeCall(ThatsRekt.upgradeToAndCall, (newImpl, ""));
upgradeTimelock.schedule(proxy, 0, call, bytes32(0), salt, 7 days);
// ... wait 7 days ...
upgradeTimelock.execute(proxy, 0, call, bytes32(0), salt);
```

Adding a new poster goes through the parallel 3-day flow on the add timelock:

```solidity
bytes memory call = abi.encodeCall(ThatsRekt.addWhitelisted, (newPoster));
addTimelock.schedule(proxy, 0, call, bytes32(0), salt, 3 days);
// ... wait 3 days ...
addTimelock.execute(proxy, 0, call, bytes32(0), salt);
```

To skip the 3-day wait at launch (so the registry boots with operational posters), pass an `INITIAL_WHITELISTERS` list to `Deploy.s.sol`; it's the only legitimate bypass and only happens once during the proxy's `initialize`.

### Trust model

Integrators trust the multisig — and the 7-day delay — for upgrade authority. The honest-case guarantee is that **a malicious upgrade cannot land in less than 7 days**. Even with multisig keys compromised, integrators have a full week to disengage, monitor, and migrate before a hostile implementation is in force. The multisig can call `proxy.renounceOwnership()` via the upgrade timelock when the design stabilizes, which permanently freezes upgrades and reduces the contract back to the immutable model of v0.

Adding posters takes 3 days — long enough for integrators to react if the multisig schedules a hostile operator, short enough that real-world onboarding doesn't grind to a halt. **Removing posters is instant**, called directly by the multisig via the `whitelistRemover` slot. The asymmetry is the whole point: rotating *in* a new operator should be public and slow; kicking *out* a misbehaving one should be incident-response fast.

The multisig also holds an instant kill-switch on the add timelock itself: `revokeWhitelistAdmin()` zeros the `whitelistAdmin` slot, blocking all new additions until the upgrade-timelock owner re-installs an admin via the 7-day path. This buys breathing room if the add timelock is captured, then forces public re-installation.

## Architecture

Three-role governance with asymmetric delays:

- **Owner** (the upgrade `TimelockController`, set on the proxy at `initialize`) — holds upgrade authority (`upgradeToAndCall`) and the 7-day re-install path for the whitelistAdmin slot, plus 7-day rotation of the whitelistRemover slot. Owner is fully rotatable via the inherited `Ownable2StepUpgradeable` two-step.
- **Whitelist admin** (the add `TimelockController`, set at `initialize` and self-rotatable via the 3-day path or owner-rotatable via the 7-day path) — calls `addWhitelisted` (3-day delay in production) and `setWhitelistAdmin` (3-day delay) to install a new operator.
- **Whitelist remover** (the multisig directly, set at `initialize` and rotatable only via owner) — calls `removeWhitelisted` (instant) and `revokeWhitelistAdmin` (instant kill-switch on the admin slot). No delay; this is the incident-response role.
- **Whitelisted addresses** — can post alerts, vote up/down on others' alerts, retract / amend / extend their own posts. Cannot vote on own posts.
- **Anyone** — can read posts, attacker scores, victim flags, voter sets, and the active-post linked list.

Posts contain: `address[] attackers`, `address[] victims`, `string note`, `uint64 attackedAt`. At least one address array or the note must be non-empty. Up to **100 addresses total per post** (cap applies to `attackers.length + victims.length`). Notes live in `PostCreated` / `PostNoteAmended` events, never in storage.

`attackedAt` is poster-supplied: the UTC second timestamp of the on-chain attack itself (e.g. the malicious tx's block timestamp), validated as `> 0` and `<= block.timestamp`. Operator detection time is implicit in the post tx's block timestamp, so it is not stored separately. Each post also tracks an on-chain `lastUpdatedAt` (set at creation, bumped on `amendNote` / `addAttackers` / `addVictims`) so consumers can surface "recently edited" posts without scanning logs.

## Public reads (for integrators)

```solidity
function attackerScore(address) external view returns (int256);     // signed: pick your threshold
function attackerAppearances(address) external view returns (uint256);
function isVictim(address) external view returns (bool);
function attackerReport(address) external view returns (int256 score, uint256 appearances);
```

A DEX router can `require(reg.attackerScore(user) <= 0)` before allowing a swap. A stablecoin issuer might require `attackerScore <= -2` (must have been actively refuted). The threshold is the integrator's choice; the registry is just data.

## Posting + voting

```solidity
enum VoteDirection { None, Upvote, Downvote }

function post(
    address[] calldata attackers,
    address[] calldata victims,
    string   calldata note,
    uint64            attackedAt
) external returns (uint256 id);

function vote(uint256 postId, VoteDirection direction) external;    // None is rejected — use unvote()
function unvote(uint256 postId) external;                           // clears caller's vote on the post
function retract(uint256 postId) external;                          // poster only
```

`vote()` takes the `VoteDirection` enum (`Upvote` = +1, `Downvote` = -1; `None` is rejected — clearing back to "no vote" lives on `unvote()`). The poster cannot vote on their own post. Same direction twice in a row reverts (`NoVoteChange`). `unvote()` reverts if the caller never voted (`NoVoteToRetract`).

## Editing posts (poster only)

Posts are amend-only — addresses can be appended but never removed (anti bait-and-switch). Posters who need to drop an address must `retract()` and re-post.

```solidity
function amendNote(uint256 postId, string calldata newNote) external;          // event-only; bumps lastUpdatedAt
function addAttackers(uint256 postId, address[] calldata newAttackers) external;
function addVictims(uint256 postId, address[] calldata newVictims) external;
```

Notes live entirely in events (originally `PostCreated`, then `PostNoteAmended`); the on-chain side effect of `amendNote` is just bumping `lastUpdatedAt`. `addAttackers` / `addVictims` enforce strict no-duplicates within the input batch and across the post's existing attacker + victim arrays, reject `address(0)`, and respect the 100-address total cap. Newly added attackers inherit the post's *current* net karma (`upvotes - downvotes`) at the moment of addition.

## Removal

The only path to removal is the poster calling `retract(id)`. Removal reverses all aggregate contributions (attacker scores, attacker appearances, victim flags) and unlinks the post from the active-post list. Posts cannot be un-removed. There is no automatic threshold-based removal — peer downvotes lower the post's score (and any listed attackers' scores) but do not delete the post.

## On-chain feed enumeration

```solidity
function recentActivePosts(uint256 limit) external view returns (uint256[]);   // newest first
function activePostsBefore(uint256 beforeId, uint256 limit) external view returns (uint256[]);
```

Walks a doubly-linked list of non-removed posts. `MAX_VIEW_LIMIT = 100` per call. For richer queries (full-text search on notes, per-attacker post lists), consume `PostCreated` / `PostNoteAmended` / `AttackersAdded` / `VictimsAdded` / `Voted` / `PostRemoved` events via an off-chain indexer.

## Voter set views

Each post tracks its upvoter and downvoter sets on-chain (OZ `EnumerableSet`), enabling integrators to gate on a trusted subset of whitelisters rather than just the raw aggregate score:

```solidity
function getUpvoters(uint256 postId)     external view returns (address[]);
function getDownvoters(uint256 postId)   external view returns (address[]);
function getUpvoterCount(uint256 postId) external view returns (uint256);
function getDownvoterCount(uint256 postId) external view returns (uint256);
```

Cardinalities are kept in lockstep with the per-post `upvotes` / `downvotes` counters as an invariant. The full-set views are unbounded by design — caller picks the gas budget at the eth_call layer; paginate at the consumer level for very large voter sets.

## Cross-chain deploy

All three contracts (impl, timelock, proxy) are deployed at the same address on every supported EVM chain using the CREATE2 deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. Each chain has its own sovereign state — own whitelist, own posts, own karma. Cross-chain aggregation is an off-chain concern.

Cross-chain identical addresses require identical init code on every chain. Concretely: the proxy's init code embeds the impl address and the `initialize(upgradeTimelock, addTimelock, multisig, initialWhitelisters[])` calldata, and each timelock's init code embeds the multisig address as proposer / executor / canceller. So the multisig must live at the same address on every chain (typically deployed via the Safe Singleton Factory) — pass the same multisig and the same `INITIAL_WHITELISTERS` everywhere, and the impl, both timelocks, and the proxy each land at one canonical cross-chain address.

### Canonical initial whitelisters

Use the SAME `INITIAL_WHITELISTERS` set on every chain so the canonical proxy address resolves identically. Current launch set (also intended for any re-deploy of an existing chain):

| Address | Owner / role |
|---|---|
| `0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4` | thatsRekt cold wallet (also the `whitelistRemover`) |
| `0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45` | bauti.eth |
| `0x9E8680dbBcA1127add812abE209A10E621b385dF` | jerrythekid.eth |
| `0x24C2167054A9A9e00F67233F1eBc4060501f54FA` | aux operator EOA |
| `0xE0396d6d738e726D39f96099b8f6a55d11184374` | jerrythekid.eth's relayer bot — automated detector that submits alerts on Jerry's behalf |
| `0xb5A6c8ca369e38050784e2A6793beE6447109340` | DAMM hot wallet — deployer EOA, also pre-whitelisted so the operator can submit posts directly without scheduling an `addWhitelisted` tx through the 3-day timelock |

When you add a new chain, set `INITIAL_WHITELISTERS` to all six addresses joined by commas. **Adding a chain with a different set produces a different proxy address** (CREATE2 hashes the full init calldata).

## Build / test / deploy

```bash
forge build
forge test -vv
forge test --match-contract ThatsRektInvariants -vv
```

### Production deploy (mainnet) — `Deploy.s.sol`

```bash
# Required env:
#   GOVERNANCE_OWNER     — Safe multisig (must have code on the target chain).
#                          Becomes proposer/executor on the 7-day upgrade TLC.
#   WHITELIST_OPERATOR   — cold wallet (EOA or contract).
#                          Becomes proposer/executor on the 3-day add TLC AND
#                          holds the whitelistRemover slot.
# Optional:
#   INITIAL_WHITELISTERS — comma-separated address list, pre-populated into
#                          the whitelist at init (bypasses the 3-day delay).
GOVERNANCE_OWNER=0x...<safe>... \
WHITELIST_OPERATOR=0x...<cold-wallet>... \
INITIAL_WHITELISTERS=0xabc...,0xdef...,0x123... \
forge script script/Deploy.s.sol \
    --rpc-url <chain-rpc> \
    --broadcast \
    --verify \
    -vvvv
```

### Dev / testnet deploy — `DeployDev.s.sol`

For local Anvil and testnet (Sepolia) where standing up a Safe is friction. Accepts an EOA as `GOVERNANCE_OWNER` and uses **distinct CREATE2 salts** (`thatsRekt.impl.dev.v1.0.0`, `thatsRekt.upgradeTimelock.dev.v1`, `thatsRekt.addTimelock.dev.v1`, `thatsRekt.proxy.dev`) so dev deploys can never collide with production addresses.

The recommended dev EOA is **Anvil default account 0** (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, mnemonic: `test test test test test test test test test test test junk`). Reproducible across machines, no secret to manage. Same EOA on Anvil + Sepolia ⇒ **identical thatsRekt address on both** — convenient for parity testing. **Never use this on mainnet.**

```bash
# Sepolia deploy
ANVIL_DEFAULT_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/DeployDev.s.sol \
    --rpc-url https://lb.routeme.sh/rpc/11155111/<routeme-key> \
    --private-key $ANVIL_DEFAULT_KEY \
    --broadcast \
    --verify \
    -vvvv \
    --sig 'run()' \
    --slow              # space txs for testnet RPC stability
GOVERNANCE_OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

(Set `GOVERNANCE_OWNER` in env before invoking, or use `--sig 'deploy(address)' 0xf39Fd6...` to bypass env reading entirely.)

**Output:** the script logs the deployed proxy address and current block number. Copy them into `indexer/.env` as `CONTRACT_SEPOLIA` / `START_BLOCK_SEPOLIA` (or the equivalent for whichever chain).

The dev deploy uses the same flows as production (proxy owned by upgrade TLC at 7 days; whitelistAdmin held by add TLC at 3 days). To exercise upgrades or add-timelock flows on Anvil, advance time with `evm_increaseTime` rather than shortening the delays — keeps testnet behavior matching mainnet.

## Spec + design history

- Implementation plan: `tasks/v0-impl-plan.md` (this branch)
- Predecessor (flat-set `addRekt(address[])` with 2-of-N propose/execute removal): see `git log master`. The current design replaces it wholesale.
