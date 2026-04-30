# Whitelist add timelock + role split — design spec

**Status:** approved 2026-04-30 (operator confirmed model in ThatsRekt brainstorm thread).

## Problem

Two-tier governance (the v1 design) couples poster onboarding and incident
response to the same role. The multisig holds `whitelistAdmin` directly, which
gives it instant `addWhitelisted` and instant `removeWhitelisted`. That works
for incident response (kicking a misbehaving poster fast), but it leaves zero
public window before a hostile or compromised multisig can install a malicious
operator. Three-day notice on additions is the missing safety property.

The fix is to separate "add a poster" from "remove a poster" into two roles
with different delays, and give the owner an instant kill-switch on the add
path so a captured TLC can be neutralized without waiting 7 days.

## Roles + delays

| Role | Slot | Production binding | Action(s) | Delay |
|---|---|---|---|---|
| Owner | `Ownable.owner()` | `TimelockController(7d)` | `_authorizeUpgrade`, `setWhitelistRemover`, `setWhitelistAdmin` (re-install path) | 7 days |
| Whitelist admin | `whitelistAdmin` | `TimelockController(3d)` | `addWhitelisted`, `setWhitelistAdmin` (self-rotate) | 3 days |
| Whitelist remover | `whitelistRemover` | multisig (direct) | `removeWhitelisted`, `revokeWhitelistAdmin` | instant |

Both timelocks have the multisig as proposer + executor + canceller; admin is
`address(0)` so role changes inside the timelocks themselves only happen via a
timelocked proposal.

## Function table

| Function | Caller | Behavior |
|---|---|---|
| `initialize(owner, wlAdmin, wlRemover, initialWhitelisters[])` | proxy ctor | Sets all three slots; rejects zero on admin/remover (owner zero is rejected by `OwnableUpgradeable`); pre-populates posters from the array, bypassing the 3-day delay (the only legitimate bypass — only happens once at deploy). Duplicates in the array are silently idempotent; `address(0)` in the array reverts. |
| `_authorizeUpgrade(impl)` | `onlyOwner` | UUPS upgrade gate. 7d. |
| `setWhitelistAdmin(addr)` | `owner` OR `whitelistAdmin` | Rotates the admin slot. Rejects zero (use `revokeWhitelistAdmin` for that). 3d via self-rotate, 7d via owner (re-install path after revoke). |
| `setWhitelistRemover(addr)` | `onlyOwner` | Rotates the remover slot. Rejects zero. 7d. |
| `revokeWhitelistAdmin()` | `onlyWhitelistRemover` | Sets `whitelistAdmin = address(0)` instantly. Blocks all subsequent `addWhitelisted` calls until owner re-installs through the 7-day path. |
| `addWhitelisted(addr)` | `onlyWhitelistAdmin` | Adds a poster. 3d in prod. Idempotent on already-listed. |
| `removeWhitelisted(addr)` | `onlyWhitelistRemover` | Removes a poster. Instant in prod. Idempotent on non-listed. |

## Storage

| Slot | Var | Notes |
|---|---|---|
| 0 | `isWhitelisted` (mapping) | unchanged |
| 1 | `whitelistAdmin` (address) | unchanged |
| 2 | `whitelistRemover` (address) | **new in v1.2** |
| 3+ | (rest of v1.1 layout, shifted by 1) | |
| ... | `postTitle` (mapping, v1.1) | |
| 17–64 | `__gap[48]` | shrunk from `[49]` to absorb `whitelistRemover` |

This is a greenfield deploy — nothing's been deployed to mainnet, so the
mid-list insertion of `whitelistRemover` is fine. If a deployed instance
existed, this would be an upgrade-incompatible storage change and would
need to be appended after `postTitle` instead.

## Events + errors

New event:

```solidity
event WhitelistRemoverTransferred(address indexed previousRemover, address indexed newRemover);
```

New errors:

```solidity
error NotWhitelistRemover();
error Unauthorized();
```

`WhitelistAdminTransferred` already existed and is reused for both rotation
and revoke (revoke emits `Transferred(prev, address(0))` so indexers can
distinguish revoke from rotation by inspecting the second indexed topic).

## Security analysis

| Attack | Defense |
|---|---|
| Multisig keys compromised → hostile poster | Add takes 3 days. Integrators see the scheduled op and disengage. |
| Multisig keys compromised → hostile upgrade | Upgrade takes 7 days. |
| 3-day TLC captured (unlikely but modeled) | Multisig (remover) calls `revokeWhitelistAdmin()` instantly. Adds are bricked. Owner re-installs on 7-day path. Worst-case integrator window: 7 days. |
| Multisig (remover) loses key | Remover slot rotation goes through 7-day owner path. No instant rotation, but also no harm done — losing the kill-switch only means losing the ability to neutralize a future capture, it doesn't enable any new attack. |
| `revokeWhitelistAdmin` abused (multisig griefs) | Add path is bricked until owner re-installs. Existing posters keep posting. Worst-case: 7 days of no new posters. Acceptable cost for the kill-switch. |

The asymmetry — slow to install, fast to remove — is the model. It mirrors the
common pattern in mature DeFi governance (Uniswap, Aave): role grants are slow
and public; role revokes are fast and unilateral.

## Deploy script changes

`Deploy.s.sol` deploys two TimelockControllers (was one) with distinct salts:

- `UPGRADE_TIMELOCK_SALT = keccak256("thatsRekt.upgradeTimelock.v1")` — 7d
- `ADD_TIMELOCK_SALT     = keccak256("thatsRekt.addTimelock.v1")`     — 3d

Both have the multisig as proposer/executor. New optional env var
`INITIAL_WHITELISTERS=0xabc,0xdef,...` pre-populates the whitelist at init.

`DeployDev.s.sol` mirrors this with `*.dev.v1` salts; the EOA fills proposer
on both timelocks AND holds the `whitelistRemover` slot directly.

## Test coverage

22 tests directly exercising the new model (in addition to the 117 existing
product tests, all of which continue to pass with the single-principal default
setup):

- `test_initialize_*` — pre-population (empty / non-empty / duplicate / zero), role rejections.
- `test_threeRole_*` — admin can't remove; remover can't add; owner alone can do neither.
- `test_setWhitelistAdmin_*` — owner path, admin self-rotate path, random-caller revert, remover-revert, zero rejection, event emission.
- `test_setWhitelistRemover_*` — only owner, zero rejection, event emission.
- `test_revokeWhitelistAdmin_*` — only-remover gate, post-revoke add brick, removes still work after revoke, owner re-install path.
- `test_governance_canBeRotated` — full Ownable2Step flow plus admin + remover rotation.

All four test suites pass: 171/171 tests, including invariants and upgrade
flows.
