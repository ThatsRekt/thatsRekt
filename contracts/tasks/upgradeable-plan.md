# thatsRekt — Upgradeable Proxy Implementation Plan

**Date:** 2026-04-27
**Status:** APPROVED — all 5 major decisions locked. One micro-question (timelock delay value) outstanding.
**Owner:** bauti

## 1. Decision Summary

| Choice | Pick | Rationale |
|--------|------|-----------|
| **Proxy pattern** | **UUPS (EIP-1822) via OZ** | Cheaper runtime than Transparent Proxy, modern industry standard. OZ provides `UUPSUpgradeable` + `Initializable`. No hand-rolled proxy code. |
| **Storage layout** | **Sequential + `uint256[50] __gap`** | Simpler than ERC-7201 namespaced storage. OZ Upgradeable's own contracts use ERC-7201 internally (won't collide with our slot 0+ layout). Our state is shallow — gap-based is enough. |
| **Owner / Initializable** | **`Ownable2StepUpgradeable`** | Direct counterpart to current `Ownable2Step`. Two-step transfer prevents fat-fingering. |
| **Cross-chain** | **CREATE2 for impl + CREATE2 for proxy** | Both addresses deterministic. Proxy is the user-facing canonical address. |
| **Timelock** | **OZ `TimelockController` from v1.0.0 (DECIDED 2026-04-27)** | All upgrades go through timelock. Multisig proposes → N-day delay → multisig executes. Conservative initial trust model. |
| **Ownership renunciation** | **Available as escape hatch** | Multisig can call `renounceOwnership()` to permanently freeze upgrades when design stabilizes. Optional, not mandatory. |

## 2. Trust Model Implications

**Reverses v0's design intent.** v0 was explicitly immutable: "integrators audit once, trust forever." Going upgradeable means:

- Multisig owner can swap the implementation contract → can change any contract behavior.
- Compromise of multisig keys = compromise of the entire registry.
- Integrators must trust the multisig in perpetuity (or until ownership renounced).

### Mitigations

| Mitigation | When | Effort |
|------------|------|--------|
| **Strong multisig hygiene** | Day 1 | Operational (hardware keys, geographic dispersion, large signer set) |
| **TimelockController** | v1.0.0 or v1.1.0 | Adds 7-14 day delay between propose and execute. Gives integrators time to react. |
| **Public upgrade announcements** | Day 1 | Off-chain process — every upgrade announced before timelock starts (Twitter, Discord, registry channel) |
| **Cross-chain upgrade discipline** | Per-upgrade | Same impl bytecode + same multisig signers across all chains. Operationally enforced. |
| **Renounce ownership when stable** | When confident | Multisig calls `renounceOwnership()` → permanent immutability. |

## 3. File-Level Changes

### Dependencies

Add to `lib/`:
```bash
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-commit
```

Pin version to match `openzeppelin-contracts` (v5.6.1).

Update `foundry.toml` remappings:
```toml
remappings = [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
]
```

### `src/ThatsRekt.sol`

**Inheritance change:**

```solidity
// before:
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
contract ThatsRekt is Ownable2Step { ... }

// after:
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract ThatsRekt is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable {
    // ...existing storage...
    uint256[50] private __gap;  // reserve future slots
}
```

**Replace constructor with initializer:**

```solidity
// before:
constructor(address initialOwner) Ownable(initialOwner) {}

// after:
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}

function initialize(address initialOwner) external initializer {
    __Ownable_init(initialOwner);
    __Ownable2Step_init();
    __UUPSUpgradeable_init();
}
```

**Add upgrade authorization hook:**

```solidity
function _authorizeUpgrade(address /* newImpl */) internal override onlyOwner {}
```

**No other logic changes.** The existing post / vote / unvote / amend functions stay byte-identical aside from inheriting from the upgradeable variants.

### `script/Deploy.s.sol`

**Replace existing deploy with impl + timelock + proxy flow** (all three deployed via CREATE2 for cross-chain identical addresses):

```solidity
contract Deploy is Script {
    bytes32 public constant IMPL_SALT      = keccak256("thatsRekt.impl.v1.0.0");
    bytes32 public constant TIMELOCK_SALT  = keccak256("thatsRekt.timelock.v1");
    bytes32 public constant PROXY_SALT     = keccak256("thatsRekt.proxy");

    uint256 public constant TIMELOCK_DELAY = 7 days;  // OPEN QUESTION — operator confirms

    function run() external {
        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        require(multisig != address(0), "GOVERNANCE_OWNER zero");
        require(multisig.code.length > 0, "GOVERNANCE_OWNER no code (must be Safe)");

        // === 1. Deploy implementation (deterministic, no constructor args) ===
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl");

        // === 2. Deploy TimelockController with multisig as proposer + executor + canceller ===
        // admin = address(0) means no DEFAULT_ADMIN_ROLE holder beyond the contract itself;
        // role changes can only happen via a timelocked proposal. Standard secure config.
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;

        bytes memory tlInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(TIMELOCK_DELAY, proposers, executors, address(0))
        );
        address timelock = _create2(TIMELOCK_SALT, tlInitCode, "timelock");

        // === 3. Deploy ERC1967Proxy. Owner = timelock (NOT the multisig directly). ===
        bytes memory initCalldata = abi.encodeCall(ThatsRekt.initialize, (timelock));
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy");

        console2.log("Implementation:    ", impl);
        console2.log("TimelockController:", timelock);
        console2.log("Proxy:             ", proxy);
        console2.log("Multisig:          ", multisig);
        console2.log("Timelock delay:    ", TIMELOCK_DELAY);
    }

    function _create2(bytes32 salt, bytes memory initCode, string memory label) internal returns (address) {
        bytes32 initHash = keccak256(initCode);
        address predicted = computeCreate2Address(salt, initHash, CREATE2_FACTORY);
        if (predicted.code.length > 0) {
            console2.log(string.concat(label, " already deployed:"), predicted);
            return predicted;
        }
        vm.startBroadcast();
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        require(ok, string.concat(label, " deploy failed"));
        vm.stopBroadcast();
        require(predicted.code.length > 0, string.concat(label, " not deployed"));
        return predicted;
    }
}
```

**Cross-chain identical address mechanics:**
- Impl bytecode is deterministic → same CREATE2 address on every chain.
- Proxy init code includes impl address (in constructor args). Since impl address is the same on every chain, proxy init code is the same → same proxy CREATE2 address.
- Multisig address must be the same on every chain (Safe Singleton Factory deployed first).

### `test/ThatsRekt.t.sol` + `test/handlers/ThatsRektHandler.sol` + `test/ThatsRektInvariants.t.sol`

**Setup change:** every `setUp()` that instantiates `ThatsRekt` must instead deploy impl + proxy:

```solidity
function setUp() public virtual {
    ThatsRekt impl = new ThatsRekt();
    bytes memory initCalldata = abi.encodeCall(ThatsRekt.initialize, (governance));
    ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
    reg = ThatsRekt(address(proxy));
}
```

All existing test logic stays — the proxy's address acts as the contract's address, and delegate calls forward to the impl's logic transparently.

**New tests to add:**
- `test_initialize_setsOwner` — initialize sets owner correctly.
- `test_initialize_revertsOnSecondCall` — re-init blocked by `Initializable`.
- `test_implementation_initializeIsDisabled` — calling `initialize` directly on the impl (not via proxy) reverts.
- `test_upgradeTo_onlyOwnerCanCall` — non-owner attempt reverts.
- `test_upgradeTo_swapsImplementation` — deploy a `ThatsRektV1_1Mock` with one extra function, upgrade, verify new function callable + old state preserved.
- `test_storageGap_reservedSlotsExist` — `forge inspect ThatsRekt storage-layout` should show `__gap[50]` at end.

### `README.md`

Add section: "Deployment Architecture" explaining the proxy + impl model, the upgrade authorization, and the trust model.

## 4. Storage Layout Audit

The current `ThatsRekt` storage (post-v1-edits merge) is roughly:

| Slot | Field |
|------|-------|
| 0 | `mapping(address => bool) isWhitelisted` |
| 1 | `uint256 postCount` |
| 2 | `mapping(uint256 => Post) _posts` |
| 3 | `mapping(uint256 => mapping(address => VoteDirection)) voteOf` |
| 4 | `mapping(address => int256) attackerScore` |
| 5 | `mapping(address => uint256) attackerAppearances` |
| 6 | `mapping(address => uint256) _victimActivePosts` |
| 7 | `uint256 headPostId` |
| 8 | `uint256 tailPostId` |
| 9 | `mapping(uint256 => uint256) nextPostId` |
| 10 | `mapping(uint256 => uint256) prevPostId` |
| 11 | `mapping(uint256 => EnumerableSet.AddressSet) _upvoters` |
| 12 | `mapping(uint256 => EnumerableSet.AddressSet) _downvoters` |
| 13-62 | `uint256[50] __gap` (reserved) |

(Verify exact slots with `forge inspect ThatsRekt storage-layout` after refactor.)

OZ's upgradeable inherited contracts (`Ownable2StepUpgradeable`, `UUPSUpgradeable`) use **namespaced storage (ERC-7201)** internally — their state lives at fixed precomputed slots far from our sequential layout. Zero collision risk.

## 5. Test Strategy

| Phase | Goal |
|-------|------|
| **All existing tests pass through the proxy** | Behavioral parity — every existing test that exercised v1 logic continues to pass when called via proxy. |
| **Initialization correctness** | Initialize once, blocked thereafter, impl is uninitializable. |
| **Upgrade authorization** | Only owner can upgrade; non-owners revert. |
| **Upgrade flow** | Mock v1.1 impl, upgrade, state preserved, new function callable. |
| **Storage layout** | Gap reserved; layout matches expectations via `forge inspect`. |
| **Invariants pass through proxy** | Existing fuzz invariants exercise the proxied contract. |

## 6. Rollout Phases

### Phase 1 — Refactor contract (3h)
- Add OZ Upgradeable lib.
- Convert ThatsRekt to upgradeable inheritance.
- Replace constructor with initialize.
- Add `_authorizeUpgrade` and `__gap`.
- Update existing tests to deploy via proxy in setUp.
- All existing tests must pass.

### Phase 2 — New deploy script (1.5h)
- Rewrite `Deploy.s.sol` for **impl + timelock + proxy** CREATE2 flow.
- Verify all three addresses are deterministic across chains.
- Confirm timelock receives proposer/executor/canceller roles for the multisig + `admin = address(0)`.

### Phase 3 — Upgrade-flow tests (2h)
- Mock v1.1 impl with one extra function.
- Test upgrade authorization.
- Test state preservation across upgrade.
- Test impl direct-call protection.

### Phase 4 — Documentation (30min)
- Update README with proxy deployment flow + trust model section.
- Update `tasks/v0-impl-plan.md` (or create new `v1-upgradeable-plan.md`) with execution record.

### Phase 5 — PR + review (operator)
- Single PR: `feat(v1): convert to UUPS upgradeable proxy`.
- Operator reviews and merges.

**Total estimated effort:** ~6.5 hours of subagent work.

## 7. Decisions (locked 2026-04-27)

1. **Timelock: include from v1.0.0.** All upgrades route through OZ `TimelockController`. Multisig holds proposer + executor + canceller roles. Admin = `address(0)` (secure default — role changes only via timelocked proposals).
2. **Storage gap size: 50.** (OZ convention.)
3. **Salt scheme:**
   - `IMPL_SALT = keccak256("thatsRekt.impl.v1.0.0")` — versioned per impl deploy.
   - `TIMELOCK_SALT = keccak256("thatsRekt.timelock.v1")` — versioned per timelock deploy (rare; only if we ever change the timelock contract).
   - `PROXY_SALT = keccak256("thatsRekt.proxy")` — **NO version**, the proxy is the canonical permanent address that never changes.
4. **Renunciation: no public commitment.** Multisig can renounce later if it wants to; not pre-committing.
5. **Storage layout: sequential + `__gap[50]`.** No ERC-7201 namespacing for our state (OZ inherited contracts use it internally; no collision).

## 7a. Outstanding micro-question

**Timelock delay value.** 7 days is my recommended default (industry standard for major DeFi protocols — Uniswap, Aave, Compound use 2-7 day windows). Tradeoffs:

| Delay | Pros | Cons |
|-------|------|------|
| **48 hours** | Fast iteration, fast bug fixes | Too short for integrators to react / audit a proposed impl |
| **7 days** | Goldilocks: integrator response window + reasonable bug-fix latency | — |
| **14 days** | Maximum integrator confidence | Painful for time-sensitive bug fixes |

**My recommendation: 7 days.** Note: timelock delay is itself adjustable via a timelocked proposal — start at 7 days, adjust either direction later if needed.

## 8. Risks / Things to Watch

- **Storage layout drift across upgrades.** Any upgrade that reorders or changes existing storage slots corrupts state. Mitigation: every upgrade must run `forge inspect` and diff against deployed layout. Consider OZ Upgrades plugin in CI for automated checks.
- **Re-init via inheritance.** If new state is added via a new inherited base contract in an upgrade, `initialize()` may need a new corresponding `reinitializer(N)` function with version N. OZ documents this pattern.
- **Cross-chain upgrade divergence.** Without operational discipline, chain A and chain B could end up at different impl versions. Mitigation: deploy new impl via CREATE2 with constant salt → identical address on every chain → multisig's upgrade tx is identical on every chain.
- **Multisig key compromise.** Catastrophic if it happens. Mitigation: standard multisig hygiene (hardware keys, signers in multiple jurisdictions, regular key rotation drills, low-quorum-impractical signing thresholds).

## 9. Out of Scope (for this plan)

- Timelock implementation (deferred to potential v1.1.0).
- Renunciation execution (one-time future op, not part of v1.0.0).
- Upgrade tooling beyond Forge (no OZ Defender, no Sphinx).
- Subgraph / IPFS site (separate workstream — Idea 4).

## 10. Approval

This plan needs operator sign-off on the open questions before implementation begins. Ideal sign-off:

- [ ] Timelock decision (defer to v1.1.0 / include in v1.0.0)
- [ ] Storage gap size (50 / 100)
- [ ] Salt scheme (confirmed / different)
- [ ] Renunciation public commitment (no / yes with date)
- [ ] Storage namespacing (sequential+gap / ERC-7201)

Once signed off, single PR via subagent on a `bauti/v1-upgradeable` worktree.
