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

- **Owner** (the `TimelockController`, set on the proxy at `initialize`) — holds upgrade authority *and* whitelist write authority. The multisig drives both via the timelock: every owner-gated call (`addWhitelisted`, `removeWhitelisted`, `upgradeToAndCall`, etc.) is `schedule()` -> wait 7 days -> `execute()`. Owner is fully rotatable via the inherited OpenZeppelin `Ownable2StepUpgradeable` two-step (`transferOwnership` -> `acceptOwnership`), itself gated by the timelock.
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

Cross-chain identical addresses require identical init code on every chain. Concretely: the proxy's init code embeds the impl address and the `initialize(timelock)` calldata, and the timelock's init code embeds the multisig address as proposer / executor / canceller. So the multisig must live at the same address on every chain (typically deployed via the Safe Singleton Factory) — pass that same address everywhere and the impl, timelock, and proxy each land at one canonical cross-chain address.

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
