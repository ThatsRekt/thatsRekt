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
        governance = makeAddr("governance");
        reg = new ThatsRekt(governance);
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
    /// attackedAt defaults to the current block timestamp (attack and post in the same block).
    function _post(address poster, address atk0, address vic0) internal returns (uint256 id) {
        address[] memory atk = new address[](atk0 == address(0) ? 0 : 1);
        address[] memory vic = new address[](vic0 == address(0) ? 0 : 1);
        if (atk0 != address(0)) atk[0] = atk0;
        if (vic0 != address(0)) vic[0] = vic0;
        vm.prank(poster);
        id = reg.post(atk, vic, "", uint64(block.timestamp));
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
        uint256 id = reg.post(atk, vic, "exploit on bob's vault", uint64(block.timestamp));

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
        emit ThatsRekt.PostCreated(1, alice, attacked, atk, vic, "rekt");

        vm.prank(alice);
        reg.post(atk, vic, "rekt", attacked);
    }

    function test_post_storesFields() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = carol;
        address[] memory vic = new address[](1); vic[0] = dave;

        vm.warp(123_456_789);
        // attackedAt deliberately distinct from block.timestamp to prove the
        // stored value is the poster-supplied one, not the block timestamp.
        uint64 attacked = uint64(123_456_700);

        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "", attacked);

        (
            address poster,
            uint64 attackedAt,
            uint32 up,
            uint32 down,
            bool removed,
            address[] memory storedAtk,
            address[] memory storedVic
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

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(alice);
        reg.post(atk, vic, "no auth", uint64(block.timestamp));
    }

    function test_post_revertsIfEmpty() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        vm.expectRevert(ThatsRekt.EmptyPost.selector);
        vm.prank(alice);
        reg.post(atk, vic, "", uint64(block.timestamp));
    }

    function test_post_acceptsNoteOnly() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](0);

        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "Twitter says protocol X is being drained", uint64(block.timestamp));
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
        reg.post(atk, vic, "", uint64(block.timestamp));
    }

    function test_post_acceptsExactlyCap() public {
        _whitelist(alice);
        uint256 cap = reg.MAX_ADDRESSES_PER_POST();
        address[] memory atk = new address[](cap);
        for (uint256 i; i < cap; ++i) atk[i] = address(uint160(0x1000 + i));
        address[] memory vic = new address[](0);

        vm.prank(alice);
        reg.post(atk, vic, "", uint64(block.timestamp));
    }

    /*//////////////////////////////////////////////////////////////
                  PHASE 3.5 - attackedAt VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_post_revertsIfAttackedAtZero() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.expectRevert(ThatsRekt.InvalidAttackedAt.selector);
        vm.prank(alice);
        reg.post(atk, vic, "", 0);
    }

    function test_post_revertsIfAttackedAtInFuture() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        // any value strictly greater than block.timestamp is a future claim
        uint64 future = uint64(block.timestamp + 1);

        vm.expectRevert(ThatsRekt.InvalidAttackedAt.selector);
        vm.prank(alice);
        reg.post(atk, vic, "", future);
    }

    function test_post_acceptsAttackedAtEqualToBlockTimestamp() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "", uint64(block.timestamp));
        assertEq(id, 1);
    }

    function test_post_acceptsAncientAttackedAt() public {
        // attackedAt = 1 (very old, but valid: > 0 and <= block.timestamp).
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.warp(1_000_000);
        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "", 1);
        assertEq(id, 1);

        (, uint64 attackedAt, , , , , ) = reg.getPost(id);
        assertEq(attackedAt, 1);
    }

    function test_getPost_returnsAttackedAtVerbatim() public {
        _whitelist(alice);
        address[] memory atk = new address[](1); atk[0] = bob;
        address[] memory vic = new address[](0);

        vm.warp(2_000_000);
        uint64 attacked = uint64(1_999_500);

        vm.prank(alice);
        uint256 id = reg.post(atk, vic, "", attacked);

        (, uint64 stored, , , , , ) = reg.getPost(id);
        assertEq(stored, attacked);
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 4 - AGGREGATES
    //////////////////////////////////////////////////////////////*/

    function test_post_incrementsAttackerAppearances() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = carol;
        address[] memory vic = new address[](0);

        vm.prank(alice);
        reg.post(atk, vic, "", uint64(block.timestamp));

        assertEq(reg.attackerAppearances(bob), 1);
        assertEq(reg.attackerAppearances(carol), 1);
        assertEq(reg.attackerScore(bob), 0);
    }

    function test_post_duplicateAttackers_doubleCount() public {
        _whitelist(alice);
        address[] memory atk = new address[](2); atk[0] = bob; atk[1] = bob;
        address[] memory vic = new address[](0);

        vm.prank(alice);
        reg.post(atk, vic, "", uint64(block.timestamp));

        assertEq(reg.attackerAppearances(bob), 2);
    }

    function test_post_setsIsVictimTrue() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](1); vic[0] = bob;

        vm.prank(alice);
        reg.post(atk, vic, "", uint64(block.timestamp));

        assertTrue(reg.isVictim(bob));
    }

    function test_post_isVictim_remainsTrueAcrossMultiplePosts() public {
        _whitelist(alice);
        address[] memory atk = new address[](0);
        address[] memory vic = new address[](1); vic[0] = bob;

        vm.startPrank(alice);
        reg.post(atk, vic, "", uint64(block.timestamp));
        reg.post(atk, vic, "", uint64(block.timestamp));
        vm.stopPrank();

        assertTrue(reg.isVictim(bob));
    }

    /*//////////////////////////////////////////////////////////////
                            PHASE 5 - vote()
    //////////////////////////////////////////////////////////////*/

    function test_vote_revertsOnPostNotFound() public {
        _whitelist(alice);
        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.vote(99, ThatsRekt.VoteDirection.Upvote);
    }

    function test_vote_posterCannotVoteOwnPost() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.PosterCannotVote.selector);
        vm.prank(alice);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
    }

    function test_vote_revertsIfSameDirection() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);

        vm.expectRevert(ThatsRekt.NoVoteChange.selector);
        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
    }

    function test_vote_revertsOnVoteDirectionNone() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.InvalidVoteDirection.selector);
        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.None);
    }

    function test_vote_onlyWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
    }

    function test_vote_upvote_incrementsCounters() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 1);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 1);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.Upvote);
    }

    function test_vote_downvote_incrementsCounters() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Downvote);

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 1);
        assertEq(reg.attackerScore(carol), -1);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.Downvote);
    }

    function test_vote_flip_upToDown() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
        reg.vote(id, ThatsRekt.VoteDirection.Downvote);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 1);
        assertEq(reg.attackerScore(carol), -1);
    }

    /// The Voted event now emits VoteDirection (uint8 in the ABI) for both
    /// the old and new direction — None=0, Upvote=1, Downvote=2.
    function test_vote_emitsVotedWithOldAndNew() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.Voted(
            id,
            bob,
            ThatsRekt.VoteDirection.None,
            ThatsRekt.VoteDirection.Upvote
        );
        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
    }

    function test_vote_multipleVoters_aggregateScore() public {
        _whitelist(alice);
        _whitelist(bob);
        _whitelist(carol);
        uint256 id = _post(alice, dave, address(0));

        vm.prank(bob);   reg.vote(id, ThatsRekt.VoteDirection.Upvote);
        vm.prank(carol); reg.vote(id, ThatsRekt.VoteDirection.Upvote);

        assertEq(reg.attackerScore(dave), 2);
    }

    /*//////////////////////////////////////////////////////////////
                          PHASE 5.5 - unvote()
    //////////////////////////////////////////////////////////////*/

    function test_unvote_clearsVoteAndReversesAggregates() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
        // baseline pre-unvote: score == +1, up == 1
        assertEq(reg.attackerScore(carol), 1);
        reg.unvote(id);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.None);
    }

    function test_unvote_clearsDownvoteAndReversesAggregates() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Downvote);
        assertEq(reg.attackerScore(carol), -1);
        reg.unvote(id);
        vm.stopPrank();

        (, , uint32 up, uint32 down, , , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.None);
    }

    function test_unvote_revertsIfNoVoteExists() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NoVoteToRetract.selector);
        vm.prank(bob);
        reg.unvote(id);
    }

    function test_unvote_revertsForNonWhitelisted() public {
        _whitelist(alice);
        uint256 id = _post(alice, carol, address(0));

        vm.expectRevert(ThatsRekt.NotWhitelisted.selector);
        vm.prank(bob);
        reg.unvote(id);
    }

    function test_unvote_revertsOnNonExistentPost() public {
        _whitelist(alice);

        vm.expectRevert(ThatsRekt.PostNotFound.selector);
        vm.prank(alice);
        reg.unvote(99);
    }

    function test_unvote_revertsOnRemovedPost() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        // bob votes, alice retracts the post, bob then tries to unvote
        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);

        vm.prank(alice);
        reg.retract(id);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(bob);
        reg.unvote(id);
    }

    function test_voteFlow_voteUpThenUnvoteThenVoteDown() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.startPrank(bob);

        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
        (, , uint32 up1, uint32 down1, , , ) = reg.getPost(id);
        assertEq(up1, 1);
        assertEq(down1, 0);
        assertEq(reg.attackerScore(carol), 1);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.Upvote);

        reg.unvote(id);
        (, , uint32 up2, uint32 down2, , , ) = reg.getPost(id);
        assertEq(up2, 0);
        assertEq(down2, 0);
        assertEq(reg.attackerScore(carol), 0);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.None);

        reg.vote(id, ThatsRekt.VoteDirection.Downvote);
        (, , uint32 up3, uint32 down3, , , ) = reg.getPost(id);
        assertEq(up3, 0);
        assertEq(down3, 1);
        assertEq(reg.attackerScore(carol), -1);
        assertTrue(reg.voteOf(id, bob) == ThatsRekt.VoteDirection.Downvote);

        vm.stopPrank();
    }

    function test_unvote_emitsVotedEventWithNoneTransition() public {
        _whitelist(alice);
        _whitelist(bob);
        uint256 id = _post(alice, carol, address(0));

        vm.prank(bob);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);

        vm.expectEmit(true, true, false, true);
        emit ThatsRekt.Voted(
            id,
            bob,
            ThatsRekt.VoteDirection.Upvote,
            ThatsRekt.VoteDirection.None
        );
        vm.prank(bob);
        reg.unvote(id);
    }

    /*//////////////////////////////////////////////////////////////
                       PHASE 6 - NO AUTO REMOVAL
    //////////////////////////////////////////////////////////////*/

    /// Heavily-downvoted posts must NOT be auto-removed. Consumers that want
    /// to gate on community sentiment should read `attackerScore` and pick
    /// their own threshold. Removal is now poster-driven only (retract).
    function test_heavilyDownvotedPost_isNotAutoRemoved() public {
        _whitelist(alice);
        address attacker = makeAddr("attacker");
        uint256 id = _post(alice, attacker, address(0));

        // 10 voters, all downvoting -> net score -10 but post stays active.
        for (uint256 i; i < 10; ++i) {
            address voter = address(uint160(uint256(0xD000) + i));
            _whitelist(voter);
            vm.prank(voter);
            reg.vote(id, ThatsRekt.VoteDirection.Downvote);
        }

        (, , uint32 up, uint32 down, bool removed, , ) = reg.getPost(id);
        assertEq(up, 0);
        assertEq(down, 10);
        assertFalse(removed, "post must NOT be auto-removed by downvotes");

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
    function test_voteOnRemovedPost_reverts() public {
        _whitelist(alice);
        uint256 id = _post(alice, makeAddr("attacker"), address(0));

        vm.prank(alice);
        reg.retract(id);

        address eve = makeAddr("eve");
        _whitelist(eve);

        vm.expectRevert(ThatsRekt.PostIsRemoved.selector);
        vm.prank(eve);
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);
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
        reg.vote(id, ThatsRekt.VoteDirection.Upvote);

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
                     PHASE 11 - OWNERSHIP / GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function test_constructor_setsInitialOwner() public {
        address newOwner = makeAddr("newOwner");
        ThatsRekt fresh = new ThatsRekt(newOwner);
        assertEq(fresh.owner(), newOwner);
    }

    function test_constructor_revertsOnZeroOwner() public {
        vm.expectRevert();   // OwnableInvalidOwner(address(0))
        new ThatsRekt(address(0));
    }

    /// Governance can be rotated via Ownable2Step's two-step transfer.
    /// New owner inherits the full whitelist-management authority; old
    /// owner is fully de-authorized once the transfer is accepted.
    function test_governance_canBeRotated() public {
        address newGov = makeAddr("newGov");

        // 1. current owner proposes the new owner
        vm.prank(governance);
        reg.transferOwnership(newGov);

        // 2. pending until accepted; current owner unchanged
        assertEq(reg.pendingOwner(), newGov);
        assertEq(reg.owner(), governance);

        // 3. new owner accepts
        vm.prank(newGov);
        reg.acceptOwnership();

        // 4. ownership has fully transferred
        assertEq(reg.owner(), newGov);
        assertEq(reg.pendingOwner(), address(0));

        // 5. new owner can manage the whitelist
        vm.prank(newGov);
        reg.addWhitelisted(alice);
        assertTrue(reg.isWhitelisted(alice));

        // 6. old owner is fully de-authorized
        vm.expectRevert();
        vm.prank(governance);
        reg.addWhitelisted(bob);
    }
}
