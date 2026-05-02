// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ThatsRekt} from "../src/ThatsRekt.sol";
import {ThatsRektV1_1Mock} from "./mocks/ThatsRektV1_1Mock.sol";
import {ThatsRektV1_2Mock} from "./mocks/ThatsRektV1_2Mock.sol";

/// @notice Upgrade-flow tests for the UUPS-upgradeable ThatsRekt.
///
/// The 117 pre-existing tests in ThatsRekt.t.sol exercise the contract's
/// product behavior through the proxy. This file is dedicated to the
/// upgrade plumbing itself: initializer hardening, upgrade
/// authorization, the timelocked upgrade flow, state preservation
/// across upgrades, and the storage gap reservation.
contract ThatsRektUpgradeTest is Test {
    /// @dev Match the production deploy script. Tests use a small delay
    ///      mostly for symmetry with prod; the value just has to be
    ///      ≥ MIN_DELAY (configurable on TimelockController, defaults
    ///      to whatever we pass at construction).
    uint256 internal constant TIMELOCK_DELAY = 7 days;

    /// @dev Salt used for all `schedule` / `execute` calls in this file.
    ///      Distinct salts let us batch multiple ops, but every test
    ///      here only needs one queued operation at a time.
    bytes32 internal constant OP_SALT = bytes32(uint256(1));

    address internal multisig;

    /// @dev Memory mirror of a Post's flat header used to dodge "stack too
    ///      deep" when destructuring all 8 return values of `getPost`.
    struct PostSnapshot {
        address poster;
        uint64 attackedAt;
        uint32 upConfirms;
        uint32 downConfirms;
        bool removed;
        uint64 lastUpdatedAt;
    }

    function setUp() public {
        multisig = makeAddr("multisig");
    }

    /*//////////////////////////////////////////////////////////////
                         INITIALIZATION HARDENING
    //////////////////////////////////////////////////////////////*/

    function test_initialize_setsOwner() public {
        ThatsRekt reg = _deployProxied(multisig);
        assertEq(reg.owner(), multisig);
    }

    function test_initialize_revertsOnSecondCall() public {
        ThatsRekt reg = _deployProxied(multisig);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        reg.initialize(
            makeAddr("anotherOwner"),
            makeAddr("anotherAdmin"),
            makeAddr("anotherRemover"),
            makeAddr("anotherPurger"),
            makeAddr("anotherPurgeRem"),
            new address[](0)
        );
    }

    function test_initialize_revertsOnZeroOwner() public {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (address(0), makeAddr("admin"), makeAddr("remover"), makeAddr("purger"), makeAddr("purgeRem"), new address[](0))
        );
        // Proxy ctor delegate-calls initialize, which reverts in
        // OwnableUpgradeable; the revert bubbles up unchanged.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_initialize_revertsOnZeroWhitelistAdmin() public {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (makeAddr("owner"), address(0), makeAddr("remover"), makeAddr("purger"), makeAddr("purgeRem"), new address[](0))
        );
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_initialize_revertsOnZeroWhitelistRemover() public {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (makeAddr("owner"), makeAddr("admin"), address(0), makeAddr("purger"), makeAddr("purgeRem"), new address[](0))
        );
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_implementation_initializeIsDisabled() public {
        ThatsRekt impl = new ThatsRekt();
        // Constructor on the impl calls _disableInitializers, so
        // initialize() on the impl directly always reverts. This
        // closes the well-known foothold of taking over the impl's
        // owner slot via a public initialize on the logic contract.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(multisig, multisig, multisig, multisig, multisig, new address[](0));
    }

    /*//////////////////////////////////////////////////////////////
                          UPGRADE AUTHORIZATION
    //////////////////////////////////////////////////////////////*/

    function test_upgradeToAndCall_revertsForNonOwner() public {
        ThatsRekt reg = _deployProxied(multisig);
        ThatsRektV1_1Mock newImpl = new ThatsRektV1_1Mock();

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        reg.upgradeToAndCall(address(newImpl), "");
    }

    /*//////////////////////////////////////////////////////////////
                       UPGRADE EXECUTION VIA TIMELOCK
    //////////////////////////////////////////////////////////////*/

    /// Full integration test: deploy impl + timelock + proxy with the
    /// timelock as the proxy's owner; multisig schedules an upgrade,
    /// waits the delay, executes it, and verifies the new impl
    /// is reachable through the proxy AND that pre-upgrade state
    /// survives the swap.
    function test_upgradeViaTimelock_succeedsAfterDelay() public {
        (ThatsRekt reg, TimelockController timelock) = _deployTimelockedProxy();

        // Plant a piece of state we can read back after the upgrade.
        // Whitelist a poster, post once with a dummy attacker, vote on it.
        address poster = makeAddr("poster");
        address voter = makeAddr("voter");
        address attacker = makeAddr("attackerAddr");
        _whitelistViaTimelock(reg, timelock, poster);
        _whitelistViaTimelock(reg, timelock, voter);

        address[] memory atks = new address[](1);
        atks[0] = attacker;
        address[] memory vics = new address[](0);
        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(poster);
        uint256 postId = reg.post(_expectedPid, "test title", atks, vics, "pre-upgrade", uint64(block.timestamp));

        vm.prank(voter);
        reg.confirm(postId, ThatsRekt.ConfirmDirection.Up);

        // Snapshot pre-upgrade state for later comparison. getPost returns
        // 8 values which blows the stack — read into a memory struct.
        PostSnapshot memory pre = _snapshotPost(reg, postId);
        int256 preScore = reg.attackerScore(attacker);

        // Schedule + execute the upgrade through the timelock.
        ThatsRektV1_1Mock newImpl = new ThatsRektV1_1Mock();
        bytes memory upgradeCall = abi.encodeCall(reg.upgradeToAndCall, (address(newImpl), ""));
        _scheduleAndExecute(timelock, address(reg), upgradeCall);

        // The new function must now be reachable through the proxy.
        assertEq(ThatsRektV1_1Mock(address(reg)).version(), "1.1");

        // Pre-upgrade state must be intact.
        PostSnapshot memory post_ = _snapshotPost(reg, postId);
        assertEq(post_.poster, pre.poster, "poster lost across upgrade");
        assertEq(post_.upConfirms, pre.upConfirms, "upConfirm count lost across upgrade");
        assertEq(post_.removed, pre.removed, "removed flag flipped across upgrade");
        assertEq(reg.attackerScore(attacker), preScore, "attackerScore lost across upgrade");

        // Owner is still the timelock; further upgrades still gated.
        assertEq(reg.owner(), address(timelock));
    }

    function test_upgradeViaTimelock_revertsBeforeDelay() public {
        (ThatsRekt reg, TimelockController timelock) = _deployTimelockedProxy();

        ThatsRektV1_1Mock newImpl = new ThatsRektV1_1Mock();
        bytes memory upgradeCall = abi.encodeCall(reg.upgradeToAndCall, (address(newImpl), ""));

        vm.prank(multisig);
        timelock.schedule(address(reg), 0, upgradeCall, bytes32(0), OP_SALT, TIMELOCK_DELAY);

        // Don't warp. Execute should fail with TimelockUnexpectedOperationState.
        vm.prank(multisig);
        vm.expectRevert();
        timelock.execute(address(reg), 0, upgradeCall, bytes32(0), OP_SALT);
    }

    function test_upgradeViaTimelock_revertsForNonExecutor() public {
        (ThatsRekt reg, TimelockController timelock) = _deployTimelockedProxy();

        ThatsRektV1_1Mock newImpl = new ThatsRektV1_1Mock();
        bytes memory upgradeCall = abi.encodeCall(reg.upgradeToAndCall, (address(newImpl), ""));

        vm.prank(multisig);
        timelock.schedule(address(reg), 0, upgradeCall, bytes32(0), OP_SALT, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);

        // Random EOA is not on the executor role.
        address attacker = makeAddr("notExecutor");
        vm.prank(attacker);
        vm.expectRevert();
        timelock.execute(address(reg), 0, upgradeCall, bytes32(0), OP_SALT);
    }

    /*//////////////////////////////////////////////////////////////
                              STORAGE GAP
    //////////////////////////////////////////////////////////////*/

    /// The contract reserves trailing slots (`__gap`) for forward-
    /// compatible storage growth. We can't see private storage names
    /// from a test, but we can read the slots directly via vm.load
    /// and assert they are zero on a freshly initialized proxy. This
    /// guards against accidentally introducing a state variable in the
    /// gap region in a future change.
    function test_storageGap_isZeroedOnFreshProxy() public {
        ThatsRekt reg = _deployProxied(multisig);

        // Sequential storage layout (OZ inherited contracts use ERC-7201
        // namespaced storage in 5.x and don't take consecutive slots):
        //
        //   slot  0  isWhitelisted        (mapping → reads as 0)
        //   slot  1  whitelistAdmin
        //   slot  2  whitelistRemover     (added in v1.2)
        //   slot  3  purgeAdmin           (added in v1.3)
        //   slot  4  purgeRemover         (added in v1.3)
        //   slot  5  postCount
        //   slot  6  _posts               (mapping)
        //   slot  7  confirmationOf       (mapping)
        //   slot  8  _confirmers          (mapping)
        //   slot  9  _disconfirmers       (mapping)
        //   slot 10  attackerScore        (mapping)
        //   slot 11  attackerAppearances  (mapping)
        //   slot 12  isVictim             (mapping)
        //   slot 13  _victimActivePosts   (mapping)
        //   slot 14  headPostId
        //   slot 15  tailPostId
        //   slot 16  nextPostId           (mapping)
        //   slot 17  prevPostId           (mapping)
        //   slot 18  postTitle            (mapping; v1.1)
        //   slot 19–64  __gap[46]         (v1.3 shrank from [48] for
        //                                  purgeAdmin + purgeRemover)
        //
        // If a future change adds state, this test will start reading
        // non-zero values from the lower gap slots — that's the signal
        // to reduce the gap size in src/ThatsRekt.sol accordingly.
        uint256 GAP_START = 19;
        uint256 GAP_LEN = 46;
        for (uint256 i; i < GAP_LEN; ++i) {
            bytes32 v = vm.load(address(reg), bytes32(GAP_START + i));
            assertEq(uint256(v), 0, "gap slot is non-zero on fresh proxy");
        }
    }

    /// @notice Exercise the *purpose* of `__gap`: a real upgrade that
    ///         introduces new state in the child impl must (a) not collide
    ///         with any pre-upgrade state and (b) be readable + writable
    ///         through the proxy after the swap.
    ///
    /// @dev    `test_storageGap_isZeroedOnFreshProxy` only confirms the gap
    ///         starts empty. This test goes further: deploy v1.0 -> plant
    ///         state -> upgrade to a v1.2 mock that adds a new mapping
    ///         (`postCountByPoster`) -> assert pre-upgrade state survives
    ///         AND the new field works via the proxy. This is what the
    ///         gap exists for, and the test guards against future regressions
    ///         (e.g. an upgrade author forgetting to shrink the gap or
    ///         appending new state above it).
    function test_upgradeWithNewState_preservesPriorStateAndAddsNewField() public {
        // Stand up v1.0 behind the timelocked proxy.
        (ThatsRekt reg, TimelockController timelock) = _deployTimelockedProxy();

        // Whitelist a poster + voter so we can plant state to read back later.
        address poster = makeAddr("poster_v1_2");
        address voter = makeAddr("voter_v1_2");
        address attackerAddr = makeAddr("attacker_v1_2");
        _whitelistViaTimelock(reg, timelock, poster);
        _whitelistViaTimelock(reg, timelock, voter);

        // Plant a post + an upConfirm so attackerScore > 0 and postCount == 1.
        address[] memory atks = new address[](1);
        atks[0] = attackerAddr;
        address[] memory vics = new address[](0);
        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(poster);
        uint256 postId = reg.post(_expectedPid, "test title", atks, vics, "pre-v1.2-upgrade", uint64(block.timestamp));

        vm.prank(voter);
        reg.confirm(postId, ThatsRekt.ConfirmDirection.Up);

        // Snapshot pre-upgrade state.
        PostSnapshot memory pre = _snapshotPost(reg, postId);
        int256 preScore = reg.attackerScore(attackerAddr);
        uint256 prePostCount = reg.postCount();
        assertEq(prePostCount, 1, "sanity: postCount==1 pre-upgrade");
        assertEq(preScore, int256(1), "sanity: attackerScore==1 pre-upgrade");

        // Upgrade to v1.2 (adds `postCountByPoster` mapping by claiming one
        // slot from `__gap`). Use the standard timelocked path.
        ThatsRektV1_2Mock newImpl = new ThatsRektV1_2Mock();
        bytes memory upgradeCall = abi.encodeCall(reg.upgradeToAndCall, (address(newImpl), ""));
        _scheduleAndExecute(timelock, address(reg), upgradeCall);

        // 1. Pre-upgrade state preserved through the proxy.
        PostSnapshot memory post_ = _snapshotPost(reg, postId);
        assertEq(post_.poster, pre.poster, "post.poster preserved");
        assertEq(post_.upConfirms, pre.upConfirms, "post.upConfirms preserved");
        assertEq(post_.downConfirms, pre.downConfirms, "post.downConfirms preserved");
        assertEq(post_.removed, pre.removed, "post.removed preserved");
        assertEq(post_.attackedAt, pre.attackedAt, "post.attackedAt preserved");
        assertEq(post_.lastUpdatedAt, pre.lastUpdatedAt, "post.lastUpdatedAt preserved");
        assertEq(reg.attackerScore(attackerAddr), preScore, "attackerScore preserved");
        assertEq(reg.postCount(), prePostCount, "postCount preserved");

        // 2. New field starts at zero (the gap slot was never written before
        //    the upgrade, so the "no collision" property is observable).
        ThatsRektV1_2Mock proxied = ThatsRektV1_2Mock(address(reg));
        assertEq(proxied.postCountByPoster(poster), 0, "new field starts at zero");

        // 3. New field is functional through the proxy: write then read.
        proxied.bumpPosterCount(poster);
        assertEq(proxied.postCountByPoster(poster), 1, "new field writable via proxy");

        // 4. Pre-existing state is still mutable via the proxy too — confirm
        //    by retracting the original post and checking aggregates reverse.
        vm.prank(poster);
        proxied.retract(postId);
        assertEq(proxied.attackerScore(attackerAddr), 0, "post-upgrade retract reverses score");
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _snapshotPost(ThatsRekt reg, uint256 postId) internal view returns (PostSnapshot memory s) {
        (
            address poster,
            uint64 attackedAt,
            uint32 upConfirms,
            uint32 downConfirms,
            bool removed,
            ,
            ,
            uint64 lastUpdatedAt
        ) = reg.getPost(postId);
        s = PostSnapshot({
            poster: poster,
            attackedAt: attackedAt,
            upConfirms: upConfirms,
            downConfirms: downConfirms,
            removed: removed,
            lastUpdatedAt: lastUpdatedAt
        });
    }

    function _deployProxied(address owner_) internal returns (ThatsRekt) {
        // Single principal wears all five hats for these upgrade-flow tests.
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (owner_, owner_, owner_, owner_, owner_, new address[](0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
        return ThatsRekt(address(proxy));
    }

    function _deployTimelockedProxy() internal returns (ThatsRekt reg, TimelockController timelock) {
        // Mirror Deploy.s.sol but collapse the three TLCs into one for these
        // upgrade-focused tests — we only exercise the upgrade path here,
        // and a single 7-day TLC is enough to model that. Multisig is
        // the proposer/executor; admin = address(0) for parity with prod.
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));

        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            //   - owner            = timelock       (7-day upgrade)
            //   - whitelistAdmin   = multisig       (instant in test, gated by 3-day TLC in prod)
            //   - whitelistRemover = multisig       (instant)
            //   - purgeAdmin       = multisig       (instant in test, gated by 1-day TLC in prod)
            //   - purgeRemover     = multisig       (instant)
            (address(timelock), multisig, multisig, multisig, multisig, new address[](0))
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
        reg = ThatsRekt(address(proxy));

        // Sanity: proxy is owned by the timelock; admin + remover are multisig.
        assertEq(reg.owner(), address(timelock));
        assertEq(reg.whitelistAdmin(), multisig);
        assertEq(reg.whitelistRemover(), multisig);
    }

    /// @dev Schedule a single call from the timelock to `target`, warp past
    ///      the delay, and execute it. Caller is the multisig (the only
    ///      proposer + executor in this setup).
    function _scheduleAndExecute(
        TimelockController timelock,
        address target,
        bytes memory data
    ) internal {
        vm.prank(multisig);
        timelock.schedule(target, 0, data, bytes32(0), OP_SALT, TIMELOCK_DELAY);

        vm.warp(block.timestamp + TIMELOCK_DELAY + 1);

        vm.prank(multisig);
        timelock.execute(target, 0, data, bytes32(0), OP_SALT);
    }

    /// @dev Whitelisting is now whitelistAdmin-gated, not owner-gated, so
    ///      it's a direct call from the multisig — no timelock dance.
    ///      Helper kept under its old name for call-site compatibility.
    function _whitelistViaTimelock(
        ThatsRekt reg,
        TimelockController /* timelock — unused now */,
        address account
    ) internal {
        vm.prank(multisig);
        reg.addWhitelisted(account);
    }
}
