// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {ThatsRekt} from "../../src/ThatsRekt.sol";

/// @notice Bounded-action handler driving ThatsRekt under invariant fuzzing.
contract ThatsRektHandler is Test {
    ThatsRekt public immutable reg;

    address[] public actors;
    uint256[] public livePostIds;

    constructor(ThatsRekt _reg, address[] memory _actors) {
        reg = _reg;
        actors = _actors;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function fuzz_post(uint256 actorSeed, uint256 nA, uint256 nV) external {
        address poster = _actor(actorSeed);
        nA = bound(nA, 0, 4);
        nV = bound(nV, 0, 4);
        if (nA + nV == 0) nA = 1;

        address[] memory atk = new address[](nA);
        for (uint256 i; i < nA; ++i) atk[i] = address(uint160(0xA000 + i + actorSeed));
        address[] memory vic = new address[](nV);
        for (uint256 i; i < nV; ++i) vic[i] = address(uint160(0xB000 + i + actorSeed));

        vm.prank(poster);
        try reg.post(atk, vic, "", uint64(block.timestamp)) returns (uint256 id) {
            livePostIds.push(id);
        } catch { /* expected: NotWhitelisted, etc. */ }
    }

    function fuzz_vote(uint256 actorSeed, uint256 postSeed, bool isUpvote) external {
        if (livePostIds.length == 0) return;
        address voter = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        ThatsRekt.VoteDirection dir = isUpvote
            ? ThatsRekt.VoteDirection.Upvote
            : ThatsRekt.VoteDirection.Downvote;
        vm.prank(voter);
        try reg.vote(id, dir) {} catch { /* PosterCannotVote, NoVoteChange, PostIsRemoved, NotWhitelisted ok */ }
    }

    function fuzz_unvote(uint256 actorSeed, uint256 postSeed) external {
        if (livePostIds.length == 0) return;
        address voter = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        vm.prank(voter);
        try reg.unvote(id) {} catch { /* NoVoteToRetract, PostIsRemoved, NotWhitelisted ok */ }
    }

    function fuzz_retract(uint256 actorSeed, uint256 postSeed) external {
        if (livePostIds.length == 0) return;
        address actor_ = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        vm.prank(actor_);
        try reg.retract(id) {} catch { /* NotPoster, PostIsRemoved, PostNotFound ok */ }
    }
}
