// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";

contract ThatsRektTest is Test {
    ThatsRekt public reg;
    address public governance;
    address public alice;
    address public bob;
    address public carol;
    address public dave;

    function setUp() public virtual {
        governance = makeAddr("governance");
        reg = _deployProxied(governance);
        alice = makeAddr("alice");
        bob   = makeAddr("bob");
        carol = makeAddr("carol");
        dave  = makeAddr("dave");
    }

    /// @dev Deploys a fresh impl + ERC1967Proxy initialized so that
    ///      `owner_` simultaneously holds owner, whitelistAdmin, AND
    ///      whitelistRemover. In production these are three distinct
    ///      principals (7-day TLC, 3-day TLC, multisig) but for the
    ///      per-feature unit tests it's simpler to have one address
    ///      wear all three hats. Tests that exercise the three-role
    ///      separation explicitly use `_deployProxiedRoles` below.
    function _deployProxied(address owner_) internal returns (ThatsRekt) {
        return _deployProxiedRoles(owner_, owner_, owner_, _emptyList());
    }

    function _deployProxiedRoles(
        address owner_,
        address whitelistAdmin_,
        address whitelistRemover_,
        address[] memory initialWhitelisters_
    ) internal returns (ThatsRekt) {
        // Default: purgeAdmin = purgeRemover = owner_, mirroring the
        // single-principal pattern this helper already uses for the
        // other roles. Tests that exercise purge-specific access
        // control can deploy via `_deployProxiedRolesWithPurge` and
        // pass distinct addresses.
        return _deployProxiedRolesWithPurge(
            owner_, whitelistAdmin_, whitelistRemover_, owner_, owner_, initialWhitelisters_
        );
    }

    function _deployProxiedRolesWithPurge(
        address owner_,
        address whitelistAdmin_,
        address whitelistRemover_,
        address purgeAdmin_,
        address purgeRemover_,
        address[] memory initialWhitelisters_
    ) internal returns (ThatsRekt) {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (owner_, whitelistAdmin_, whitelistRemover_, purgeAdmin_, purgeRemover_, initialWhitelisters_)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
        return ThatsRekt(address(proxy));
    }

    /// @dev Helper for tests that don't pre-populate the whitelist.
    function _emptyList() internal pure returns (address[] memory) {
        return new address[](0);
    }

    /// helper - whitelist via owner prank (governance = admin in default setup)
    function _whitelist(address a) internal {
        vm.prank(governance);
        reg.addWhitelisted(a);
    }

    /// helper - create a basic post with at most one attacker and/or one victim.
    /// attackedAt defaults to the current block timestamp (attack and post in the same block).
    function _post(address poster, address atk0, address vic0) internal returns (uint256 id) {
        address[] memory atk = new address[](atk0 == address(0) ? 0 : 1);
        address[] memory vic = new address[](vic0 == address(0) ? 0 : 1);
        if (atk0 != address(0)) atk[0] = atk0;
        if (vic0 != address(0)) vic[0] = vic0;
        // Resolve peekNextPostId() BEFORE pranking — `vm.prank` only spans
        // the next external call, and `peekNextPostId()` IS an external call.
        // If we put the peek inside the post() args, the prank gets consumed
        // by the view and the actual post() runs from the default test
        // sender (which isn't whitelisted), reverting NotWhitelisted.
        uint256 expected = reg.peekNextPostId();
        vm.prank(poster);
        id = reg.post(expected, "test title", atk, vic, "", uint64(block.timestamp));
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE 2 - WHITELIST
    //////////////////////////////////////////////////////////////*/

    function test_owner_can_addWhitelisted() public {
        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.WhitelistUpdated(alice, true);

        vm.prank(governance);
        reg.addWhitelisted(alice);

        assertTrue(reg.isWhitelisted(alice));
    }

    function test_owner_can_removeWhitelisted() public {
        _whitelist(alice);
        assertTrue(reg.isWhitelisted(alice));

        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.WhitelistUpdated(alice, false);

        vm.prank(governance);
        reg.removeWhitelisted(alice);

        assertFalse(reg.isWhitelisted(alice));
    }

    function test_nonOwner_cannot_addWhitelisted() public {
        vm.expectRevert();
        vm.prank(alice);
        reg.addWhitelisted(bob);
    }

    function test_nonOwner_cannot_removeWhitelisted() public {
        _whitelist(bob);
        vm.expectRevert();
        vm.prank(alice);
        reg.removeWhitelisted(bob);
    }

    /*//////////////////////////////////////////////////////////////
                            PHASE 3 - post()
    //////////////////////////////////////////////////////////////*/

    function test_post_returnsId1_onFirstPost() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "exploit on bob's vault", uint64(block.timestamp));

        assertEq(id, 1);
        assertEq(reg.postCount(), 1);
    }

    function test_post_emitsPostCreated() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](1); vic[0] = carol;

        // warp forward so attackedAt = (now - 1 hour) is a valid past time.
        vm.warp(10_000_000);
        uint64 attacked = uint64(block.timestamp - 1 hours);

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.PostCreated(1, alice, attacked, "test title", atk, vic, "rekt");

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "rekt", attacked);
    }

    function test_post_storesFields() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = carol;
        address[] memory vic = new address[](1); vic[0] = dave;

        vm.warp(123_456_789);
        // attackedAt deliberately distinct from block.timestamp to prove the
        // stored value is the poster-supplied one, not the block timestamp.
        uint64 attacked = uint64(123_456_700);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", attacked);

        (
            address poster,
            uint64 attackedAt,
            uint32 up,
            uint32 down,
            bool removed,
            address[] memory storedAtk,
            address[] memory storedVic,
            /* uint64 lastUpdatedAt */
        ) = reg.getPost(id);

        assertEq(poster, alice);
        assertEq(attackedAt, attacked);
        assertEq(up, 0);
        assertEq(down, 0);
        assertFalse(removed);
        assertEq(storedAtk.length, 2);
        assertEq(storedAtk[0], bob);
        assertEq(storedAtk[1], carol);
        assertEq(storedVic.length, 1);
        assertEq(storedVic[0], dave);
    }

    function test_post_onlyWhitelisted() public {
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "no auth", uint64(block.timestamp));
    }

    /// @dev v1.1 dropped the legacy `EmptyPost` check — title is now
    ///      required, so a post is structurally never "empty" content.
    ///      A title-only post (no addresses, no note) is a valid headline
    ///      alert. The required-title path is asserted via the
    ///      `test_post_revertsIfTitleEmpty` test below.
    function test_post_titleOnly_isValid() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "Aave drainer detected", atk, vic, "", uint64(block.timestamp));
        assertEq(reg.postTitle(id), "Aave drainer detected");
    }

    function test_post_acceptsNoteOnly() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "Twitter says protocol X is being drained", uint64(block.timestamp));
        assertEq(id, 1);
    }

    function test_post_revertsIfTooLarge() public {
        _whitelist(alice);
        uint256 cap = reg.MAX_ADDRESSES_PER_POST();
        address[] memory atk = new address[](cap + 1);
        for (uint256 i; i < cap + 1; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.PostTooLarge.selector);
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));
    }

    function test_post_acceptsExactlyCap() public {
        _whitelist(alice);
        uint256 cap = reg.MAX_ADDRESSES_PER_POST();
        address[] memory atk = new address[](cap);
        for (uint256 i; i < cap; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));
    }

    /// v1: cap bumped from 32 -> 100. Pin the new value explicitly so
    /// any future change is a deliberate test update.
    function test_post_maxAddressesPerPostIs100() public view {
        assertEq(reg.MAX_ADDRESSES_PER_POST(), 100);
    }

    /// v1: 101 attackers must revert; 100 attackers must succeed.
    function test_post_revertsAt101Attackers() public {
        _whitelist(alice);
        address[] memory atk = new address[](101);
        for (uint256 i; i < 101; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.PostTooLarge.selector);
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));
    }

    function test_post_acceptsExactly100Attackers() public {
        _whitelist(alice);
        address[] memory atk = new address[](100);
        for (uint256 i; i < 100; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));
    }

    /*//////////////////////////////////////////////////////////////
              PHASE 3.6 - lastUpdatedAt (v1 edit primitive)
    //////////////////////////////////////////////////////////////*/

    /// `lastUpdatedAt` is initialized to `block.timestamp` at post creation.
    /// It is the freshness signal that `amendNote` / `addAttackers` /
    /// `addVictims` will bump in subsequent commits.
    function test_post_lastUpdatedAtEqualsBlockTimestampAtCreation() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.warp(1_700_000_000);
        // attackedAt explicitly < block.timestamp so the two values are
        // distinct in the assertions below.
        uint64 attacked = uint64(1_699_999_000);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", attacked);

        (, , , , , , , uint64 lastUpdatedAt) = reg.getPost(id);
        assertEq(lastUpdatedAt, uint64(1_700_000_000));
    }

    /*//////////////////////////////////////////////////////////////
                  PHASE 3.5 - attackedAt VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_post_revertsIfAttackedAtZero() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.InvalidAttackedAt.selector);
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", 0);
    }

    function test_post_revertsIfAttackedAtInFuture() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        // any value strictly greater than block.timestamp is a future claim
        uint64 future = uint64(block.timestamp + 1);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.InvalidAttackedAt.selector);
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", future);
    }

    function test_post_acceptsAttackedAtEqualToBlockTimestamp() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));
        assertEq(id, 1);
    }

    function test_post_acceptsAncientAttackedAt() public {
        // attackedAt = 1 (very old, but valid: > 0 and <= block.timestamp).
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.warp(1_000_000);
        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", 1);
        assertEq(id, 1);

        (, uint64 attackedAt, , , , , , ) = reg.getPost(id);
        assertEq(attackedAt, 1);
    }

    function test_getPost_returnsAttackedAtVerbatim() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.warp(2_000_000);
        uint64 attacked = uint64(1_999_500);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", attacked);

        (, uint64 stored, , , , , , ) = reg.getPost(id);
        assertEq(stored, attacked);
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 4 - AGGREGATES
    //////////////////////////////////////////////////////////////*/

    function test_post_incrementsAttackerAppearances() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = carol;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));

        assertEq(reg.attackerAppearances(bob), 1);
        assertEq(reg.attackerAppearances(carol), 1);
        assertEq(reg.attackerScore(bob), 0);
    }

    function test_post_duplicateAttackers_doubleCount() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = bob;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));

        assertEq(reg.attackerAppearances(bob), 2);
    }

    function test_post_setsIsVictimTrue() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](1); vic[0] = bob;

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));

        assertTrue(reg.isVictim(bob));
    }

    function test_post_isVictim_remainsTrueAcrossMultiplePosts() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](1); vic[0] = bob;

        vm.startPrank(alice);
        reg.post(reg.peekNextPostId(), "test title", atk, vic, "", uint64(block.timestamp));
        reg.post(reg.peekNextPostId(), "test title", atk, vic, "", uint64(block.timestamp));
        vm.stopPrank();

        assertTrue(reg.isVictim(bob));
    }

    /*//////////////////////////////////////////////////////////////
                            PHASE 5 - vote()
    //////////////////////////////////////////////////////////////*/

    function test_confirm_revertsOnPostNotFound() public {
        _whitelist(alice);
        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.confirm(99, ThatsRekt.ConfirmDirection.Up);
    }

    function test_confirm_posterCannotConfirmOwnPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.PosterCannotConfirm.selector);
        vm.prank(alice);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
    }

    function test_confirm_revertsIfSameDirection() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        vm.expectRevert(ThatsRekt.NoConfirmationChange.selector);
        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
    }

    function test_confirm_revertsOnNoneDirection() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.InvalidConfirmDirection.selector);
        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.None);
    }

    function test_confirm_onlyWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
    }

    function test_confirm_upConfirm_incrementsCounters() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        (, , uint32 up, uint32 down, , , , ) = reg.getPost(id);
        assertEq(up, 1);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 1);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.Up);
    }

    function test_confirm_downConfirm_incrementsCounters() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);

        (, , uint32 up, uint32 down, , , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 1);
        assertEq(reg.attackerScore(carol), -1);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.Down);
    }

    function test_confirm_flip_upToDown() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 1);
        assertEq(reg.attackerScore(carol), -1);
    }

    /// The Confirmed event now emits ConfirmDirection (uint8 in the ABI) for both
    /// the old and new direction — None=0, UpConfirm=1, DownConfirm=2.
    function test_confirm_emitsConfirmedWithOldAndNew() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.Confirmed(
            id,
            bob,
            ThatsRekt.ConfirmDirection.None,
            ThatsRekt.ConfirmDirection.Up
        );
        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
    }

    function test_confirm_multipleConfirmers_aggregateScore() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        uint256 id = _post(alice, dave, address(0));

        vm.prank(bob);   reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        vm.prank(carol); reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        assertEq(reg.attackerScore(dave), 2);
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE 5.5 - unvote()
    //////////////////////////////////////////////////////////////*/

    function test_unconfirm_clearsConfirmationAndReversesAggregates() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        // baseline pre-unvote: score == +1, up == 1
        assertEq(reg.attackerScore(carol), 1);
        reg.unconfirm(id);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.None);
    }

    function test_unconfirm_clearsDownConfirmAndReversesAggregates() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        assertEq(reg.attackerScore(carol), -1);
        reg.unconfirm(id);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.None);
    }

    function test_unconfirm_revertsIfNoConfirmationExists() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NothingToUnconfirm.selector);
        vm.prank(bob);
        reg.unconfirm(id);
    }

    function test_unconfirm_revertsForNonWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(bob);
        reg.unconfirm(id);
    }

    function test_unconfirm_revertsOnNonExistentPost() public {
        _whitelist(alice);

        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.unconfirm(99);
    }

    function test_unconfirm_revertsOnRemovedPost() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        // bob votes, alice retracts the post, bob then tries to unvote
        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        vm.prank(alice);
        reg.retract(id);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(bob);
        reg.unconfirm(id);
    }

    function test_confirmFlow_confirmUpThenUnconfirmThenConfirmDown() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);

        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        (, , uint32 up1, uint32 down1, , , , ) = reg.getPost(id);
        assertEq(up1, 1);
        assertEq(down1, 0);
        assertEq(reg.attackerScore(carol), 1);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.Up);

        reg.unconfirm(id);
        (, , uint32 up2, uint32 down2, , , , ) = reg.getPost(id);
        assertEq(up2, 0);
        assertEq(down2, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.None);

        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        (, , uint32 up3, uint32 down3, , , , ) = reg.getPost(id);
        assertEq(up3, 0);
        assertEq(down3, 1);
        assertEq(reg.attackerScore(carol), -1);
        assertTrue(reg.confirmationOf(id, bob) == ThatsRekt.ConfirmDirection.Down);

        vm.stopPrank();
    }

    function test_unconfirm_emitsConfirmedWithNoneTransition() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.Confirmed(
            id,
            bob,
            ThatsRekt.ConfirmDirection.Up,
            ThatsRekt.ConfirmDirection.None
        );
        vm.prank(bob);
        reg.unconfirm(id);
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 6 - NO AUTO REMOVAL
    //////////////////////////////////////////////////////////////*/

    /// Heavily-downConfirmd posts must NOT be auto-removed. Consumers that want
    /// to gate on community sentiment should read `attackerScore` and pick
    /// their own threshold. Removal is now poster-driven only (retract).
    function test_heavilyDownConfirmdPost_isNotAutoRemoved() public {
        _whitelist(alice);
        address attacker = makeAddr("attacker");
        uint256 id = _post(alice, attacker, address(0));

        // 10 voters, all downvoting -> net score -10 but post stays active.
        for (uint256 i; i < 10; ++i) {
            address voter = address(uint160(uint256(0xD000) + i));
            _whitelist(voter);
            vm.prank(voter);
            reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        }

        (, , uint32 up, uint32 down, bool removed, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 10);
        assertFalse(removed, "post must NOT be auto-removed by downConfirms");

        // post is still in the active linked list (head == tail == id)
        assertEq(reg.headPostId(), id);
        assertEq(reg.tailPostId(), id);

        // attackerScore reflects negative sentiment, post stays alive
        assertEq(reg.attackerScore(attacker), -10);
        assertEq(reg.attackerAppearances(attacker), 1);
    }

    /// After a post is retracted (removed), further votes must revert.
    /// Removal is now poster-only (no auto-removal); the path under test
    /// here is retract() -> subsequent vote() -> PostIsRemoved.
    function test_confirmOnRemovedPost_reverts() public {
        _whitelist(alice);
        uint256 id = _post(alice, makeAddr("attacker"), address(0));

        vm.prank(alice);
        reg.retract(id);

        address eve = makeAddr("eve");
        _whitelist(eve);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(eve);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE 7 - retract()
    //////////////////////////////////////////////////////////////*/

    function test_retract_byPoster() public {
        _whitelist(alice);
        address attacker = makeAddr("attacker");
        uint256 id = _post(alice, attacker, address(0));

        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.PostRemoved(id, ThatsRekt.RemovalReason.Retracted);

        vm.prank(alice);
        reg.retract(id);

        (, , , , bool removed, , , ) = reg.getPost(id);
        assertTrue(removed);
        assertEq(reg.attackerAppearances(attacker), 0);
    }

    function test_retract_revertsIfNotPoster() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotPoster.selector);
        vm.prank(bob);
        reg.retract(id);
    }

    function test_retract_revertsIfAlreadyRemoved() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(alice);
        reg.retract(id);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(alice);
        reg.retract(id);
    }

    function test_retract_worksEvenIfPosterDeWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(governance);
        reg.removeWhitelisted(alice);

        vm.prank(alice);
        reg.retract(id);

        (, , , , bool removed, , , ) = reg.getPost(id);
        assertTrue(removed);
    }

    function test_retract_revertsIfPostNotFound() public {
        _whitelist(alice);
        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.retract(99);
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 8 - LINKED LIST
    //////////////////////////////////////////////////////////////*/

    function test_linkedList_emptyAtStart() public view {
        assertEq(reg.headPostId(), 0);
        assertEq(reg.tailPostId(), 0);
    }

    function test_linkedList_singlePost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        assertEq(reg.headPostId(), id);
        assertEq(reg.tailPostId(), id);
        assertEq(reg.prevPostId(id), 0);
        assertEq(reg.nextPostId(id), 0);
    }

    function test_linkedList_threePosts_creationOrder() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));
        uint256 id3 = _post(alice, makeAddr("a3"), address(0));

        assertEq(reg.headPostId(), id1);
        assertEq(reg.tailPostId(), id3);
        assertEq(reg.nextPostId(id1), id2);
        assertEq(reg.nextPostId(id2), id3);
        assertEq(reg.prevPostId(id3), id2);
        assertEq(reg.prevPostId(id2), id1);
    }

    function test_linkedList_removeHead() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));

        vm.prank(alice);
        reg.retract(id1);

        assertEq(reg.headPostId(), id2);
        assertEq(reg.tailPostId(), id2);
        assertEq(reg.prevPostId(id2), 0);
        assertEq(reg.nextPostId(id1), 0);
        assertEq(reg.prevPostId(id1), 0);
    }

    function test_linkedList_removeTail() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));

        vm.prank(alice);
        reg.retract(id2);

        assertEq(reg.headPostId(), id1);
        assertEq(reg.tailPostId(), id1);
        assertEq(reg.nextPostId(id1), 0);
    }

    function test_linkedList_removeMiddle() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));
        uint256 id3 = _post(alice, makeAddr("a3"), address(0));

        vm.prank(alice);
        reg.retract(id2);

        assertEq(reg.headPostId(), id1);
        assertEq(reg.tailPostId(), id3);
        assertEq(reg.nextPostId(id1), id3);
        assertEq(reg.prevPostId(id3), id1);
    }

    function test_linkedList_removeAll() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));

        vm.startPrank(alice);
        reg.retract(id1);
        reg.retract(id2);
        vm.stopPrank();

        assertEq(reg.headPostId(), 0);
        assertEq(reg.tailPostId(), 0);
    }

    /*//////////////////////////////////////////////////////////////
                        PHASE 9 - VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    function test_attackerReport_returnsScoreAndAppearances() public {
        _whitelist(alice);
        _whitelist(bob);
        address atk = makeAddr("attacker");
        uint256 id = _post(alice, atk, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        (int256 score, uint256 appearances) = reg.attackerReport(atk);
        assertEq(score, 1);
        assertEq(appearances, 1);
    }

    function test_recentActivePosts_walksTailBackward() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));
        uint256 id3 = _post(alice, makeAddr("a3"), address(0));

        uint256[] memory recent = reg.recentActivePosts(10);
        assertEq(recent.length, 3);
        assertEq(recent[0], id3);
        assertEq(recent[1], id2);
        assertEq(recent[2], id1);
    }

    function test_recentActivePosts_respectsLimit() public {
        _whitelist(alice);
        _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));
        uint256 id3 = _post(alice, makeAddr("a3"), address(0));

        uint256[] memory recent = reg.recentActivePosts(2);
        assertEq(recent.length, 2);
        assertEq(recent[0], id3);
        assertEq(recent[1], id2);
    }

    function test_recentActivePosts_capsAtMaxView() public {
        _whitelist(alice);
        for (uint256 i; i < 150; ++i) {
            _post(alice, address(uint160(0x1000 + i)), address(0));
        }
        uint256[] memory recent = reg.recentActivePosts(200);
        assertEq(recent.length, reg.MAX_VIEW_LIMIT());
    }

    function test_recentActivePosts_skipsRemoved() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));
        uint256 id3 = _post(alice, makeAddr("a3"), address(0));

        vm.prank(alice);
        reg.retract(id2);

        uint256[] memory recent = reg.recentActivePosts(10);
        assertEq(recent.length, 2);
        assertEq(recent[0], id3);
        assertEq(recent[1], id1);
    }

    function test_activePostsBefore_paginates() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        uint256 id2 = _post(alice, makeAddr("a2"), address(0));
        uint256 id3 = _post(alice, makeAddr("a3"), address(0));

        uint256[] memory page = reg.activePostsBefore(id3, 10);
        assertEq(page.length, 2);
        assertEq(page[0], id2);
        assertEq(page[1], id1);
    }

    function test_activePostsBefore_revertsIfRemoved() public {
        _whitelist(alice);
        uint256 id1 = _post(alice, makeAddr("a1"), address(0));
        vm.prank(alice);
        reg.retract(id1);

        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        reg.activePostsBefore(id1, 10);
    }

    /*//////////////////////////////////////////////////////////////
                  PHASE 9.5 - ENUMERABLE VOTER SETS
    //////////////////////////////////////////////////////////////*/

    function test_getConfirmers_emptyForFreshPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        address[] memory ups   = reg.getConfirmers(id);
        address[] memory downs = reg.getDisconfirmers(id);
        assertEq(ups.length, 0);
        assertEq(downs.length, 0);
        assertEq(reg.getConfirmerCount(id), 0);
        assertEq(reg.getDisconfirmerCount(id), 0);
    }

    function test_getConfirmers_returnsExactSet_afterMixedVoting() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        // 3 upConfirmrs, 2 downConfirmrs, then one upConfirmr flips to downConfirm.
        // Final tally: 2 upConfirmrs (u2, u3) and 3 downConfirmrs (d1, d2, u1).
        address u1 = makeAddr("u1");
        address u2 = makeAddr("u2");
        address u3 = makeAddr("u3");
        address d1 = makeAddr("d1");
        address d2 = makeAddr("d2");

        _whitelist(u1); _whitelist(u2); _whitelist(u3);
        _whitelist(d1); _whitelist(d2);

        vm.prank(u1); reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        vm.prank(u2); reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        vm.prank(u3); reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        vm.prank(d1); reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        vm.prank(d2); reg.confirm(id, ThatsRekt.ConfirmDirection.Down);

        // u1 flips up -> down
        vm.prank(u1); reg.confirm(id, ThatsRekt.ConfirmDirection.Down);

        address[] memory ups   = reg.getConfirmers(id);
        address[] memory downs = reg.getDisconfirmers(id);

        assertEq(ups.length,   2);
        assertEq(downs.length, 3);
        assertEq(reg.getConfirmerCount(id),   2);
        assertEq(reg.getDisconfirmerCount(id), 3);

        assertTrue(_contains(ups, u2));
        assertTrue(_contains(ups, u3));
        assertFalse(_contains(ups, u1));

        assertTrue(_contains(downs, d1));
        assertTrue(_contains(downs, d2));
        assertTrue(_contains(downs, u1));
    }

    function test_confirmerSets_consistentAfterUnconfirm() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        address[] memory ups = reg.getConfirmers(id);
        assertEq(ups.length, 1);
        assertEq(ups[0], bob);

        vm.prank(bob);
        reg.unconfirm(id);

        ups = reg.getConfirmers(id);
        assertEq(ups.length, 0);
        assertEq(reg.getConfirmerCount(id), 0);
    }

    function test_confirmerSets_consistentAfterDownConfirmUnvote() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);

        address[] memory downs = reg.getDisconfirmers(id);
        assertEq(downs.length, 1);
        assertEq(downs[0], bob);

        vm.prank(bob);
        reg.unconfirm(id);

        downs = reg.getDisconfirmers(id);
        assertEq(downs.length, 0);
        assertEq(reg.getDisconfirmerCount(id), 0);
    }

    function test_confirmerSets_consistentAfterFlip() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        vm.stopPrank();

        address[] memory ups   = reg.getConfirmers(id);
        address[] memory downs = reg.getDisconfirmers(id);
        assertEq(ups.length,   0);
        assertEq(downs.length, 1);
        assertEq(downs[0], bob);
    }

    function test_confirmerSets_consistentAfterDownToUpFlip() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        vm.stopPrank();

        address[] memory ups   = reg.getConfirmers(id);
        address[] memory downs = reg.getDisconfirmers(id);
        assertEq(ups.length,   1);
        assertEq(downs.length, 0);
        assertEq(ups[0], bob);
    }

    function test_getConfirmerCount_matchesArrayLength() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        // 4 distinct upConfirmrs
        for (uint256 i; i < 4; ++i) {
            address voter = address(uint160(0xE000 + i));
            _whitelist(voter);
            vm.prank(voter);
            reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        }

        assertEq(reg.getConfirmerCount(id), reg.getConfirmers(id).length);
        assertEq(reg.getConfirmerCount(id), 4);
    }

    function _contains(address[] memory arr, address needle) internal pure returns (bool) {
        for (uint256 i; i < arr.length; ++i) {
            if (arr[i] == needle) return true;
        }
        return false;
    }

    /*//////////////////////////////////////////////////////////////
                     PHASE 11 - OWNERSHIP / GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function test_initialize_setsInitialOwner() public {
        address newOwner = makeAddr("newOwner");
        ThatsRekt fresh = _deployProxied(newOwner);
        assertEq(fresh.owner(), newOwner);
    }

    function test_initialize_setsInitialWhitelistAdmin() public {
        address ownerAddr = makeAddr("owner");
        address adminAddr = makeAddr("admin");
        address removerAddr = makeAddr("remover");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());
        assertEq(fresh.whitelistAdmin(), adminAddr);
    }

    function test_initialize_setsInitialWhitelistRemover() public {
        address ownerAddr = makeAddr("owner");
        address adminAddr = makeAddr("admin");
        address removerAddr = makeAddr("remover");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());
        assertEq(fresh.whitelistRemover(), removerAddr);
    }

    function test_initialize_revertsOnZeroOwner() public {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (address(0), makeAddr("admin"), makeAddr("remover"), makeAddr("purger"), makeAddr("purgeRem"), _emptyList())
        );
        // OwnableInvalidOwner(address(0)) from OwnableUpgradeable.
        vm.expectRevert();
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_initialize_revertsOnZeroWhitelistAdmin() public {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (makeAddr("owner"), address(0), makeAddr("remover"), makeAddr("purger"), makeAddr("purgeRem"), _emptyList())
        );
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_initialize_revertsOnZeroWhitelistRemover() public {
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (makeAddr("owner"), makeAddr("admin"), address(0), makeAddr("purger"), makeAddr("purgeRem"), _emptyList())
        );
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_initialize_revertsOnZeroPurgeRemover() public {
        // initialPurgeRemover IS required even when purgeAdmin is zero —
        // losing the kill-switch slot at init means the day someone
        // re-installs a purgeAdmin via the 7-day path, there's no
        // instant kill-switch in place. Reject zero unconditionally.
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (makeAddr("owner"), makeAddr("admin"), makeAddr("remover"), makeAddr("purger"), address(0), _emptyList())
        );
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    function test_initialize_zeroPurgeAdmin_isAllowed() public {
        // initialPurgeAdmin == address(0) is supported — it deploys with
        // purge disabled. Owner can install one later via setPurgeAdmin.
        // initialPurgeRemover MUST still be non-zero so the kill-switch
        // is in place for the day a purgeAdmin gets installed.
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (makeAddr("owner"), makeAddr("admin"), makeAddr("remover"), address(0), makeAddr("purgeRem"), _emptyList())
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
        assertEq(ThatsRekt(address(proxy)).purgeAdmin(), address(0));
        assertEq(ThatsRekt(address(proxy)).purgeRemover(), makeAddr("purgeRem"));
    }

    /*//////////////////////////////////////////////////////////////
              PHASE 11a - INITIAL WHITELIST PRE-POPULATION
    //////////////////////////////////////////////////////////////*/

    function test_initialize_prepopulates_whitelist() public {
        address[] memory initialList = new address[](3);
        initialList[0] = alice;
        initialList[1] = bob;
        initialList[2] = carol;

        // Each entry should emit WhitelistUpdated(addr, true) during init.
        // Order matches the input array.
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (governance, governance, governance, governance, governance, initialList)
        );

        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.WhitelistUpdated(alice, true);
        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.WhitelistUpdated(bob, true);
        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.WhitelistUpdated(carol, true);

        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
        ThatsRekt fresh = ThatsRekt(address(proxy));

        assertTrue(fresh.isWhitelisted(alice));
        assertTrue(fresh.isWhitelisted(bob));
        assertTrue(fresh.isWhitelisted(carol));
        assertFalse(fresh.isWhitelisted(dave), "uninitialized address must not be whitelisted");
    }

    function test_initialize_emptyInitialList_works() public {
        ThatsRekt fresh = _deployProxiedRoles(governance, governance, governance, _emptyList());
        // No revert; just no whitelisted addresses initially.
        assertFalse(fresh.isWhitelisted(alice));
        assertFalse(fresh.isWhitelisted(bob));
    }

    function test_initialize_duplicateInitialList_isIdempotent() public {
        // alice twice in the list — second insert should be a silent no-op
        // (same as `addWhitelisted` semantics for already-listed addrs).
        address[] memory initialList = new address[](3);
        initialList[0] = alice;
        initialList[1] = bob;
        initialList[2] = alice; // duplicate

        // Recorder captures all emitted logs so we can assert exactly two
        // WhitelistUpdated events fire (alice, bob), not three.
        vm.recordLogs();
        ThatsRekt fresh = _deployProxiedRoles(governance, governance, governance, initialList);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("WhitelistUpdated(address,bool)");
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) ++count;
        }
        assertEq(count, 2, "duplicate initial whitelister must not emit twice");

        assertTrue(fresh.isWhitelisted(alice));
        assertTrue(fresh.isWhitelisted(bob));
    }

    function test_initialize_zeroInitialList_reverts() public {
        // address(0) inside the initial list reverts ZeroAddress, even if
        // owner/admin/remover are all valid. This protects against
        // accidentally pre-populating the whitelist with the zero address
        // (which would let any unset-storage caller post).
        address[] memory initialList = new address[](2);
        initialList[0] = alice;
        initialList[1] = address(0);

        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (governance, governance, governance, governance, governance, initialList)
        );
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    /*//////////////////////////////////////////////////////////////
              PHASE 11b - THREE-ROLE GOVERNANCE (split admin/remover)
    //////////////////////////////////////////////////////////////*/

    /// owner alone has neither add nor remove authority.
    function test_threeRole_ownerAlone_cannotAddOrRemove() public {
        address ownerAddr   = makeAddr("ownerOnly");
        address adminAddr   = makeAddr("adminOnly");
        address removerAddr = makeAddr("removerOnly");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        fresh.addWhitelisted(alice);

        // Pre-populate alice through the admin so we can attempt remove.
        vm.prank(adminAddr);
        fresh.addWhitelisted(alice);

        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        fresh.removeWhitelisted(alice);
    }

    /// admin can add but cannot remove (remove is the remover's lane).
    function test_threeRole_admin_cannotRemove() public {
        address ownerAddr   = makeAddr("ownerOnly");
        address adminAddr   = makeAddr("adminOnly");
        address removerAddr = makeAddr("removerOnly");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(adminAddr);
        fresh.addWhitelisted(alice);
        assertTrue(fresh.isWhitelisted(alice));

        vm.prank(adminAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        fresh.removeWhitelisted(alice);

        // alice still whitelisted — the failed remove had no effect.
        assertTrue(fresh.isWhitelisted(alice));
    }

    /// remover can remove but cannot add (add is the admin's lane).
    function test_threeRole_remover_cannotAdd() public {
        address ownerAddr   = makeAddr("ownerOnly");
        address adminAddr   = makeAddr("adminOnly");
        address removerAddr = makeAddr("removerOnly");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(removerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        fresh.addWhitelisted(alice);

        // Pre-populate via admin so we can verify remover can in fact remove.
        vm.prank(adminAddr);
        fresh.addWhitelisted(alice);

        vm.prank(removerAddr);
        fresh.removeWhitelisted(alice);
        assertFalse(fresh.isWhitelisted(alice));
    }

    /*//////////////////////////////////////////////////////////////
              PHASE 11c - setWhitelistAdmin (3-day + 7-day paths)
    //////////////////////////////////////////////////////////////*/

    /// admin self-rotate path: the current whitelistAdmin can replace
    /// itself. In production this is the 3-day TLC scheduling a call.
    function test_setWhitelistAdmin_admin_canSelfRotate() public {
        address ownerAddr = makeAddr("ownerSR");
        address adminAddr = makeAddr("adminSR");
        address newAdmin  = makeAddr("newAdmin");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, ownerAddr, _emptyList());

        vm.prank(adminAddr);
        fresh.setWhitelistAdmin(newAdmin);
        assertEq(fresh.whitelistAdmin(), newAdmin);

        // Old admin can no longer add; new one can.
        vm.prank(adminAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        fresh.addWhitelisted(alice);

        vm.prank(newAdmin);
        fresh.addWhitelisted(alice);
        assertTrue(fresh.isWhitelisted(alice));
    }

    /// owner re-install path: the owner can also call setWhitelistAdmin.
    /// In production this is the 7-day TLC, used after a revoke or as
    /// a fallback if the admin role is bricked.
    function test_setWhitelistAdmin_owner_canRotate() public {
        address ownerAddr = makeAddr("ownerR");
        address adminAddr = makeAddr("adminR");
        address newAdmin  = makeAddr("newAdminR");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, ownerAddr, _emptyList());

        vm.prank(ownerAddr);
        fresh.setWhitelistAdmin(newAdmin);
        assertEq(fresh.whitelistAdmin(), newAdmin);
    }

    /// Random callers (not owner, not admin) cannot rotate.
    function test_setWhitelistAdmin_randomCaller_reverts() public {
        address ownerAddr = makeAddr("ownerRC");
        address adminAddr = makeAddr("adminRC");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, ownerAddr, _emptyList());

        vm.prank(alice);
        vm.expectRevert(ThatsRekt.Unauthorized.selector);
        fresh.setWhitelistAdmin(makeAddr("attempted"));
    }

    /// The remover cannot rotate (only revoke). Important separation —
    /// otherwise the multisig could install hostile admin instantly.
    function test_setWhitelistAdmin_remover_reverts() public {
        address ownerAddr   = makeAddr("ownerRem");
        address adminAddr   = makeAddr("adminRem");
        address removerAddr = makeAddr("removerRem");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(removerAddr);
        vm.expectRevert(ThatsRekt.Unauthorized.selector);
        fresh.setWhitelistAdmin(makeAddr("attempted"));
    }

    function test_setWhitelistAdmin_revertsOnZero() public {
        address ownerAddr = makeAddr("ownerZ");
        address adminAddr = makeAddr("adminZ");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, ownerAddr, _emptyList());

        // Owner path: zero rejected (use revokeWhitelistAdmin for that).
        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        fresh.setWhitelistAdmin(address(0));

        // Admin self-rotate path: zero rejected too.
        vm.prank(adminAddr);
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        fresh.setWhitelistAdmin(address(0));
    }

    function test_setWhitelistAdmin_emitsTransferred() public {
        address ownerAddr = makeAddr("ownerE");
        address adminAddr = makeAddr("adminE");
        address newAdmin  = makeAddr("newAdminE");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, ownerAddr, _emptyList());

        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.WhitelistAdminTransferred(adminAddr, newAdmin);
        vm.prank(ownerAddr);
        fresh.setWhitelistAdmin(newAdmin);
    }

    /*//////////////////////////////////////////////////////////////
                PHASE 11d - revokeWhitelistAdmin (kill switch)
    //////////////////////////////////////////////////////////////*/

    /// Only the whitelistRemover can revoke. Sets slot to address(0).
    function test_revokeWhitelistAdmin_onlyRemover() public {
        address ownerAddr   = makeAddr("ownerK");
        address adminAddr   = makeAddr("adminK");
        address removerAddr = makeAddr("removerK");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        // Owner can't.
        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        fresh.revokeWhitelistAdmin();

        // Admin can't (would be a self-suicide path otherwise).
        vm.prank(adminAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        fresh.revokeWhitelistAdmin();

        // Random EOA can't.
        vm.prank(alice);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        fresh.revokeWhitelistAdmin();

        // Remover can.
        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.WhitelistAdminTransferred(adminAddr, address(0));
        vm.prank(removerAddr);
        fresh.revokeWhitelistAdmin();

        assertEq(fresh.whitelistAdmin(), address(0));
    }

    /// After revoke, addWhitelisted is bricked — no caller can satisfy
    /// `msg.sender == whitelistAdmin` because msg.sender is never zero.
    function test_revokeWhitelistAdmin_blocksAddsByEveryone() public {
        address ownerAddr   = makeAddr("ownerB");
        address adminAddr   = makeAddr("adminB");
        address removerAddr = makeAddr("removerB");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(removerAddr);
        fresh.revokeWhitelistAdmin();

        vm.prank(adminAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        fresh.addWhitelisted(alice);

        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        fresh.addWhitelisted(alice);

        vm.prank(removerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        fresh.addWhitelisted(alice);
    }

    /// After revoke, removes still work — kicking misbehaving posters
    /// doesn't depend on the admin slot. This is the whole point of the
    /// kill switch: stop new additions, keep incident-response live.
    function test_revokeWhitelistAdmin_removesStillWork() public {
        address ownerAddr   = makeAddr("ownerRSW");
        address adminAddr   = makeAddr("adminRSW");
        address removerAddr = makeAddr("removerRSW");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        // Pre-populate alice as a poster.
        vm.prank(adminAddr);
        fresh.addWhitelisted(alice);

        // Revoke admin.
        vm.prank(removerAddr);
        fresh.revokeWhitelistAdmin();

        // alice can still be removed by remover.
        vm.prank(removerAddr);
        fresh.removeWhitelisted(alice);
        assertFalse(fresh.isWhitelisted(alice));
    }

    /// After revoke, only the owner path can re-install the admin slot.
    /// The 3-day self-rotate path is unreachable because no one matches
    /// the (now zero) `whitelistAdmin` slot.
    function test_revokeWhitelistAdmin_ownerCanReinstall() public {
        address ownerAddr   = makeAddr("ownerRE");
        address adminAddr   = makeAddr("adminRE");
        address removerAddr = makeAddr("removerRE");
        address newAdmin    = makeAddr("newAdminRE");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(removerAddr);
        fresh.revokeWhitelistAdmin();
        assertEq(fresh.whitelistAdmin(), address(0));

        // Owner re-installs via the 7-day path.
        vm.prank(ownerAddr);
        fresh.setWhitelistAdmin(newAdmin);
        assertEq(fresh.whitelistAdmin(), newAdmin);

        // New admin can add.
        vm.prank(newAdmin);
        fresh.addWhitelisted(alice);
        assertTrue(fresh.isWhitelisted(alice));
    }

    /*//////////////////////////////////////////////////////////////
                  PHASE 11e - setWhitelistRemover (7-day rotate)
    //////////////////////////////////////////////////////////////*/

    function test_setWhitelistRemover_onlyOwner() public {
        address ownerAddr   = makeAddr("ownerSR2");
        address adminAddr   = makeAddr("adminSR2");
        address removerAddr = makeAddr("removerSR2");
        address newRemover  = makeAddr("newRemoverSR2");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        // Admin can't.
        vm.prank(adminAddr);
        vm.expectRevert();
        fresh.setWhitelistRemover(newRemover);

        // Current remover can't (no self-rotate on the remover slot).
        vm.prank(removerAddr);
        vm.expectRevert();
        fresh.setWhitelistRemover(newRemover);

        // Random EOA can't.
        vm.prank(alice);
        vm.expectRevert();
        fresh.setWhitelistRemover(newRemover);

        // Owner can.
        vm.prank(ownerAddr);
        fresh.setWhitelistRemover(newRemover);
        assertEq(fresh.whitelistRemover(), newRemover);

        // Old remover loses authority.
        vm.prank(adminAddr);
        fresh.addWhitelisted(alice);
        vm.prank(removerAddr);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        fresh.removeWhitelisted(alice);

        // New remover gains it.
        vm.prank(newRemover);
        fresh.removeWhitelisted(alice);
        assertFalse(fresh.isWhitelisted(alice));
    }

    function test_setWhitelistRemover_revertsOnZero() public {
        address ownerAddr   = makeAddr("ownerSR3");
        address adminAddr   = makeAddr("adminSR3");
        address removerAddr = makeAddr("removerSR3");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        fresh.setWhitelistRemover(address(0));
    }

    function test_setWhitelistRemover_emitsTransferred() public {
        address ownerAddr   = makeAddr("ownerSR4");
        address adminAddr   = makeAddr("adminSR4");
        address removerAddr = makeAddr("removerSR4");
        address newRemover  = makeAddr("newRemoverSR4");
        ThatsRekt fresh = _deployProxiedRoles(ownerAddr, adminAddr, removerAddr, _emptyList());

        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.WhitelistRemoverTransferred(removerAddr, newRemover);
        vm.prank(ownerAddr);
        fresh.setWhitelistRemover(newRemover);
    }

    /*//////////////////////////////////////////////////////////////
                  PHASE 11f - Owner two-step transfer
    //////////////////////////////////////////////////////////////*/

    /// Governance (the owner role) is rotated via Ownable2Step's
    /// two-step `transferOwnership` / `acceptOwnership` flow. The
    /// whitelistAdmin and whitelistRemover slots are orthogonal —
    /// they stay with whoever holds them until the new owner
    /// explicitly rotates them. This test exercises the full flow.
    function test_governance_canBeRotated() public {
        address newGov = makeAddr("newGov");

        // 1. current owner proposes the new owner
        vm.prank(governance);
        reg.transferOwnership(newGov);
        assertEq(reg.pendingOwner(), newGov);
        assertEq(reg.owner(), governance);

        // 2. new owner accepts
        vm.prank(newGov);
        reg.acceptOwnership();
        assertEq(reg.owner(), newGov);
        assertEq(reg.pendingOwner(), address(0));

        // 3. new owner does NOT inherit whitelist authority — that's a
        //    separate role. Default test setup has owner == admin ==
        //    remover == governance, so after transferring ownership the
        //    OLD address (governance) still holds admin + remover.
        vm.prank(newGov);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        reg.addWhitelisted(alice);

        vm.prank(newGov);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        reg.removeWhitelisted(alice);

        vm.prank(governance);
        reg.addWhitelisted(alice);
        assertTrue(reg.isWhitelisted(alice));

        // 4. new owner rotates whitelistAdmin to itself via the 7-day
        //    re-install path.
        vm.prank(newGov);
        reg.setWhitelistAdmin(newGov);

        // 5. new owner rotates whitelistRemover to itself via owner-only.
        vm.prank(newGov);
        reg.setWhitelistRemover(newGov);

        // 6. old governance is now fully de-authorized on every slot.
        vm.prank(governance);
        vm.expectRevert(ThatsRekt.NotWhitelistAdmin.selector);
        reg.addWhitelisted(bob);

        vm.prank(governance);
        vm.expectRevert(ThatsRekt.NotWhitelistRemover.selector);
        reg.removeWhitelisted(alice);

        // 7. new owner can now manage the whitelist end-to-end.
        vm.prank(newGov);
        reg.addWhitelisted(bob);
        assertTrue(reg.isWhitelisted(bob));

        vm.prank(newGov);
        reg.removeWhitelisted(alice);
        assertFalse(reg.isWhitelisted(alice));
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE 12 - amendNote()
    //////////////////////////////////////////////////////////////*/

    /// Poster can amend the free-form note. Notes never lived in
    /// storage (event-only design from v0); the only on-chain
    /// side effect is the `lastUpdatedAt` bump.
    function test_amendNote_posterCanAmend() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        // jump forward so lastUpdatedAt strictly differs from creation
        vm.warp(block.timestamp + 1 days);

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.PostNoteAmended(id, alice, "more context: tx 0xdeadbeef");

        vm.prank(alice);
        reg.amendNote(id, "more context: tx 0xdeadbeef");

        (, , , , , , , uint64 lastUpdatedAt) = reg.getPost(id);
        assertEq(lastUpdatedAt, uint64(block.timestamp));
    }

    function test_amendNote_revertsForNonPoster() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotPoster.selector);
        vm.prank(bob);
        reg.amendNote(id, "i didn't write this");
    }

    function test_amendNote_revertsForNonWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        // alice is whitelisted but gets removed; she's no longer
        // allowed to amend — `onlyWhitelisted` fires before `NotPoster`.
        vm.prank(governance);
        reg.removeWhitelisted(alice);

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.amendNote(id, "anything");
    }

    function test_amendNote_revertsOnRemovedPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(alice);
        reg.retract(id);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(alice);
        reg.amendNote(id, "too late");
    }

    function test_amendNote_revertsOnNonExistentPost() public {
        _whitelist(alice);

        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.amendNote(99, "ghost post");
    }

    /// Sequential amends each advance lastUpdatedAt to the new block.timestamp.
    function test_amendNote_lastUpdatedAtAdvances() public {
        _whitelist(alice);

        // create at t = 1_000_000
        vm.warp(1_000_000);
        uint256 id = _post(alice, bob, address(0));

        (, , , , , , , uint64 lu0) = reg.getPost(id);
        assertEq(lu0, uint64(1_000_000));

        // first amend at t = 1_000_500
        vm.warp(1_000_500);
        vm.prank(alice);
        reg.amendNote(id, "amend 1");

        (, , , , , , , uint64 lu1) = reg.getPost(id);
        assertEq(lu1, uint64(1_000_500));

        // second amend at t = 1_001_000
        vm.warp(1_001_000);
        vm.prank(alice);
        reg.amendNote(id, "amend 2");

        (, , , , , , , uint64 lu2) = reg.getPost(id);
        assertEq(lu2, uint64(1_001_000));
    }

    /// Empty-string amendments are allowed by design — the poster may
    /// want to clear context, and the contract has no business
    /// adjudicating note contents.
    function test_amendNote_acceptsEmptyString() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.PostNoteAmended(id, alice, "");

        vm.prank(alice);
        reg.amendNote(id, "");
    }

    /*//////////////////////////////////////////////////////////////
              PHASE 13 - addAttackers() / addVictims()
    //////////////////////////////////////////////////////////////*/

    /*------------------ addAttackers: happy paths ------------------*/

    function test_addAttackers_posterCanAdd() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));
        address newAtk = makeAddr("newAtk");

        // jump forward so lastUpdatedAt strictly differs from creation
        vm.warp(block.timestamp + 1 hours);

        address[] memory adds = new address[](1);
        adds[0] = newAtk;

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.AttackersAdded(id, alice, adds);

        vm.prank(alice);
        reg.addAttackers(id, adds);

        (, , , , , address[] memory attackers, , uint64 lastUpdatedAt) = reg.getPost(id);
        assertEq(attackers.length, 2);
        assertEq(attackers[0], bob);
        assertEq(attackers[1], newAtk);
        assertEq(reg.attackerAppearances(newAtk), 1);
        // no votes yet, so karma inherited == 0
        assertEq(reg.attackerScore(newAtk), 0);
        assertEq(lastUpdatedAt, uint64(block.timestamp));
    }

    function test_addAttackers_batchOf3() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address a1 = makeAddr("atk1");
        address a2 = makeAddr("atk2");
        address a3 = makeAddr("atk3");

        address[] memory adds = new address[](3);
        adds[0] = a1; adds[1] = a2; adds[2] = a3;

        vm.prank(alice);
        reg.addAttackers(id, adds);

        (, , , , , address[] memory attackers, , ) = reg.getPost(id);
        assertEq(attackers.length, 4);
        assertEq(attackers[1], a1);
        assertEq(attackers[2], a2);
        assertEq(attackers[3], a3);

        assertEq(reg.attackerAppearances(a1), 1);
        assertEq(reg.attackerAppearances(a2), 1);
        assertEq(reg.attackerAppearances(a3), 1);
    }

    /// New attackers inherit the post's net karma at the moment of addition.
    /// Post starts with bob attacker, gets net +4 (5 up, 1 down), then
    /// `newAtk` is added -> attackerScore[newAtk] == +4.
    function test_addAttackers_inheritsCurrentKarma() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        // 5 upConfirmrs, 1 downConfirmr -> net +4
        for (uint256 i; i < 5; ++i) {
            address voter = address(uint160(0xC100 + i));
            _whitelist(voter);
            vm.prank(voter);
            reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        }
        address downer = address(uint160(0xC200));
        _whitelist(downer);
        vm.prank(downer);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Down);

        // baseline: bob has karma == +4
        assertEq(reg.attackerScore(bob), 4);

        address newAtk = makeAddr("newAtk");
        address[] memory adds = new address[](1);
        adds[0] = newAtk;

        vm.prank(alice);
        reg.addAttackers(id, adds);

        // newAtk inherits exactly the current net karma
        assertEq(reg.attackerScore(newAtk), 4);
        // and existing attacker karma is untouched
        assertEq(reg.attackerScore(bob), 4);
    }

    /// Net negative case: post with 1 up, 3 down -> net -2; new attacker
    /// inherits -2 (signed math).
    function test_addAttackers_inheritsCurrentKarmaWithMixedVotes() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address u1 = address(uint160(0xC301));
        _whitelist(u1);
        vm.prank(u1);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        for (uint256 i; i < 3; ++i) {
            address d = address(uint160(0xC400 + i));
            _whitelist(d);
            vm.prank(d);
            reg.confirm(id, ThatsRekt.ConfirmDirection.Down);
        }

        assertEq(reg.attackerScore(bob), -2);

        address newAtk = makeAddr("newAtkNeg");
        address[] memory adds = new address[](1);
        adds[0] = newAtk;

        vm.prank(alice);
        reg.addAttackers(id, adds);

        assertEq(reg.attackerScore(newAtk), -2);
    }

    /// After addition, a new attacker moves in lockstep with the existing
    /// attackers — subsequent votes update both uniformly.
    function test_addAttackers_subsequentVotesAffectNewAttacker() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        // 3 upConfirmrs -> net +3
        for (uint256 i; i < 3; ++i) {
            address voter = address(uint160(0xC500 + i));
            _whitelist(voter);
            vm.prank(voter);
            reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        }
        assertEq(reg.attackerScore(bob), 3);

        address newAtk = makeAddr("newAtkLockstep");
        address[] memory adds = new address[](1);
        adds[0] = newAtk;
        vm.prank(alice);
        reg.addAttackers(id, adds);

        assertEq(reg.attackerScore(newAtk), 3);

        // one more upConfirm -> both move to 4
        address late = address(uint160(0xC600));
        _whitelist(late);
        vm.prank(late);
        reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        assertEq(reg.attackerScore(bob), 4);
        assertEq(reg.attackerScore(newAtk), 4);
    }

    /*------------------ addVictims: happy paths ------------------*/

    function test_addVictims_posterCanAdd() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), bob);
        address newVic = makeAddr("newVic");

        vm.warp(block.timestamp + 1 hours);

        address[] memory adds = new address[](1);
        adds[0] = newVic;

        assertFalse(reg.isVictim(newVic));

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.VictimsAdded(id, alice, adds);

        vm.prank(alice);
        reg.addVictims(id, adds);

        (, , , , , , address[] memory victims, uint64 lastUpdatedAt) = reg.getPost(id);
        assertEq(victims.length, 2);
        assertEq(victims[0], bob);
        assertEq(victims[1], newVic);
        assertTrue(reg.isVictim(newVic));
        assertEq(lastUpdatedAt, uint64(block.timestamp));
    }

    function test_addVictims_batchOf3() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), bob);

        address v1 = makeAddr("vic1");
        address v2 = makeAddr("vic2");
        address v3 = makeAddr("vic3");

        address[] memory adds = new address[](3);
        adds[0] = v1; adds[1] = v2; adds[2] = v3;

        vm.prank(alice);
        reg.addVictims(id, adds);

        (, , , , , , address[] memory victims, ) = reg.getPost(id);
        assertEq(victims.length, 4);
        assertTrue(reg.isVictim(v1));
        assertTrue(reg.isVictim(v2));
        assertTrue(reg.isVictim(v3));
    }

    /*------------------ addAttackers: revert paths ------------------*/

    function test_addAttackers_revertsForNonPoster() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.NotPoster.selector);
        vm.prank(bob);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsForNonWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        // alice is the poster but loses whitelist -> NotWhitelisted fires first
        vm.prank(governance);
        reg.removeWhitelisted(alice);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsOnRemovedPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(alice);
        reg.retract(id);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsOnNonExistentPost() public {
        _whitelist(alice);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.addAttackers(99, adds);
    }

    function test_addAttackers_revertsOnEmptyArray() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));
        address[] memory adds = new address[](0);

        vm.expectRevert(ThatsRekt.EmptyAdditions.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsOnDuplicateInExistingAttackers() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address[] memory adds = new address[](1);
        adds[0] = bob; // already in attackers

        vm.expectRevert(ThatsRekt.DuplicateAddress.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsOnDuplicateInVictims() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, carol); // carol is a victim

        address[] memory adds = new address[](1);
        adds[0] = carol; // already in victims of same post

        vm.expectRevert(ThatsRekt.DuplicateAddress.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsOnDuplicateInBatch() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address dup = makeAddr("dupAtk");
        address[] memory adds = new address[](2);
        adds[0] = dup;
        adds[1] = dup;

        vm.expectRevert(ThatsRekt.DuplicateAddress.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    function test_addAttackers_revertsOnZeroAddress() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address[] memory adds = new address[](1);
        adds[0] = address(0);

        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    /// Post is at 99 attackers; adding 2 must revert (would land at 101 > cap).
    function test_addAttackers_revertsOnCapBreached() public {
        _whitelist(alice);

        // initial post with 99 distinct attackers
        address[] memory atk = new address[](99);
        for (uint256 i; i < 99; ++i) atk[i] = address(uint160(0xD000 + i));
        address[] memory vic = new address[](0);
        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));

        // add 2 more -> would push to 101 attackers -> reverts
        address[] memory adds = new address[](2);
        adds[0] = address(uint160(0xD0FF));
        adds[1] = address(uint160(0xD100));

        vm.expectRevert(ThatsRekt.PostTooLarge.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    /// Mixed-array cap check: 50 attackers + 50 victims = cap; one more
    /// attacker must revert.
    function test_addAttackers_revertsOnCapBreachedAcrossBothArrays() public {
        _whitelist(alice);

        address[] memory atk = new address[](50);
        for (uint256 i; i < 50; ++i) atk[i] = address(uint160(0xD200 + i));
        address[] memory vic = new address[](50);
        for (uint256 i; i < 50; ++i) vic[i] = address(uint160(0xD300 + i));

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));

        address[] memory adds = new address[](1);
        adds[0] = address(uint160(0xD3FF));

        vm.expectRevert(ThatsRekt.PostTooLarge.selector);
        vm.prank(alice);
        reg.addAttackers(id, adds);
    }

    /*------------------ addVictims: revert paths ------------------*/

    function test_addVictims_revertsForNonPoster() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, address(0), carol);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.NotPoster.selector);
        vm.prank(bob);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsForNonWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), carol);

        vm.prank(governance);
        reg.removeWhitelisted(alice);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnRemovedPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), carol);

        vm.prank(alice);
        reg.retract(id);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnNonExistentPost() public {
        _whitelist(alice);

        address[] memory adds = new address[](1);
        adds[0] = makeAddr("x");

        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.addVictims(99, adds);
    }

    function test_addVictims_revertsOnEmptyArray() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), bob);
        address[] memory adds = new address[](0);

        vm.expectRevert(ThatsRekt.EmptyAdditions.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnDuplicateInExistingVictims() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), bob);

        address[] memory adds = new address[](1);
        adds[0] = bob;

        vm.expectRevert(ThatsRekt.DuplicateAddress.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnDuplicateInAttackers() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, carol); // bob attacker, carol victim

        address[] memory adds = new address[](1);
        adds[0] = bob; // already in attackers of same post

        vm.expectRevert(ThatsRekt.DuplicateAddress.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnDuplicateInBatch() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), bob);

        address dup = makeAddr("dupVic");
        address[] memory adds = new address[](2);
        adds[0] = dup;
        adds[1] = dup;

        vm.expectRevert(ThatsRekt.DuplicateAddress.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnZeroAddress() public {
        _whitelist(alice);
        uint256 id = _post(alice, address(0), bob);

        address[] memory adds = new address[](1);
        adds[0] = address(0);

        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    function test_addVictims_revertsOnCapBreached() public {
        _whitelist(alice);

        address[] memory atk = new address[](0);
        address[] memory vic = new address[](99);
        for (uint256 i; i < 99; ++i) vic[i] = address(uint160(0xD500 + i));
        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp));

        address[] memory adds = new address[](2);
        adds[0] = address(uint160(0xD5FF));
        adds[1] = address(uint160(0xD600));

        vm.expectRevert(ThatsRekt.PostTooLarge.selector);
        vm.prank(alice);
        reg.addVictims(id, adds);
    }

    /*------------------ state-sanity: victim liveness ------------------*/

    function test_addVictims_makesAddressVictim() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address newVic = makeAddr("freshVic");
        assertFalse(reg.isVictim(newVic));

        address[] memory adds = new address[](1);
        adds[0] = newVic;

        vm.prank(alice);
        reg.addVictims(id, adds);

        assertTrue(reg.isVictim(newVic));
    }

    /// Adding then retracting clears isVictim back to false (consistent
    /// with v0 retract semantics — _victimActivePosts goes 1 -> 0).
    function test_addVictims_isVictimGoesFalseWhenPostRetracted() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        address newVic = makeAddr("freshVic2");
        address[] memory adds = new address[](1);
        adds[0] = newVic;

        vm.prank(alice);
        reg.addVictims(id, adds);
        assertTrue(reg.isVictim(newVic));

        vm.prank(alice);
        reg.retract(id);

        assertFalse(reg.isVictim(newVic));
    }

    /// Retracting after addAttackers reverses the inherited karma —
    /// the new attacker's score returns to 0 net.
    function test_addAttackers_retractReversesInheritedKarma() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        // build net +2 on the post
        address u1 = address(uint160(0xC700));
        address u2 = address(uint160(0xC701));
        _whitelist(u1); _whitelist(u2);
        vm.prank(u1); reg.confirm(id, ThatsRekt.ConfirmDirection.Up);
        vm.prank(u2); reg.confirm(id, ThatsRekt.ConfirmDirection.Up);

        address newAtk = makeAddr("retractMe");
        address[] memory adds = new address[](1);
        adds[0] = newAtk;
        vm.prank(alice);
        reg.addAttackers(id, adds);
        assertEq(reg.attackerScore(newAtk), 2);
        assertEq(reg.attackerAppearances(newAtk), 1);

        vm.prank(alice);
        reg.retract(id);

        // _removePost subtracts net (+2) from each attacker and decs appearances
        assertEq(reg.attackerScore(newAtk), 0);
        assertEq(reg.attackerAppearances(newAtk), 0);
    }

    /*//////////////////////////////////////////////////////////////
                          v1.1: TITLE FIELD
    //////////////////////////////////////////////////////////////*/

    function test_post_storesTitle() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, "Aave drainer detected", atk, vic, "details inline", uint64(block.timestamp));
        assertEq(reg.postTitle(id), "Aave drainer detected");
    }

    function test_post_revertsIfTitleEmpty() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.TitleEmpty.selector);
        vm.prank(alice);
        reg.post(_expectedPid, "", atk, vic, "n", uint64(block.timestamp));
    }

    function test_post_revertsIfTitleAtCapPlusOne() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        // Construct a title exactly MAX_TITLE_LENGTH + 1 bytes long.
        uint256 cap = reg.MAX_TITLE_LENGTH();
        bytes memory tooLong = new bytes(cap + 1);
        for (uint256 i; i < cap + 1; ++i) tooLong[i] = "a";

        uint256 _expectedPid = reg.peekNextPostId();
        vm.expectRevert(ThatsRekt.TitleTooLong.selector);
        vm.prank(alice);
        reg.post(_expectedPid, string(tooLong), atk, vic, "n", uint64(block.timestamp));
    }

    function test_post_acceptsTitleAtExactlyCap() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        uint256 cap = reg.MAX_TITLE_LENGTH();
        bytes memory atCap = new bytes(cap);
        for (uint256 i; i < cap; ++i) atCap[i] = "a";

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(alice);
        uint256 id = reg.post(_expectedPid, string(atCap), atk, vic, "", uint64(block.timestamp));
        assertEq(bytes(reg.postTitle(id)).length, cap);
    }

    function test_amendTitle_posterCanAmend() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        vm.prank(alice);
        reg.amendTitle(id, "Updated headline");
        assertEq(reg.postTitle(id), "Updated headline");
    }

    function test_amendTitle_emitsEvent() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.PostTitleAmended(id, alice, "After amend");

        vm.prank(alice);
        reg.amendTitle(id, "After amend");
    }

    function test_amendTitle_revertsForNonPoster() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotPoster.selector);
        vm.prank(bob);
        reg.amendTitle(id, "stolen");
    }

    function test_amendTitle_revertsForNonWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        vm.prank(governance);
        reg.removeWhitelisted(alice);

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.amendTitle(id, "anything");
    }

    function test_amendTitle_revertsOnRemovedPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(alice);
        reg.retract(id);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(alice);
        reg.amendTitle(id, "too late");
    }

    function test_amendTitle_revertsIfEmpty() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));

        vm.expectRevert(ThatsRekt.TitleEmpty.selector);
        vm.prank(alice);
        reg.amendTitle(id, "");
    }

    function test_amendTitle_revertsIfTooLong() public {
        _whitelist(alice);
        uint256 id = _post(alice, bob, address(0));
        uint256 cap = reg.MAX_TITLE_LENGTH();
        bytes memory tooLong = new bytes(cap + 1);
        for (uint256 i; i < cap + 1; ++i) tooLong[i] = "a";

        vm.expectRevert(ThatsRekt.TitleTooLong.selector);
        vm.prank(alice);
        reg.amendTitle(id, string(tooLong));
    }

    function test_amendTitle_advancesLastUpdatedAt() public {
        _whitelist(alice);
        vm.warp(1_000_000);
        uint256 id = _post(alice, bob, address(0));

        vm.warp(1_000_500);
        vm.prank(alice);
        reg.amendTitle(id, "new");

        (, , , , , , , uint64 lu) = reg.getPost(id);
        assertEq(lu, uint64(1_000_500));
    }

    /*//////////////////////////////////////////////////////////////
                        v1.3: GOVERNANCE PURGE
    //////////////////////////////////////////////////////////////*/

    /*------------------ purgePost: happy paths ------------------*/

    /// purgeAdmin can flag a post as purged. Aggregates reverse,
    /// post is unlinked from the active list, but `removed` stays
    /// false (purge != retract).
    function test_purgePost_purgeAdminCanPurge() public {
        // 5 distinct addresses: gov (owner+admin+remover), alice (poster),
        // bob (attacker), one voter, plus an explicit purgeAdmin.
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );

        // Whitelist alice via the admin path.
        vm.prank(governance); fresh.addWhitelisted(alice);
        // Alice posts about bob.
        address[] memory atks = new address[](1); atks[0] = bob;
        address[] memory vics = new address[](0);
        uint256 _expectedPid = fresh.peekNextPostId();
        vm.prank(alice);
        uint256 id = fresh.post(_expectedPid, "hack", atks, vics, "", uint64(block.timestamp));
        // Carol upConfirms so attackerScore[bob] = +1.
        vm.prank(governance); fresh.addWhitelisted(carol);
        vm.prank(carol); fresh.confirm(id, ThatsRekt.ConfirmDirection.Up);
        assertEq(fresh.attackerScore(bob), 1);
        assertEq(fresh.attackerAppearances(bob), 1);
        assertEq(fresh.headPostId(), id);
        assertEq(fresh.tailPostId(), id);

        // Purge.
        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.PostPurged(id, purgeAdmin_);
        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        // purged flag set; aggregates reversed; unlinked.
        assertTrue(fresh.isPurged(id));
        assertEq(fresh.attackerScore(bob), 0, "score should reverse");
        assertEq(fresh.attackerAppearances(bob), 0, "appearances should reverse");
        assertEq(fresh.headPostId(), 0, "post should be unlinked");
        assertEq(fresh.tailPostId(), 0, "post should be unlinked");

        // `removed` stays false — purge does not equal retract.
        (, , , , bool removed, , , ) = fresh.getPost(id);
        assertFalse(removed, "purge must not flip removed");
    }

    /// Purging a post that the poster already retracted: aggregates
    /// were already reversed at retract; purge flips the flag but
    /// must NOT double-reverse.
    function test_purgePost_afterRetract_doesNotDoubleReverse() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );

        vm.prank(governance); fresh.addWhitelisted(alice);
        address[] memory atks = new address[](1); atks[0] = bob;
        address[] memory vics = new address[](0);
        uint256 _expectedPid = fresh.peekNextPostId();
        vm.prank(alice);
        uint256 id = fresh.post(_expectedPid, "hack", atks, vics, "", uint64(block.timestamp));

        // Alice retracts — aggregates reverse here.
        vm.prank(alice);
        fresh.retract(id);
        assertEq(fresh.attackerAppearances(bob), 0);

        // Purge after retract — must be idempotent on aggregates.
        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        // Aggregates stay at 0 (no underflow, no double-reverse).
        assertEq(fresh.attackerAppearances(bob), 0, "must not double-reverse");
        assertTrue(fresh.isPurged(id));
        (, , , , bool removed, , , ) = fresh.getPost(id);
        assertTrue(removed, "removed flag from retract must persist");
    }

    /*------------------ purgePost: revert paths ------------------*/

    function test_purgePost_revertsForNonPurgeAdmin() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        // Owner cannot purge.
        vm.prank(governance);
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);

        // Random EOA cannot purge.
        vm.prank(makeAddr("random"));
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);

        // The poster cannot purge either.
        vm.prank(alice);
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);
    }

    function test_purgePost_revertsOnDoublePurge() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        vm.prank(purgeAdmin_);
        vm.expectRevert(ThatsRekt.AlreadyPurged.selector);
        fresh.purgePost(id);
    }

    function test_purgePost_revertsOnNonExistent() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );

        vm.prank(purgeAdmin_);
        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        fresh.purgePost(99);
    }

    /*------------------ setPurgeAdmin: owner-only ------------------*/

    function test_setPurgeAdmin_onlyOwner() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address newPurger = makeAddr("newPurger");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );

        // Old purgeAdmin cannot self-rotate (owner-only path).
        vm.prank(purgeAdmin_);
        vm.expectRevert();
        fresh.setPurgeAdmin(newPurger);

        // Random cannot rotate.
        vm.prank(alice);
        vm.expectRevert();
        fresh.setPurgeAdmin(newPurger);

        // Owner can rotate to a non-zero address. Zero is rejected on
        // both paths — `revokePurgeAdmin` is the kill-switch path so
        // the audit trail makes intent (rotate vs kill) explicit.
        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.PurgeAdminTransferred(purgeAdmin_, newPurger);
        vm.prank(governance);
        fresh.setPurgeAdmin(newPurger);
        assertEq(fresh.purgeAdmin(), newPurger);

        // Old purger no longer has authority.
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);
        vm.prank(purgeAdmin_);
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);

        // New purger has authority.
        vm.prank(newPurger);
        fresh.purgePost(id);
        assertTrue(fresh.isPurged(id));
    }

    function test_setPurgeAdmin_revertsOnZero() public {
        // Zero is rejected — disabling purge goes through
        // `revokePurgeAdmin` (purgeRemover-only, instant) so the
        // audit trail distinguishes "rotate to a new admin" from
        // "kill the role". Mirrors `setWhitelistAdmin`'s rejection
        // of zero.
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance);
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        fresh.setPurgeAdmin(address(0));
        // Slot unchanged on revert.
        assertEq(fresh.purgeAdmin(), purgeAdmin_);
    }

    /*------------------ revokePurgeAdmin: purgeRemover only ------------------*/

    /// Only the purgeRemover can revoke. Sets slot to address(0).
    /// Distinct from whitelistRemover — they live in separate slots
    /// so the operator can hold one without the other.
    function test_revokePurgeAdmin_onlyPurgeRemover() public {
        address ownerAddr   = makeAddr("ownerPK");
        address whitelistRemoverAddr = makeAddr("whitelistRem");
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            ownerAddr, ownerAddr, whitelistRemoverAddr, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        // Owner cannot.
        vm.prank(ownerAddr);
        vm.expectRevert(ThatsRekt.NotPurgeRemover.selector);
        fresh.revokePurgeAdmin();

        // whitelistRemover (the OLD design's holder) cannot — that's
        // the whole point of splitting the slots.
        vm.prank(whitelistRemoverAddr);
        vm.expectRevert(ThatsRekt.NotPurgeRemover.selector);
        fresh.revokePurgeAdmin();

        // purgeAdmin cannot self-revoke.
        vm.prank(purgeAdmin_);
        vm.expectRevert(ThatsRekt.NotPurgeRemover.selector);
        fresh.revokePurgeAdmin();

        // Random cannot.
        vm.prank(alice);
        vm.expectRevert(ThatsRekt.NotPurgeRemover.selector);
        fresh.revokePurgeAdmin();

        // purgeRemover can.
        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.PurgeAdminTransferred(purgeAdmin_, address(0));
        vm.prank(purgeRemoverAddr);
        fresh.revokePurgeAdmin();

        assertEq(fresh.purgeAdmin(), address(0));
    }

    /// After revoke, purgePost is bricked — no caller can satisfy
    /// `msg.sender == purgeAdmin` because msg.sender is never zero.
    function test_revokePurgeAdmin_blocksPurgesByEveryone() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeRemoverAddr);
        fresh.revokePurgeAdmin();

        // Old purger blocked.
        vm.prank(purgeAdmin_);
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);

        // Owner blocked.
        vm.prank(governance);
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);

        // Remover blocked too — the kill-switch is one-way until owner
        // re-installs.
        vm.prank(purgeRemoverAddr);
        vm.expectRevert(ThatsRekt.NotPurgeAdmin.selector);
        fresh.purgePost(id);
    }

    /// After revoke, owner can re-install via setPurgeAdmin.
    function test_revokePurgeAdmin_ownerCanReinstall() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        address newPurger = makeAddr("newPurger");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        vm.prank(purgeRemoverAddr);
        fresh.revokePurgeAdmin();
        assertEq(fresh.purgeAdmin(), address(0));

        vm.prank(governance);
        fresh.setPurgeAdmin(newPurger);
        assertEq(fresh.purgeAdmin(), newPurger);

        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);
        vm.prank(newPurger);
        fresh.purgePost(id);
        assertTrue(fresh.isPurged(id));
    }

    /*------------------ setPurgeRemover: owner-only ------------------*/

    function test_setPurgeRemover_onlyOwner() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        address newPurgeRem = makeAddr("newPurgeRem");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        // Admin cannot.
        vm.prank(governance); // governance is owner+admin+remover here
        // — bypass the test by deploying with split roles for clarity.
        // Instead: make a separate fresh contract with a distinct admin.
        address ownerAddr = makeAddr("ownerSPR");
        address adminAddr = makeAddr("adminSPR");
        address removerAddr = makeAddr("removerSPR");
        ThatsRekt split = _deployProxiedRolesWithPurge(
            ownerAddr, adminAddr, removerAddr, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        // adminAddr cannot rotate purgeRemover.
        vm.prank(adminAddr);
        vm.expectRevert();
        split.setPurgeRemover(newPurgeRem);

        // whitelistRemover cannot.
        vm.prank(removerAddr);
        vm.expectRevert();
        split.setPurgeRemover(newPurgeRem);

        // Current purgeRemover cannot self-rotate.
        vm.prank(purgeRemoverAddr);
        vm.expectRevert();
        split.setPurgeRemover(newPurgeRem);

        // Random cannot.
        vm.prank(alice);
        vm.expectRevert();
        split.setPurgeRemover(newPurgeRem);

        // Owner can.
        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.PurgeRemoverTransferred(purgeRemoverAddr, newPurgeRem);
        vm.prank(ownerAddr);
        split.setPurgeRemover(newPurgeRem);
        assertEq(split.purgeRemover(), newPurgeRem);

        // Old purgeRemover loses authority.
        vm.prank(purgeRemoverAddr);
        vm.expectRevert(ThatsRekt.NotPurgeRemover.selector);
        split.revokePurgeAdmin();

        // New purgeRemover gains it.
        vm.prank(newPurgeRem);
        split.revokePurgeAdmin();
        assertEq(split.purgeAdmin(), address(0));

        // The unused `fresh` ref / test_setPurgeRemover_onlyOwner is split
        // for clarity — silence the unused-warning on `fresh`.
        fresh;
    }

    function test_setPurgeRemover_revertsOnZero() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        vm.prank(governance);
        vm.expectRevert(ThatsRekt.ZeroAddress.selector);
        fresh.setPurgeRemover(address(0));
    }

    function test_setPurgeRemover_emitsTransferred() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        address newPurgeRem = makeAddr("newPurgeRem");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.PurgeRemoverTransferred(purgeRemoverAddr, newPurgeRem);
        vm.prank(governance);
        fresh.setPurgeRemover(newPurgeRem);
    }

    /*------------------ setPurgeRemover: independence from whitelistRemover ------------------*/

    /// Rotating one does not touch the other. The two slots are
    /// independent and serve separate planes (whitelist vs purge).
    function test_setPurgeRemover_doesNotChangeWhitelistRemover() public {
        address ownerAddr = makeAddr("ownerInd");
        address adminAddr = makeAddr("adminInd");
        address whitelistRemoverAddr = makeAddr("wlRem");
        address purgeAdmin_ = makeAddr("purgeAdmin");
        address purgeRemoverAddr = makeAddr("purgeRem");
        address newPurgeRem = makeAddr("newPurgeRem");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            ownerAddr, adminAddr, whitelistRemoverAddr, purgeAdmin_, purgeRemoverAddr, _emptyList()
        );

        vm.prank(ownerAddr);
        fresh.setPurgeRemover(newPurgeRem);

        assertEq(fresh.purgeRemover(), newPurgeRem);
        assertEq(fresh.whitelistRemover(), whitelistRemoverAddr, "whitelistRemover must not change");
    }

    /*------------------ initialize sets purgeRemover ------------------*/

    function test_initialize_setsInitialPurgeRemover() public {
        address purgeRemoverAddr = makeAddr("purgeRemInit");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, governance, purgeRemoverAddr, _emptyList()
        );
        assertEq(fresh.purgeRemover(), purgeRemoverAddr);
    }

    function test_initialize_emitsPurgeRemoverTransferred() public {
        address purgeRemoverAddr = makeAddr("purgeRemEvt");
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (governance, governance, governance, governance, purgeRemoverAddr, _emptyList())
        );

        vm.expectEmit(true, true, false, false);
        emit ThatsRekt.PurgeRemoverTransferred(address(0), purgeRemoverAddr);
        new ERC1967Proxy(address(impl), initCalldata);
    }

    /*------------------ purged-state guards on mutating fns ------------------*/

    /// Audit C-1: After `purgePost`, the original poster could still call
    /// `retract()` — the function only checked `p.removed`, not `p.purged`.
    /// That double-reversed aggregates and zeroed `headPostId`/`tailPostId`,
    /// bricking the active linked list whenever other live posts existed.
    /// Fix: gate `retract` on `p.purged` and revert with `PostIsPurged`.
    function test_purgeThenRetract_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        vm.prank(alice);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.retract(id);
    }

    /// Inverse direction: retract first, THEN purge. This must still succeed
    /// (purgePost has its own `if (!p.removed)` guard that skips the second
    /// reversal) — the `PostIsPurged` guard added to retract must not
    /// regress this composition.
    function test_retractThenPurge_works() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        // Retract — reverses aggregates here.
        vm.prank(alice);
        fresh.retract(id);
        assertEq(fresh.attackerAppearances(bob), 0);

        // Purge after retract — must succeed and must NOT double-reverse.
        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        assertTrue(fresh.isPurged(id));
        (, , , , bool removed, , , ) = fresh.getPost(id);
        assertTrue(removed);
        assertEq(fresh.attackerAppearances(bob), 0, "no double reversal");
    }

    /// Audit H-1: After purge, `confirm` only checked `p.removed` and
    /// happily added delta to `attackerScore` — letting whitelisters
    /// continue pumping karma on attackers from a purged post. Fix: gate
    /// `confirm` on `p.purged`.
    function test_purgeThenConfirm_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        vm.prank(governance); fresh.addWhitelisted(carol);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        vm.prank(carol);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.confirm(id, ThatsRekt.ConfirmDirection.Up);
    }

    /// Audit H-1 (unconfirm path): After purge, an existing voter could
    /// still `unconfirm`, which reverses delta on aggregates that were
    /// already reversed during purge — corrupting `attackerScore`. Fix:
    /// gate `unconfirm` on `p.purged`.
    function test_purgeThenUnconfirm_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        vm.prank(governance); fresh.addWhitelisted(carol);
        uint256 id = _postAs(fresh, alice, bob);

        // Carol votes first.
        vm.prank(carol);
        fresh.confirm(id, ThatsRekt.ConfirmDirection.Up);

        // Now purge.
        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        // Carol's unconfirm must revert — reversing again would corrupt.
        vm.prank(carol);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.unconfirm(id);
    }

    /// Audit H-2 (note): after purge, the poster could still rewrite the
    /// note — defeating governance moderation. Fix: gate `amendNote` on
    /// `p.purged`.
    function test_purgeThenAmendNote_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        vm.prank(alice);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.amendNote(id, "new note");
    }

    /// Audit H-2 (title): after purge, the poster could still rewrite the
    /// on-chain title. Fix: gate `amendTitle` on `p.purged`.
    function test_purgeThenAmendTitle_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        vm.prank(alice);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.amendTitle(id, "new title");
    }

    /// Audit H-2 (addAttackers): after purge, the poster could still bolt
    /// on new attackers — flipping fresh appearances + inheriting the (now
    /// reversed) net karma. Fix: gate `addAttackers` on `p.purged`.
    function test_purgeThenAddAttackers_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        address[] memory more = new address[](1);
        more[0] = makeAddr("newAttacker");
        vm.prank(alice);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.addAttackers(id, more);
    }

    /// Audit H-2 (addVictims): after purge, the poster could still flip
    /// `isVictim` for fresh addresses by appending them to a purged post.
    /// Fix: gate `addVictims` on `p.purged`.
    function test_purgeThenAddVictims_revertsWithPostIsPurged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        uint256 id = _postAs(fresh, alice, bob);

        vm.prank(purgeAdmin_);
        fresh.purgePost(id);

        address[] memory more = new address[](1);
        more[0] = makeAddr("newVictim");
        vm.prank(alice);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.addVictims(id, more);
    }

    /// Concrete C-1 list-corruption regression: with three live posts in
    /// the linked list (head=1, tail=3, 2 in the middle), purging id=2 and
    /// THEN attempting retract(2) used to unconditionally zero head/tail
    /// because both `prev` and `next` were already cleared — bricking the
    /// active feed. With the `PostIsPurged` guard the retract reverts and
    /// the list stays {head=1, tail=3} with id=2 unlinked but the rest
    /// intact.
    function test_purgeThenRetract_doesNotCorruptList() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);

        uint256 id1 = _postAs(fresh, alice, makeAddr("atk1"));
        uint256 id2 = _postAs(fresh, alice, makeAddr("atk2"));
        uint256 id3 = _postAs(fresh, alice, makeAddr("atk3"));
        assertEq(fresh.headPostId(), id1);
        assertEq(fresh.tailPostId(), id3);

        // Purge the middle node — id2 is unlinked, head=1, tail=3.
        vm.prank(purgeAdmin_);
        fresh.purgePost(id2);
        assertEq(fresh.headPostId(), id1, "head intact after purge");
        assertEq(fresh.tailPostId(), id3, "tail intact after purge");

        // Pre-fix: retract(id2) would zero head + tail. Post-fix: reverts.
        vm.prank(alice);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.retract(id2);

        // List must remain intact after the failed retract.
        assertEq(fresh.headPostId(), id1, "head unchanged after failed retract");
        assertEq(fresh.tailPostId(), id3, "tail unchanged after failed retract");
    }

    /// Concrete H-1 karma regression: pre-fix, a confirm after purge
    /// silently pumped `attackerScore`. Post-fix, the confirm reverts and
    /// the score stays at its post-purge baseline (zero in this scenario).
    function test_purgeThenAttackerKarma_unchanged() public {
        address purgeAdmin_ = makeAddr("purgeAdmin");
        ThatsRekt fresh = _deployProxiedRolesWithPurge(
            governance, governance, governance, purgeAdmin_, governance, _emptyList()
        );
        vm.prank(governance); fresh.addWhitelisted(alice);
        vm.prank(governance); fresh.addWhitelisted(carol);
        vm.prank(governance); fresh.addWhitelisted(dave);

        uint256 id = _postAs(fresh, alice, bob);

        // Carol confirms Up — attackerScore[bob] = +1.
        vm.prank(carol);
        fresh.confirm(id, ThatsRekt.ConfirmDirection.Up);
        assertEq(fresh.attackerScore(bob), 1);

        // Purge — aggregates reverse, attackerScore[bob] = 0.
        vm.prank(purgeAdmin_);
        fresh.purgePost(id);
        assertEq(fresh.attackerScore(bob), 0, "score reversed by purge");

        // Dave tries to confirm Up — must revert, must NOT bump score.
        vm.prank(dave);
        vm.expectRevert(ThatsRekt.PostIsPurged.selector);
        fresh.confirm(id, ThatsRekt.ConfirmDirection.Up);

        assertEq(fresh.attackerScore(bob), 0, "no karma pump on purged post");
    }

    /*------------------ helper ------------------*/

    /// Whitelisted poster path with one attacker; returns the post id.
    /// Mirrors `_post` but is parameterized on the contract instance so
    /// the purge tests can drive non-default deployments.
    function _postAs(ThatsRekt c, address poster, address atk) internal returns (uint256 id) {
        address[] memory atks = new address[](1); atks[0] = atk;
        address[] memory vics = new address[](0);
        // Resolve peek BEFORE pranking — see _post() for the rationale.
        uint256 expected = c.peekNextPostId();
        vm.prank(poster);
        id = c.post(expected, "hack", atks, vics, "", uint64(block.timestamp));
    }
}
