# Expected-PostId Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `post(...)` with `post(uint256 expectedPostId, ...)` so guardians can commit off-chain to a specific post URL before mining; reverts cleanly with `PostIdMismatch` if the next id doesn't match the caller's claim. Add `nextPostId()` view for clients to read the slot they're about to claim.

**Architecture:** UUPS-upgradeable Solidity contract. Single ABI break — only callers are this project's frontend + relay (both updated lockstep). No new storage. Bumps prod impl `v1.0.0 → v1.1.0` (dev `v1.1.0 → v1.2.0`); proxy address unchanged.

**Tech Stack:** Solidity 0.8.25, Foundry/forge, OZ-upgradeable, viem 2.21.55, wagmi v2, React+Vite. Worktree: `/Users/bautista/Desktop/B/DAMMcap/thatsRekt-expected-postid` on branch `bauti/expected-postid`. Spec: `tasks/122-expected-postid-spec.md`.

**File map:**

| File | Change |
|---|---|
| `contracts/src/ThatsRekt.sol` | Modify `post()` signature; add `error PostIdMismatch`; add `nextPostId()` view |
| `contracts/test/ThatsRekt.t.sol` | Update `_post(...)` helper (1 spot); rewrite 29 direct `reg.post(...)` callsites; add 9 new tests |
| `contracts/test/ThatsRektUpgrade.t.sol` | Rewrite 2 direct `reg.post(...)` callsites |
| `contracts/test/handlers/ThatsRektHandler.sol` | Rewrite the 1 direct `reg.post(...)` in `fuzz_post` |
| `contracts/test/ThatsRektInvariants.t.sol` | Add `invariant_postCountMatchesEvents` |
| `contracts/script/Deploy.s.sol` | Bump `IMPL_SALT` to `v1.1.0` |
| `contracts/script/DeployDev.s.sol` | Bump `IMPL_SALT` to `v1.2.0` |
| `frontend/src/lib/contracts.ts` | Replace `post` ABI entry; add `nextPostId` ABI entry |
| `frontend/src/hooks/usePost.ts` | Read `nextPostId()` pre-tx; pass `expectedPostId` as first arg |
| `frontend/src/pages/Docs.tsx` | Update 2 inline signature mentions (lines 136, 347) |
| `frontend/public/llms.txt` | Update line 9 signature reference |
| `DAMMfi-knowledge-base/threads/bauti/thatsrekt.md` | Append design-decision note |

**Out of scope (operator-gated, separate ticket):**
- Running `Deploy.s.sol` against Sepolia (validate)
- Running `Deploy.s.sol` against Base mainnet
- Frontend production redeploy

---

## Task 1: Contract — add error, view, and new `post()` signature

**Files:**
- Modify: `contracts/src/ThatsRekt.sol` (around line 215, 249-300, 662-710)

- [ ] **Step 1: Add `PostIdMismatch` error declaration**

In `ThatsRekt.sol`, locate the existing `error` block (search for `error TitleEmpty`). Add:

```solidity
/// @notice Reverts when the caller's claimed `expectedPostId` doesn't match the
///         next slot the contract is about to assign. Carries both values so
///         a wallet's revert-decoder can show "you expected 42, got 43".
error PostIdMismatch(uint256 expected, uint256 actual);
```

- [ ] **Step 2: Replace the `post()` signature + body prologue**

Locate the existing `function post(...)` definition (line ~662). Replace its signature and the first lines of the body:

**OLD:**
```solidity
function post(
    string   calldata title,
    address[] calldata attackers_,
    address[] calldata victims_,
    string   calldata note,
    uint64            attackedAt
) external onlyWhitelisted returns (uint256 id) {
    // Title is required and bounded — see MAX_TITLE_LENGTH.
    uint256 titleLen = bytes(title).length;
    if (titleLen == 0)                          revert TitleEmpty();
    if (titleLen > MAX_TITLE_LENGTH)            revert TitleTooLong();
```

**NEW:**
```solidity
/// @notice Post a new alert with optimistic id commitment.
/// @param expectedPostId The caller's claimed next id. Must equal `postCount + 1`
///                       or the call reverts. Lets posters commit to a stable
///                       post URL ("thatsrekt.com/post/base/42") off-chain
///                       before the tx mines: if the slot is taken, revert
///                       cleanly so the off-chain reference can be retried
///                       at the new slot rather than silently pointing to
///                       someone else's content.
/// @dev   This is NOT content-front-run protection — a racer can still copy
///        a guardian's content and target the same `expectedPostId`. What it
///        guarantees is "you won't accidentally land at a different id than
///        you committed to."
function post(
    uint256           expectedPostId,
    string   calldata title,
    address[] calldata attackers_,
    address[] calldata victims_,
    string   calldata note,
    uint64            attackedAt
) external onlyWhitelisted returns (uint256 id) {
    // Title is required and bounded — see MAX_TITLE_LENGTH.
    uint256 titleLen = bytes(title).length;
    if (titleLen == 0)                          revert TitleEmpty();
    if (titleLen > MAX_TITLE_LENGTH)            revert TitleTooLong();
```

- [ ] **Step 3: Insert the id-mismatch check immediately after the auto-increment**

Locate `unchecked { id = ++postCount; }` (line ~684). Replace that single line with:

**OLD:**
```solidity
    unchecked { id = ++postCount; }
```

**NEW:**
```solidity
    unchecked { id = ++postCount; }
    if (id != expectedPostId) revert PostIdMismatch(expectedPostId, id);
```

The check goes AFTER the increment so the revert reverses the storage write (Solidity reverts roll back state, including `++postCount`). This keeps the spec property "after a reverted post, postCount is unchanged" without extra bookkeeping.

- [ ] **Step 4: Add `nextPostId()` view immediately after `post()`**

Below the closing `}` of `post()`, before `_insertActiveTail`, add:

```solidity
/// @notice Id the next successful `post()` will receive — i.e. `postCount + 1`.
/// @dev    Convenience view for clients building the `expectedPostId` arg.
///         Equivalent to `postCount() + 1` but named for the use site.
function nextPostId() external view returns (uint256) {
    return postCount + 1;
}
```

- [ ] **Step 5: Compile**

```bash
cd contracts && forge build 2>&1 | tail -20
```

Expected: compiles cleanly. If existing tests reference `reg.post(...)` directly the test files won't compile yet — that's tasks 2-4. The contract itself must build.

If compile fails inside `src/`, fix and re-run before moving on. Don't commit yet — tests are still broken.

---

## Task 2: Test — update `_post(...)` helper to inject `nextPostId()`

**Files:**
- Modify: `contracts/test/ThatsRekt.t.sol` (line ~80-90)

- [ ] **Step 1: Update the helper**

Locate `function _post(address poster, address atk0, address vic0)` (line ~82). Modify the inner `reg.post(...)` call:

**OLD:**
```solidity
function _post(address poster, address atk0, address vic0) internal returns (uint256 id) {
    address[] memory atk = new address[](atk0 == address(0) ? 0 : 1);
    address[] memory vic = new address[](vic0 == address(0) ? 0 : 1);
    if (atk0 != address(0)) atk[0] = atk0;
    if (vic0 != address(0)) vic[0] = vic0;
    vm.prank(poster);
    id = reg.post("test title", atk, vic, "", uint64(block.timestamp));
}
```

**NEW:**
```solidity
function _post(address poster, address atk0, address vic0) internal returns (uint256 id) {
    address[] memory atk = new address[](atk0 == address(0) ? 0 : 1);
    address[] memory vic = new address[](vic0 == address(0) ? 0 : 1);
    if (atk0 != address(0)) atk[0] = atk0;
    if (vic0 != address(0)) vic[0] = vic0;
    vm.prank(poster);
    id = reg.post(reg.nextPostId(), "test title", atk, vic, "", uint64(block.timestamp));
}
```

98 of the test callsites flow through this helper — they pick up the change for free.

---

## Task 3: Test — update 29 direct `reg.post(...)` callsites in `ThatsRekt.t.sol`

**Files:**
- Modify: `contracts/test/ThatsRekt.t.sol` (29 callsites scattered through the file)

These are the tests that bypass the helper because they need to assert specific argument shapes (custom title, custom note, etc.).

- [ ] **Step 1: Locate every direct callsite**

```bash
cd contracts && grep -n "reg.post(\"" test/ThatsRekt.t.sol
```

This prints all 29 lines. Save the output as a checklist.

- [ ] **Step 2: For each callsite, prepend `reg.nextPostId()` as the first argument**

Pattern transformation:

**OLD:**
```solidity
reg.post("title", atk, vic, "note", uint64(block.timestamp));
```

**NEW:**
```solidity
reg.post(reg.nextPostId(), "title", atk, vic, "note", uint64(block.timestamp));
```

Apply this pattern to ALL 29 callsites. Sed mechanics:

```bash
sed -i '' -E 's/reg\.post\("/reg.post(reg.nextPostId(), "/g' contracts/test/ThatsRekt.t.sol
```

The pattern is unambiguous because `reg.post("` only appears at direct callsites — the helper uses `reg.post(reg.nextPostId(),` which doesn't match the search.

**WARNING:** the sed pattern matches ONLY callsites where the first arg starts with `"` (a string literal title). If any test passes a variable as the title (e.g. `reg.post(myTitle, ...)`), sed misses it. After running sed:

```bash
grep -n "reg\.post(" contracts/test/ThatsRekt.t.sol | grep -v "reg.nextPostId"
```

Anything that prints is an unconverted callsite. Convert manually.

- [ ] **Step 3: Compile + run the file's tests**

```bash
forge test --match-path test/ThatsRekt.t.sol 2>&1 | tail -40
```

Expected: ALL existing tests in this file pass. If a test fails, the failure should be a logic mismatch from the new revert behavior, NOT a compilation error. Track which tests fail; fix in Task 5 if they're in scope.

Most likely failures (handle now, before commit):
- Tests that assert specific `id` values where the auto-increment counter could differ. Should be unaffected — `nextPostId()` returns `postCount + 1` which IS the auto-increment value.
- Tests that pass an explicitly-wrong `expectedPostId`. None should exist yet (we haven't written the negative-path tests).

---

## Task 4: Test — update remaining direct callsites (Upgrade test + Handler)

**Files:**
- Modify: `contracts/test/ThatsRektUpgrade.t.sol` (2 callsites)
- Modify: `contracts/test/handlers/ThatsRektHandler.sol` (1 callsite at line 35)

- [ ] **Step 1: Sed the upgrade test**

```bash
sed -i '' -E 's/reg\.post\("/reg.post(reg.nextPostId(), "/g' contracts/test/ThatsRektUpgrade.t.sol
```

Then verify no leftovers:

```bash
grep -n "reg\.post(" contracts/test/ThatsRektUpgrade.t.sol | grep -v "reg.nextPostId"
```

- [ ] **Step 2: Update the invariant handler**

Open `contracts/test/handlers/ThatsRektHandler.sol`. The single callsite is in `fuzz_post` (line ~35):

**OLD:**
```solidity
try reg.post("test title", atk, vic, "", uint64(block.timestamp)) returns (uint256 id) {
    livePostIds.push(id);
} catch { /* expected: NotWhitelisted, etc. */ }
```

**NEW:**
```solidity
try reg.post(reg.nextPostId(), "test title", atk, vic, "", uint64(block.timestamp)) returns (uint256 id) {
    livePostIds.push(id);
} catch { /* expected: NotWhitelisted, etc. */ }
```

Note: passing `reg.nextPostId()` here makes every fuzz_post call pre-flight-correct. Since `nextPostId()` is a view, there's no race within a single tx — the read and the post happen atomically.

- [ ] **Step 3: Compile**

```bash
forge build 2>&1 | tail -10
```

Expected: compiles cleanly across the whole test tree.

- [ ] **Step 4: Run all existing tests**

```bash
forge test 2>&1 | tail -30
```

Expected: ALL existing tests pass (we haven't added new ones yet). If any test fails, debug before moving on.

- [ ] **Step 5: Commit the contract change + bulk migration**

```bash
git add contracts/
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "feat(contract): post() now requires expectedPostId; add nextPostId view"
```

---

## Task 5: Tests — add 9 new tests for expected-postid behavior

**Files:**
- Modify: `contracts/test/ThatsRekt.t.sol` (append to an appropriate `describe`-equivalent test block — search for the section heading nearest existing `post()` tests)

- [ ] **Step 1: Add tests 1-4 (success path + 3 mismatch revert variants)**

Append this block to `ThatsRekt.t.sol`, in the "POST" section (search for existing `function test_alice_can_post`):

```solidity
function test_post_succeedsWhenExpectedMatches() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    vm.prank(governance);
    reg.addWhitelisted(alice);

    uint256 expected = reg.nextPostId();
    vm.prank(alice);
    uint256 got = reg.post(expected, "title", atk, vic, "", uint64(block.timestamp));
    assertEq(got, expected);
    assertEq(reg.postCount(), expected);
}

function test_post_revertsWhenExpectedTooLow() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    vm.prank(governance);
    reg.addWhitelisted(alice);
    _post(alice, address(0), address(0)); // bumps postCount to 1

    // Caller claims id=1 again — already taken.
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(ThatsRekt.PostIdMismatch.selector, uint256(1), uint256(2)));
    reg.post(1, "title", atk, vic, "", uint64(block.timestamp));
}

function test_post_revertsWhenExpectedTooHigh() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    vm.prank(governance);
    reg.addWhitelisted(alice);

    // postCount is 0, next will be 1, but caller claims 99.
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(ThatsRekt.PostIdMismatch.selector, uint256(99), uint256(1)));
    reg.post(99, "title", atk, vic, "", uint64(block.timestamp));
}

function test_post_revertsWhenExpectedZero() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    vm.prank(governance);
    reg.addWhitelisted(alice);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(ThatsRekt.PostIdMismatch.selector, uint256(0), uint256(1)));
    reg.post(0, "title", atk, vic, "", uint64(block.timestamp));
}
```

- [ ] **Step 2: Add tests 5-7 (`nextPostId` view, post-revert state, race scenario)**

```solidity
function test_nextPostId_advancesAfterSuccessfulPost() public {
    vm.prank(governance);
    reg.addWhitelisted(alice);

    assertEq(reg.nextPostId(), 1);
    _post(alice, address(0), address(0));
    assertEq(reg.nextPostId(), 2);
    _post(alice, address(0), address(0));
    assertEq(reg.nextPostId(), 3);
}

function test_post_revertedTxLeavesPostCountUnchanged() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    vm.prank(governance);
    reg.addWhitelisted(alice);

    uint256 before_ = reg.postCount();

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(ThatsRekt.PostIdMismatch.selector, uint256(99), uint256(1)));
    reg.post(99, "title", atk, vic, "", uint64(block.timestamp));

    assertEq(reg.postCount(), before_, "revert must roll back the increment");
}

function test_post_raceScenarioRetryAtCorrectId() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    vm.prank(governance);
    reg.addWhitelisted(alice);
    vm.prank(governance);
    reg.addWhitelisted(bob);

    // A and B both saw nextPostId == 1 in the mempool.
    uint256 aTarget = reg.nextPostId(); // 1

    // B mines first.
    vm.prank(bob);
    uint256 bId = reg.post(1, "B's content", atk, vic, "", uint64(block.timestamp));
    assertEq(bId, 1);

    // A's tx mines second — claim 1, but the slot is gone.
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(ThatsRekt.PostIdMismatch.selector, uint256(1), uint256(2)));
    reg.post(aTarget, "A's content", atk, vic, "", uint64(block.timestamp));

    // A re-targets the new next slot and succeeds.
    vm.prank(alice);
    uint256 aId = reg.post(reg.nextPostId(), "A's content", atk, vic, "", uint64(block.timestamp));
    assertEq(aId, 2);
}
```

- [ ] **Step 3: Add tests 8-9 (whitelist-gate ordering, view readability across upgrade)**

```solidity
function test_post_whitelistGateFiresBeforeIdCheck() public {
    address[] memory atk = new address[](0);
    address[] memory vic = new address[](0);

    // alice is NOT whitelisted; she also passes a wrong expectedPostId.
    // The whitelist revert should fire first (NotWhitelisted), not PostIdMismatch.
    vm.prank(alice);
    vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
    reg.post(99, "title", atk, vic, "", uint64(block.timestamp));
}
```

For test 9 (existing posts readable post-upgrade), an upgrade test already lives in `ThatsRektUpgrade.t.sol`. It exercises that pre-upgrade posts remain readable after upgrading the impl. After the bulk-callsite migration in Task 4 it will pass already — no new test required here. Verify by:

```bash
forge test --match-path test/ThatsRektUpgrade.t.sol -vv 2>&1 | tail -20
```

If it fails, debug before continuing.

- [ ] **Step 4: Run the new tests**

```bash
forge test --match-test "test_post_" 2>&1 | tail -30
```

Expected: all new tests pass. If any fail, fix the test or the contract before moving on.

- [ ] **Step 5: Commit**

```bash
git add contracts/test/ThatsRekt.t.sol
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "test(contract): expected-postid commitment behavior + race scenarios"
```

---

## Task 6: Invariant — `postCount` must equal count of `PostCreated` events

**Files:**
- Modify: `contracts/test/ThatsRektInvariants.t.sol`

This guards against any future change that lets `postCount` drift from the public event log (e.g. someone adding a "silent" post path or breaking the revert-rolls-back property).

- [ ] **Step 1: Add an event recorder to the handler**

Open `contracts/test/handlers/ThatsRektHandler.sol`. At the top of the contract body (after existing state vars), add:

```solidity
/// Count of successful posts the handler observed. Compared against
/// `reg.postCount()` in the invariant — they must always match.
uint256 public successfulPosts;
```

In `fuzz_post`, increment on the success path:

**OLD:**
```solidity
try reg.post(reg.nextPostId(), "test title", atk, vic, "", uint64(block.timestamp)) returns (uint256 id) {
    livePostIds.push(id);
} catch { /* expected: NotWhitelisted, etc. */ }
```

**NEW:**
```solidity
try reg.post(reg.nextPostId(), "test title", atk, vic, "", uint64(block.timestamp)) returns (uint256 id) {
    livePostIds.push(id);
    unchecked { ++successfulPosts; }
} catch { /* expected: NotWhitelisted, etc. */ }
```

- [ ] **Step 2: Add the invariant**

Append to `ThatsRektInvariants.t.sol`:

```solidity
/// `postCount` must equal the number of successful `post()` calls across
/// the whole fuzz campaign. Catches any future regression where a revert
/// fails to roll back the increment, or a silent post path is added.
function invariant_postCountMatchesSuccessful() public {
    assertEq(reg.postCount(), handler.successfulPosts(), "postCount drifted from successful post count");
}
```

- [ ] **Step 3: Run the invariant suite**

```bash
forge test --match-path test/ThatsRektInvariants.t.sol 2>&1 | tail -20
```

Expected: invariant passes. If it fails, the new check has caught a real bug — debug before continuing.

- [ ] **Step 4: Commit**

```bash
git add contracts/test/handlers/ThatsRektHandler.sol contracts/test/ThatsRektInvariants.t.sol
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "test(invariant): postCount equals successful post count across fuzz campaign"
```

---

## Task 7: Full forge test suite green

**Files:** none (verification only)

- [ ] **Step 1: Run everything**

```bash
cd contracts && forge test 2>&1 | tail -50
```

Expected: ALL tests pass. ALL invariants pass. If any test still fails, fix it before moving on — the contract is the foundation for everything below.

- [ ] **Step 2: Run with verbosity if anything is unclear**

```bash
forge test -vvv 2>&1 | grep -E "(FAIL|PASS)" | tail -40
```

---

## Task 8: Bump impl salt for fresh CREATE2 deploy

**Files:**
- Modify: `contracts/script/Deploy.s.sol` (line ~123)
- Modify: `contracts/script/DeployDev.s.sol` (line ~76)

The proxy stays at the same address (its salt is unchanged). Only the implementation salt bumps so a fresh impl gets deployed via CREATE2 at a new deterministic address.

- [ ] **Step 1: Bump prod impl salt**

In `Deploy.s.sol` line ~123:

**OLD:**
```solidity
bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.v1.0.0");
```

**NEW:**
```solidity
bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.v1.1.0");
```

- [ ] **Step 2: Bump dev impl salt**

In `DeployDev.s.sol` line ~76:

**OLD:**
```solidity
bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.dev.v1.1.0");
```

**NEW:**
```solidity
bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.dev.v1.2.0");
```

- [ ] **Step 3: Run deploy script tests (compilation only — no live broadcast)**

```bash
forge test --match-path test/Deploy.t.sol 2>&1 | tail -10
forge test --match-path test/DeployDev.t.sol 2>&1 | tail -10
```

Expected: both pass. They run the deploy logic against a forge fork without broadcasting.

- [ ] **Step 4: Commit**

```bash
git add contracts/script/
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "chore(deploy): bump impl salts for v1.1.0 (prod) / v1.2.0 (dev)"
```

---

## Task 9: Frontend — update ABI shape

**Files:**
- Modify: `frontend/src/lib/contracts.ts` (around line 130-150)

- [ ] **Step 1: Replace the `post` ABI entry**

Find the existing `post` ABI entry (search `name: 'post'` or look near line 130). Replace it AND add a new `nextPostId` entry:

**OLD:**
```typescript
// Submit a new alert. Reverts unless caller is whitelisted.
//   title       — required, 1..200 bytes
//   attackers_  — addresses suspected of perpetrating the attack
//   victims_    — addresses that lost funds
//   note        — free-form description
//   attackedAt  — unix seconds, > 0, <= block.timestamp
{
  type: 'function',
  name: 'post',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'title', type: 'string' },
    { name: 'attackers_', type: 'address[]' },
    { name: 'victims_', type: 'address[]' },
    { name: 'note', type: 'string' },
    { name: 'attackedAt', type: 'uint64' },
  ],
  outputs: [{ name: 'id', type: 'uint256' }],
},
```

**NEW:**
```typescript
// Submit a new alert with optimistic id commitment.
//   expectedPostId  — caller's claim of the next post id; must equal
//                     postCount + 1 or the call reverts. Read via
//                     `nextPostId()` immediately before signing.
//   title           — required, 1..200 bytes
//   attackers_      — addresses suspected of perpetrating the attack
//   victims_        — addresses that lost funds
//   note            — free-form description
//   attackedAt      — unix seconds, > 0, <= block.timestamp
{
  type: 'function',
  name: 'post',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'expectedPostId', type: 'uint256' },
    { name: 'title', type: 'string' },
    { name: 'attackers_', type: 'address[]' },
    { name: 'victims_', type: 'address[]' },
    { name: 'note', type: 'string' },
    { name: 'attackedAt', type: 'uint64' },
  ],
  outputs: [{ name: 'id', type: 'uint256' }],
},
// Convenience view: id the next successful `post()` will receive.
{
  type: 'function',
  name: 'nextPostId',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint256' }],
},
```

- [ ] **Step 2: Typecheck**

```bash
cd frontend && bun run typecheck 2>&1 | tail -20
```

Expected: typecheck FAILS in `usePost.ts` because the `args` array is now the wrong shape. That's the next task. Don't commit yet.

---

## Task 10: Frontend — `usePost` reads `nextPostId()` and passes it

**Files:**
- Modify: `frontend/src/hooks/usePost.ts` (around line 95-125)

- [ ] **Step 1: Switch to `useReadContract` for `nextPostId` + thread it through `submit()`**

The hook currently uses `useWriteContract` only. We need to *read* `nextPostId()` immediately before broadcasting, then include the result in the tx args. The cleanest pattern given the spec's "optionally re-fetch right before submitting" flag is to make the read happen inside `submit()` synchronously via wagmi's imperative read API (`readContract` from `@wagmi/core` configured with the same wagmi config the app already uses).

Find the wagmi config import path the app uses. Open `frontend/src/lib/wagmi.ts`:

```bash
grep -n "createConfig\|export" frontend/src/lib/wagmi.ts
```

Note the exported config name (typically `wagmiConfig` or `config`).

Modify `usePost.ts`:

**OLD (the `submit` callback):**
```typescript
const submit = useCallback(
  (params: PostSubmitParams) => {
    const { chainId, title, attackers, victims, note, attackedAt } = params

    const address = registryAddress(chainId)
    if (!address) {
      throw new Error(
        `usePost: no registry deployed on chainId ${chainId}. ` +
          `Use chainsWithRegistry() to gate the chain selector.`,
      )
    }

    const supportedChainId = chainId as SupportedChainId
    setSubmittedChainId(supportedChainId)
    writeContract({
      address,
      abi: registryAbi,
      functionName: 'post',
      args: [title, attackers, victims, note, attackedAt],
      chainId: supportedChainId,
    })
  },
  [writeContract],
)
```

**NEW:**
```typescript
const [readError, setReadError] = useState<Error | null>(null)

const submit = useCallback(
  (params: PostSubmitParams) => {
    setReadError(null)
    const { chainId, title, attackers, victims, note, attackedAt } = params

    const address = registryAddress(chainId)
    if (!address) {
      throw new Error(
        `usePost: no registry deployed on chainId ${chainId}. ` +
          `Use chainsWithRegistry() to gate the chain selector.`,
      )
    }

    const supportedChainId = chainId as SupportedChainId
    setSubmittedChainId(supportedChainId)

    // Read nextPostId() immediately before broadcast — this minimizes
    // the window between "what slot the contract said is next" and
    // "what slot the tx tries to claim". A racer can still front-run
    // us between this read and our tx mining; that's by design (see
    // the contract's PostIdMismatch revert and `nextPostId` natspec).
    //
    // Promise pattern (not async/await): keeps `submit`'s public type
    // as `(params) => void`, so existing callers in PostFormModal don't
    // need to change. Read failures land in `readError` state, which
    // is folded into the exposed `error` field below — same surface as
    // a broadcast or receipt error.
    readContract(wagmiConfig, {
      address,
      abi: registryAbi,
      functionName: 'nextPostId',
      chainId: supportedChainId,
    })
      .then((expectedPostId) => {
        writeContract({
          address,
          abi: registryAbi,
          functionName: 'post',
          args: [expectedPostId, title, attackers, victims, note, attackedAt],
          chainId: supportedChainId,
        })
      })
      .catch((err: unknown) => {
        setReadError(err instanceof Error ? err : new Error(String(err)))
      })
  },
  [writeContract],
)
```

Also update the `error` field in the return object to include the new read error source:

**OLD:**
```typescript
error: broadcastError ?? receiptError ?? null,
```

**NEW:**
```typescript
error: readError ?? broadcastError ?? receiptError ?? null,
```

And in the existing `reset` callback, also clear the read error:

**OLD:**
```typescript
const reset = useCallback(() => {
  setSubmittedChainId(undefined)
  resetWrite()
}, [resetWrite])
```

**NEW:**
```typescript
const reset = useCallback(() => {
  setSubmittedChainId(undefined)
  setReadError(null)
  resetWrite()
}, [resetWrite])
```

Add the imports at the top of the file:

```typescript
import { readContract } from 'wagmi/actions'
import { wagmiConfig } from '../lib/wagmi'
```

`wagmi/actions` re-exports from `@wagmi/core/actions`, so no new dependency is needed (verified: `frontend/node_modules/wagmi/dist/types/exports/actions.d.ts` is `export * from '@wagmi/core/actions'`).

- [ ] **Step 2: Typecheck**

```bash
cd frontend && bun run typecheck 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Build**

```bash
bun run build 2>&1 | tail -20
```

Expected: clean (modulo pre-existing Rollup `/*#__PURE__*/` warnings on transitive deps, which are unrelated).

- [ ] **Step 4: Run frontend tests**

```bash
bun test 2>&1 | tail -10
```

Expected: existing tests still pass. None of the canonical-fingerprint tests touch `usePost`.

- [ ] **Step 5: Commit**

```bash
cd ..
git add frontend/src/lib/contracts.ts frontend/src/hooks/usePost.ts
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "feat(frontend): post() now reads nextPostId() and passes expectedPostId"
```

---

## Task 11: Frontend — update inline signature mentions on Docs page

**Files:**
- Modify: `frontend/src/pages/Docs.tsx` (lines 136 and 347)

- [ ] **Step 1: Update line ~136**

Search the file for `post(title, attackers, victims, note, attackedAt)`. Replace BOTH occurrences with:

```
post(expectedPostId, title, attackers, victims, note, attackedAt)
```

```bash
sed -i '' 's/post(title, attackers, victims, note, attackedAt)/post(expectedPostId, title, attackers, victims, note, attackedAt)/g' frontend/src/pages/Docs.tsx
```

- [ ] **Step 2: Verify no leftovers**

```bash
grep -n "post(title" frontend/src/pages/Docs.tsx
```

Expected: empty output (no matches).

- [ ] **Step 3: If the page has explanatory prose nearby, add a one-line note**

Open `frontend/src/pages/Docs.tsx`. Near the first `post(expectedPostId, ...)` reference (line ~136), look at the surrounding `<p>` tags. If there's natural space for it, add a short sentence:

```
Pass the id you expect to receive (read it from `nextPostId()` immediately
before signing). The call reverts cleanly if the slot has already been claimed.
```

If the surrounding prose doesn't have an obvious insertion point, skip it — the natspec on the ABI is enough.

---

## Task 12: Update `frontend/public/llms.txt`

**Files:**
- Modify: `frontend/public/llms.txt` (line 9)

- [ ] **Step 1: Edit line 9**

The line currently reads:

```
- **Smart contracts.** ... Posters call `post(title, attackers[], victims[], note, attackedAt)` and emit `PostCreated`. ...
```

Replace `post(title, attackers[], victims[], note, attackedAt)` with `post(expectedPostId, title, attackers[], victims[], note, attackedAt)`:

```bash
sed -i '' 's|post(title, attackers\[\], victims\[\], note, attackedAt)|post(expectedPostId, title, attackers[], victims[], note, attackedAt)|' frontend/public/llms.txt
```

- [ ] **Step 2: Verify**

```bash
grep -n "post(" frontend/public/llms.txt
```

Expected output: line 9 now mentions `expectedPostId`; lines 39 and 59 are unchanged (they say `post(...)` generically, no specific signature).

- [ ] **Step 3: Commit Tasks 11 + 12 together**

```bash
git add frontend/src/pages/Docs.tsx frontend/public/llms.txt
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "docs(frontend): update post() signature references for expectedPostId"
```

---

## Task 13: Update knowledge-base note

**Files:**
- Modify: `/Users/bautista/Desktop/B/DAMMcap/DAMMfi-knowledge-base/threads/bauti/thatsrekt.md`

- [ ] **Step 1: Append a design-decision section**

Open the file. Append (or insert into an "open questions / decisions" section if one already exists):

```markdown
## Decision: `post()` requires `expectedPostId` (#122, 2026-05-02)

Replaced `post(title, attackers, victims, note, attackedAt)` with `post(expectedPostId, title, ..., attackedAt)`. New view `nextPostId()` returns `postCount + 1`.

**What this solves:** stable-ledger commitment. A guardian can pre-publish "thatsrekt.com/post/base/42" off-chain (Twitter teaser, etc.) and either land at id 42 or revert cleanly with `PostIdMismatch(expected, actual)`. No more silent landing at a different id when someone else races them.

**What this does NOT solve:** content scoop-stealing. A racer who copies a guardian's content + outpays gas + targets the same `expectedPostId` will still land at that id with their tx. We considered hash-based ids for that and explicitly punted — adds complexity (caller-supplied salt, opaque uint256 ids) for a threat that's marginal in a small whitelisted set.

Contract impl bumped prod `v1.0.0 → v1.1.0`, dev `v1.1.0 → v1.2.0`. Proxy address unchanged. Frontend + relay updated lockstep.

Ref: spec at `tasks/122-expected-postid-spec.md` in `ThatsRekt/thatsRekt`.
```

- [ ] **Step 2: Commit the KB note**

The KB lives in its own repo. Commit there separately:

```bash
cd /Users/bautista/Desktop/B/DAMMcap/DAMMfi-knowledge-base
git add threads/bauti/thatsrekt.md
git -c user.name="bauti.eth" -c user.email="bautista@dammcap.finance" commit -m "thatsrekt: log #122 expectedPostId decision (stable-ledger commitment)"
```

Push later with the rest of the KB pushes — don't push individually.

---

## Task 14: Push branch + open PR

**Files:** none (git ops only)

- [ ] **Step 1: Push**

```bash
cd /Users/bautista/Desktop/B/DAMMcap/thatsRekt-expected-postid
git push -u origin bauti/expected-postid 2>&1 | tail -5
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base master --title "feat(#122): post() requires expectedPostId for stable-ledger commitment" --body "$(cat <<'EOF'
## Summary
- New `post(uint256 expectedPostId, ...)` reverts \`PostIdMismatch(expected, actual)\` if \`++postCount\` doesn't match the caller's claim. Lets guardians commit to a specific post URL off-chain before mining.
- New view \`nextPostId()\` returns \`postCount + 1\` for clients to read pre-tx.
- Old \`post(...)\` ABI removed (breaking — only this project's frontend + relay are affected, both updated lockstep in this PR).
- No new storage. Proxy address unchanged. Impl bumps prod \`v1.0.0 → v1.1.0\`, dev \`v1.1.0 → v1.2.0\`.

## What this does NOT do
- Does NOT prevent content scoop-stealing. A racer can still copy your content and land at the same \`expectedPostId\`. The point is "stable ledger" — your pre-published URL won't silently land at a different id.

## Test plan
- [x] \`forge test\` — all existing tests + 8 new tests + 1 new invariant pass
- [x] \`bun run typecheck\` — clean
- [x] \`bun run build\` — clean
- [x] \`bun test\` — frontend canonical tests pass (unrelated to this change but run for hygiene)
- [ ] Operator runs Sepolia deploy (\`Deploy.s.sol\` against base-sepolia) — separate ticket
- [ ] After Sepolia validates: prod redeploy on Base mainnet — task #106
- [ ] Frontend rebuild + redeploy public stack via \`damm-cloud/thatsrekt/deploy.sh public\` — separate operator step

## Spec
\`tasks/122-expected-postid-spec.md\` (committed in this PR).
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 3: Confirm CI is happy**

```bash
gh pr checks 2>&1 | tail -10
```

If any checks fail, debug before marking the PR ready for review.

---

## Self-review checklist

After implementing all tasks, before marking the PR for operator review:

- [ ] No `TODO` / `TBD` / `XXX` left in any modified file
- [ ] `forge test` passes locally end-to-end (every test, every invariant)
- [ ] `bun run build` produces a clean frontend bundle
- [ ] `nextPostId()` view is exposed in BOTH the contract AND the ABI
- [ ] PR description matches the spec — no unflagged scope creep
- [ ] KB note committed in `DAMMfi-knowledge-base/threads/bauti/thatsrekt.md`
- [ ] Spec doc (`tasks/122-expected-postid-spec.md`) is in this branch
- [ ] No mainnet deploy was run from this branch — that's an operator step gated on Sepolia validation
