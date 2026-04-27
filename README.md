# thatsRekt

A public-good on-chain registry of in-progress and confirmed DeFi exploits.

Whitelisted operators (typically Twitter-monitor bots watching threat-intel firms like SlowMist, BlockSec, PeckShield) post structured alerts naming attacker addresses, victim contracts, and free-form context. Other whitelisters race to vouch (upvote) or refute (downvote). Aggregates are exposed as O(1) reads so any contract — DEX router, wallet, stablecoin issuer, risk dashboard — can plug in and inline-blacklist live attacker addresses.

Designed as a public good: no economic admin power. Cross-chain identical-address deploy via the singleton CREATE2 factory. Logic is upgradeable behind a UUPS proxy gated by a 7-day TimelockController (see [Deployment Architecture](#deployment-architecture)).

## Deployment Architecture

Three contracts are deployed per chain, all via CREATE2 with constant salts so the addresses are identical on every chain:

1. **Implementation** (`ThatsRekt.sol`) — the logic contract. Held privately behind the proxy; integrators never call it directly. Salt is versioned per impl release (`thatsRekt.impl.v1.0.0`), so a new implementation gets a new address while the proxy stays put.
2. **TimelockController** (OpenZeppelin) — gates every upgrade. Configured at deploy time with a **7-day delay**, the multisig as proposer + executor + canceller, and `admin = address(0)` so role changes can only happen via a timelocked proposal. Salt is versioned (`thatsRekt.timelock.v1`); only changes if the timelock contract itself is replaced.
3. **ERC1967Proxy** — the canonical permanent address, what integrators bake in. Owned by the TimelockController. Salt is **not** versioned (`thatsRekt.proxy`) — this address must never change.

The multisig has no direct upgrade authority. Every upgrade follows the OZ TimelockController flow: propose with `schedule(...)`, wait 7 days, then `execute(...)` with the same args. Pseudocode:

```solidity
bytes memory call = abi.encodeCall(ThatsRekt.upgradeToAndCall, (newImpl, ""));
timelock.schedule(proxy, 0, call, bytes32(0), salt, 7 days);
// ... wait 7 days ...
timelock.execute(proxy, 0, call, bytes32(0), salt);
```

### Trust model

Integrators trust the multisig — and the 7-day delay — for upgrade authority. The honest-case guarantee is that **a malicious upgrade cannot land in less than 7 days**: even with multisig keys compromised, integrators have a full week to disengage, monitor, and migrate before a hostile implementation is in force. The multisig can also call `proxy.renounceOwnership()` via the timelock when the design stabilizes, which permanently freezes upgrades and reduces the contract back to the immutable model of v0.

## Architecture

- **Owner** (Safe multisig, set at deploy time via constructor) — only role with whitelist write authority. Fully rotatable via OpenZeppelin `Ownable2Step` (two-step `transferOwnership` -> `acceptOwnership`), so governance keys can be rotated as needed.
- **Whitelisted addresses** — can post alerts and vote up/down on others' alerts. Cannot vote on own posts.
- **Anyone** — can read posts, attacker scores, victim flags, and the active-post linked list.

Posts contain: `address[] attackers`, `address[] victims`, `string note`. At least one must be non-empty. Up to 32 addresses total per post. Notes live in `PostCreated` events, never in storage.

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
function post(address[] attackers, address[] victims, string note) external returns (uint256 id);
function vote(uint256 postId, int8 direction) external;             // direction in {-1, 0, +1}; 0 = retract
function retract(uint256 postId) external;                          // poster only
```

`vote()` accepts `+1` (upvote), `-1` (downvote), or `0` (retract previous vote). The poster cannot vote on their own post. Same direction twice in a row reverts (`NoVoteChange`).

## Removal

A post is removed automatically when `downvotes - upvotes >= 3`, or by the poster calling `retract(id)`. Removal reverses all aggregate contributions and unlinks from the active-post list. Posts cannot be un-removed.

## On-chain feed enumeration

```solidity
function recentActivePosts(uint256 limit) external view returns (uint256[]);   // newest first
function activePostsBefore(uint256 beforeId, uint256 limit) external view returns (uint256[]);
```

Walks a doubly-linked list of non-removed posts. `MAX_VIEW_LIMIT = 100` per call. For richer queries (full-text search on notes, per-attacker post lists), consume `PostCreated` / `Voted` / `PostRemoved` events via an off-chain indexer.

## Cross-chain deploy

The contract is deployed at the same address on every supported EVM chain using the CREATE2 deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C`. Each chain has its own sovereign state — own whitelist, own posts, own karma. Cross-chain aggregation is an off-chain concern.

The governance owner is a constructor argument — pass the SAME owner address on every chain to get the SAME deployed address everywhere (the constructor arg is encoded into init code, so identical args + identical salt + identical factory = identical address). Typically that owner is a Safe multisig also deployed at the same address on every chain via the Safe Singleton Factory.

## Build / test / deploy

```bash
forge build
forge test -vv
forge test --match-contract ThatsRektInvariants -vv

# Deploy: pass the initial owner via the GOVERNANCE_OWNER env var.
cp .env.example .env  # fill in PRIVATE_KEY, RPC_URL, ETHERSCAN_API_KEY, GOVERNANCE_OWNER
GOVERNANCE_OWNER=0x...   forge script script/Deploy.s.sol \
    --rpc-url <chain-rpc> \
    --broadcast \
    --verify \
    -vvvv
```

## Spec + design history

- Implementation plan: `tasks/v0-impl-plan.md` (this branch)
- Canonical design spec: DAMM Capital knowledge base (`threads/bauti/thatsrekt.md`)
- Predecessor (flat-set `addRekt(address[])` with 2-of-N propose/execute removal): see `git log master`. The current design replaces it wholesale.
