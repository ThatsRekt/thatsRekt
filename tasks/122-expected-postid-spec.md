# Spec — `post()` requires `expectedPostId`

**Task:** #122 — caller-supplied expected post ID for stable-ledger commitment.
**Status:** design-approved 2026-05-02, awaiting spec review.
**Owner:** bauti.eth

---

## Problem

The current `post()` mints an auto-increment `postCount` ID. Guardians have no way to commit off-chain to a specific post URL (`thatsrekt.com/post/base/42`) before mining — if anyone else lands a post first, the guardian's pre-published link silently points to the wrong content.

This is **not** a confidentiality / content-front-running protection. A racer can still copy a guardian's content and front-run them at any ID slot. What this design solves is **the guardian's optimistic commitment**: "I am about to post; I expect this to be ID N; if it isn't, abort."

## Design

Replace `post(...)` with a single new function whose first argument is the caller's expected next post id. The contract increments `postCount` as today and reverts if the resulting id doesn't match the caller's expectation.

### Interface

```solidity
/// @notice Post a new alert with optimistic id commitment.
/// @param expectedPostId The caller's claimed next id. Must equal `postCount + 1`
///                       or the call reverts. This lets posters commit to a
///                       specific URL / off-chain reference before the tx mines.
/// @param title          Required, ≤ MAX_TITLE_LENGTH bytes.
/// @param attackers_     Suspected attacker addresses.
/// @param victims_       Victim contract addresses.
/// @param note           Free-form Markdown body (off-chain consumers).
/// @param attackedAt     UTC second timestamp of the on-chain attack.
/// @return id            Always equal to `expectedPostId` on success.
function post(
    uint256 expectedPostId,
    string   calldata title,
    address[] calldata attackers_,
    address[] calldata victims_,
    string   calldata note,
    uint64            attackedAt
) external onlyWhitelisted returns (uint256 id);

/// @notice Reverts when the caller's expected id doesn't match the next slot.
error PostIdMismatch(uint256 expected, uint256 actual);
```

### Behavior

1. Increment `postCount` (`unchecked { id = ++postCount; }`) as today.
2. Assert `id == expectedPostId`, else revert `PostIdMismatch(expectedPostId, id)`.
3. All other behavior (title bounds, attackedAt validation, address counts, storage writes, linked-list insert, `PostCreated` event) is unchanged.

### Read helper

```solidity
/// @notice The id the next successful `post()` will receive. UI / poster
///         clients call this to populate `expectedPostId` before signing.
function nextPostId() external view returns (uint256) { return postCount + 1; }
```

This is a pure convenience — frontends could compute the same thing as `postCount() + 1`, but a named view makes the integration story obvious.

### Migration

- **Breaking ABI change.** Old `post(string, address[], address[], string, uint64)` is removed in this upgrade. There is no transitional dual-method period.
- **Justification:** the only callers are this project's own frontend + relay; both are upgraded in lockstep with the contract. Keeping the old function around is dead surface that future maintainers have to reason about.
- **Implementation version:** bump impl from v1.x to v1.next (slot in line with the existing `_v1_2` mock convention — actual version number determined when implementing).
- **Storage layout:** unchanged. `postCount`, `_posts[id]`, the doubly-linked list, all view functions, all events keep working — they accept any `uint256` id today, and continue to do so. No new state added.

### Frontend / relay updates

- `PostAlertButton` flow: read `nextPostId()` → pass as `expectedPostId` in the post tx.
- Optional UX: if the user has been on the form for >N seconds (mempool race window), re-fetch `nextPostId()` right before submitting and warn if it changed since they opened the form.
- Off-chain post URL preview becomes safe: "Your post will be at thatsrekt.com/post/base/42" can be displayed pre-tx and is guaranteed correct on success (else tx reverts cleanly, user retries).

### Indexer

No change. `PostCreated.id` is unchanged in semantics. The indexer continues to derive `chainSlug-onchainId` composite ids exactly as today.

### Mesh

No change. Mesh consumes indexer rows by `id`; it doesn't care how that id was assigned.

## Failure modes

| Scenario | Behavior |
|---|---|
| Two guardians both target `expectedPostId = 42`; B mines first | B's tx succeeds (id=42, B's content). A's tx reverts with `PostIdMismatch(42, 43)`. A retries with `expectedPostId = 43`. |
| Guardian targets `expectedPostId = 99` while `postCount = 41` | Reverts immediately. The check is exact equality; the guardian must use the actual next slot, not skip ahead. |
| Guardian targets `expectedPostId = 0` | Reverts (`postCount` is 1-indexed; `++postCount` is never 0). |
| Whitelist removed mid-mempool | Reverts on `onlyWhitelisted` *before* the id check. Same as today. |

## What this does NOT solve

- **Content front-running.** A racer who copies a guardian's content + outpays gas + targets the same `expectedPostId` will land at that id with the racer's tx. The guardian still has to retry. This was discussed and explicitly accepted as out of scope — the goal here is stable-ledger commitment, not content scoop protection.
- **Cross-poster dedupe.** Two guardians who independently spot the same exploit each get their own post (different expected ids). This is a feature, not a bug — multiple independent confirmations are valuable signal.

## Tests

Foundry test additions on top of the existing `ThatsRekt.t.sol` battery:

1. `post(...)` succeeds when `expectedPostId == postCount + 1`.
2. `post(...)` reverts `PostIdMismatch` when expected is too low.
3. `post(...)` reverts `PostIdMismatch` when expected is too high.
4. `post(...)` reverts `PostIdMismatch` when expected is 0.
5. After a successful post, the next caller's `nextPostId()` view returns `previousId + 1`.
6. After a *reverted* post, `postCount` is unchanged (Solidity revert semantics, but assert it explicitly).
7. Race scenario: A targets 42, B targets 42 → B mines first → A reverts → A re-targets 43 → A succeeds at 43.
8. Whitelist gate still fires *before* the id check (revert reason is `NotWhitelisted`, not `PostIdMismatch`).
9. Upgrade path: existing posts at small auto-increment ids continue to be readable through every view function after the upgrade.

Invariant test addition (extends `ThatsRektInvariants.t.sol`):

- After arbitrary `post()` calls, `postCount` always equals the count of `PostCreated` events emitted.

## Documentation updates

The user explicitly called out three surfaces — all three must be updated in this PR:

1. **Repo README + `frontend/public/llms.txt`** — update the `post(title, attackers[], victims[], note, attackedAt)` signature reference to the new shape.
2. **Docs page (`/docs` route)** — update integrator examples + ABI snippets if any are pinned.
3. **Knowledge base ([[thatsrekt]] in `DAMMfi-knowledge-base/threads/bauti/`)** — note the design decision and the rationale (stable-ledger commitment, NOT content front-run protection). Add a follow-up bullet on the page.

## Out of scope (future)

- Content-hash-based ID for true front-run protection. Considered in design discussion, deferred — adds complexity (caller-supplied salt, opaque IDs) and the scoop-stealing threat is judged low for a small whitelisted set.
- `predictPostId(...)` view that takes a salt — not needed because `nextPostId()` is enough for the chosen design.
