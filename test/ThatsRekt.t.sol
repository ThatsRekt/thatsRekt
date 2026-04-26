// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";

contract ThatsRektTest is Test {
    ThatsRekt public reg;
    address public governance;
    address public alice;
    address public bob;
    address public carol;
    address public dave;

    function setUp() public virtual {
        reg = new ThatsRekt();
        governance = reg.GOVERNANCE();
        alice = makeAddr("alice");
        bob   = makeAddr("bob");
        carol = makeAddr("carol");
        dave  = makeAddr("dave");
    }

    /// helper - whitelist via owner prank
    function _whitelist(address a) internal {
        vm.prank(governance);
        reg.addWhitelisted(a);
    }

    /// helper - create a basic post with at most one attacker and/or one victim.
    function _post(address poster, address atk0, address vic0) internal returns (uint256 id) {
        address[] memory atk = new address[](atk0 == address(0) ? 0 : 1);
        address[] memory vic = new address[](vic0 == address(0) ? 0 : 1);
        if (atk0 != address(0)) atk[0] = atk0;
        if (vic0 != address(0)) vic[0] = vic0;
        vm.prank(poster);
        id = reg.post(atk, vic, "");
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

        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "exploit on bob's vault");

        assertEq(id, 1);
        assertEq(reg.postCount(), 1);
    }

    function test_post_emitsPostCreated() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](1); vic[0] = carol;

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.PostCreated(1, alice, uint64(block.timestamp), atk, vic, "rekt");

        vm.prank(alice);
        reg.post(atk, vic, "rekt");
    }

    function test_post_storesFields() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = carol;
        address[] memory vic = new address[](1); vic[0] = dave;

        vm.warp(123_456_789);
        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "");

        (
            address poster,
            uint64 ts,
            uint32 up,
            uint32 down,
            bool removed,
            address[] memory storedAtk,
            address[] memory storedVic
        ) = reg.getPost(id);

        assertEq(poster, alice);
        assertEq(ts, 123_456_789);
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

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.post(atk, vic, "no auth");
    }

    function test_post_revertsIfEmpty() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        vm.expectRevert(ThatsRekt.EmptyPost.selector);
        vm.prank(alice);
        reg.post(atk, vic, "");
    }

    function test_post_acceptsNoteOnly() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "Twitter says protocol X is being drained");
        assertEq(id, 1);
    }

    function test_post_revertsIfTooLarge() public {
        _whitelist(alice);
        uint256 cap = reg.MAX_ADDRESSES_PER_POST();
        address[] memory atk = new address[](cap + 1);
        for (uint256 i; i < cap + 1; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        vm.expectRevert(ThatsRekt.PostTooLarge.selector);
        vm.prank(alice);
        reg.post(atk, vic, "");
    }

    function test_post_acceptsExactlyCap() public {
        _whitelist(alice);
        uint256 cap = reg.MAX_ADDRESSES_PER_POST();
        address[] memory atk = new address[](cap);
        for (uint256 i; i < cap; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        vm.prank(alice);
        reg.post(atk, vic, "");
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 4 - AGGREGATES
    //////////////////////////////////////////////////////////////*/

    function test_post_incrementsAttackerAppearances() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = carol;
        address[] memory vic = new address[](0);

        vm.prank(alice);
        reg.post(atk, vic, "");

        assertEq(reg.attackerAppearances(bob), 1);
        assertEq(reg.attackerAppearances(carol), 1);
        assertEq(reg.attackerScore(bob), 0);
    }

    function test_post_duplicateAttackers_doubleCount() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = bob;
        address[] memory vic = new address[](0);

        vm.prank(alice);
        reg.post(atk, vic, "");

        assertEq(reg.attackerAppearances(bob), 2);
    }

    function test_post_setsIsVictimTrue() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](1); vic[0] = bob;

        vm.prank(alice);
        reg.post(atk, vic, "");

        assertTrue(reg.isVictim(bob));
    }

    function test_post_isVictim_remainsTrueAcrossMultiplePosts() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](1); vic[0] = bob;

        vm.startPrank(alice);
        reg.post(atk, vic, "");
        reg.post(atk, vic, "");
        vm.stopPrank();

        assertTrue(reg.isVictim(bob));
    }

    /*//////////////////////////////////////////////////////////////
                            PHASE 5 - vote()
    //////////////////////////////////////////////////////////////*/

    function test_vote_revertsOnInvalidDirection_2() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.InvalidDirection.selector);
        vm.prank(bob);
        reg.vote(id, 2);
    }

    function test_vote_revertsOnInvalidDirection_neg2() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.InvalidDirection.selector);
        vm.prank(bob);
        reg.vote(id, -2);
    }

    function test_vote_revertsOnPostNotFound() public {
        _whitelist(alice);
        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.vote(99, 1);
    }

    function test_vote_posterCannotVoteOwnPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.PosterCannotVote.selector);
        vm.prank(alice);
        reg.vote(id, 1);
    }

    function test_vote_revertsIfSameDirection() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, 1);

        vm.expectRevert(ThatsRekt.NoVoteChange.selector);
        vm.prank(bob);
        reg.vote(id, 1);
    }

    function test_vote_onlyWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(bob);
        reg.vote(id, 1);
    }

    function test_vote_upvote_incrementsCounters() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, 1);

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 1);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 1);
        assertEq(reg.voteOf(id, bob), 1);
    }

    function test_vote_downvote_incrementsCounters() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, -1);

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 1);
        assertEq(reg.attackerScore(carol), -1);
        assertEq(reg.voteOf(id, bob), -1);
    }

    function test_vote_flip_upToDown() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.vote(id, 1);
        reg.vote(id, -1);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 1);
        assertEq(reg.attackerScore(carol), -1);
    }

    function test_vote_retract_upToZero() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.vote(id, 1);
        reg.vote(id, 0);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertEq(reg.voteOf(id, bob), 0);
    }

    function test_vote_emitsVotedWithOldAndNew() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.Voted(id, bob, int8(0), int8(1));
        vm.prank(bob);
        reg.vote(id, 1);
    }

    function test_vote_multipleVoters_aggregateScore() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        uint256 id = _post(alice, dave, address(0));

        vm.prank(bob);   reg.vote(id, 1);
        vm.prank(carol); reg.vote(id, 1);

        assertEq(reg.attackerScore(dave), 2);
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 6 - AUTO REMOVAL
    //////////////////////////////////////////////////////////////*/

    function test_autoRemoval_triggersAtThreshold() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        _whitelist(dave);
        uint256 id = _post(alice, makeAddr("attacker"), address(0));

        vm.prank(bob);   reg.vote(id, -1);
        vm.prank(carol); reg.vote(id, -1);

        (, , , , bool removed1, , ) = reg.getPost(id);
        assertFalse(removed1);

        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.PostRemoved(id, ThatsRekt.RemovalReason.AutoDownvote);

        vm.prank(dave);  reg.vote(id, -1);

        (, , , , bool removed2, , ) = reg.getPost(id);
        assertTrue(removed2);
    }

    function test_autoRemoval_reversesAttackerScore() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        _whitelist(dave);
        address attacker = makeAddr("attacker");
        uint256 id = _post(alice, attacker, address(0));

        vm.prank(bob);   reg.vote(id, -1);
        vm.prank(carol); reg.vote(id, -1);
        vm.prank(dave);  reg.vote(id, -1);

        assertEq(reg.attackerScore(attacker), 0);
        assertEq(reg.attackerAppearances(attacker), 0);
    }

    function test_autoRemoval_unsetsIsVictim_whenLastActivePost() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        _whitelist(dave);
        address victim = makeAddr("victim");
        uint256 id = _post(alice, address(0), victim);

        assertTrue(reg.isVictim(victim));

        vm.prank(bob);   reg.vote(id, -1);
        vm.prank(carol); reg.vote(id, -1);
        vm.prank(dave);  reg.vote(id, -1);

        assertFalse(reg.isVictim(victim));
    }

    function test_autoRemoval_keepsIsVictim_whenOtherPostsActive() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        _whitelist(dave);
        address victim = makeAddr("victim");

        uint256 id1 = _post(alice, address(0), victim);
        uint256 id2 = _post(alice, address(0), victim);

        vm.prank(bob);   reg.vote(id1, -1);
        vm.prank(carol); reg.vote(id1, -1);
        vm.prank(dave);  reg.vote(id1, -1);

        assertTrue(reg.isVictim(victim));
        (, , , , bool r2, , ) = reg.getPost(id2);
        assertFalse(r2);
    }

    function test_voteOnRemovedPost_reverts() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        _whitelist(dave);
        uint256 id = _post(alice, makeAddr("attacker"), address(0));

        vm.prank(bob);   reg.vote(id, -1);
        vm.prank(carol); reg.vote(id, -1);
        vm.prank(dave);  reg.vote(id, -1);

        address eve = makeAddr("eve");
        _whitelist(eve);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(eve);
        reg.vote(id, 1);
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE 7 - retract()
    //////////////////////////////////////////////////////////////*/

    function test_retract_byPoster() public {
        _whitelist(alice);
        address attacker = makeAddr("attacker");
        uint256 id = _post(alice, attacker, address(0));

        vm.expectEmit(true, false, false, true);
        emit ThatsRekt.PostRemoved(id, ThatsRekt.RemovalReason.PosterRetract);

        vm.prank(alice);
        reg.retract(id);

        (, , , , bool removed, , ) = reg.getPost(id);
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

        (, , , , bool removed, , ) = reg.getPost(id);
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
        reg.vote(id, 1);

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
}
