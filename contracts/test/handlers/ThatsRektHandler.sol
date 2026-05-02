// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {ThatsRekt} from "../../src/ThatsRekt.sol";

/// @notice Bounded-action handler driving ThatsRekt under invariant fuzzing.
contract ThatsRektHandler is Test {
    ThatsRekt public immutable reg;

    address[] public actors;
    uint256[] public livePostIds;

    /// Count of successful posts the handler observed. Compared against
    /// `reg.postCount()` in the invariant — they must always match.
    uint256 public successfulPosts;

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

        uint256 _expectedPid = reg.peekNextPostId();
        vm.prank(poster);
        try reg.post(_expectedPid, "test title", atk, vic, "", uint64(block.timestamp)) returns (uint256 id) {
            livePostIds.push(id);
            unchecked { ++successfulPosts; }
        } catch { /* expected: NotWhitelisted, etc. */ }
    }

    function fuzz_vote(uint256 actorSeed, uint256 postSeed, bool isUpConfirm) external {
        if (livePostIds.length == 0) return;
        address voter = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        ThatsRekt.ConfirmDirection dir = isUpConfirm
            ? ThatsRekt.ConfirmDirection.Up
            : ThatsRekt.ConfirmDirection.Down;
        vm.prank(voter);
        try reg.confirm(id, dir) {} catch { /* PosterCannotConfirm, NoConfirmationChange, PostIsRemoved, NotWhitelisted ok */ }
    }

    function fuzz_unvote(uint256 actorSeed, uint256 postSeed) external {
        if (livePostIds.length == 0) return;
        address voter = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        vm.prank(voter);
        try reg.unconfirm(id) {} catch { /* NothingToUnconfirm, PostIsRemoved, NotWhitelisted ok */ }
    }

    function fuzz_retract(uint256 actorSeed, uint256 postSeed) external {
        if (livePostIds.length == 0) return;
        address actor_ = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        vm.prank(actor_);
        try reg.retract(id) {} catch { /* NotPoster, PostIsRemoved, PostNotFound ok */ }
    }

    function fuzz_amendNote(uint256 actorSeed, uint256 postSeed, uint256 noteSeed) external {
        if (livePostIds.length == 0) return;
        address actor_ = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        string memory note = noteSeed % 2 == 0 ? "amend-a" : "amend-b";
        vm.prank(actor_);
        try reg.amendNote(id, note) {} catch {
            /* NotPoster, PostIsRemoved, PostNotFound, NotWhitelisted ok */
        }
    }

    function fuzz_addAttackers(uint256 actorSeed, uint256 postSeed, uint256 nNew) external {
        if (livePostIds.length == 0) return;
        address actor_ = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        nNew = bound(nNew, 1, 3);
        address[] memory adds = new address[](nNew);
        // unique-per-call seed avoids self-batch duplicates for the common
        // case; the contract still validates and reverts cleanly if a
        // cross-post duplicate or other error lands.
        for (uint256 i; i < nNew; ++i) {
            adds[i] = address(uint160(0xF000 + actorSeed + postSeed + i));
        }
        vm.prank(actor_);
        try reg.addAttackers(id, adds) {} catch {
            /* NotPoster, PostIsRemoved, PostNotFound, NotWhitelisted, EmptyAdditions, DuplicateAddress, ZeroAddress, PostTooLarge ok */
        }
    }

    function fuzz_addVictims(uint256 actorSeed, uint256 postSeed, uint256 nNew) external {
        if (livePostIds.length == 0) return;
        address actor_ = _actor(actorSeed);
        uint256 id = livePostIds[postSeed % livePostIds.length];
        nNew = bound(nNew, 1, 3);
        address[] memory adds = new address[](nNew);
        for (uint256 i; i < nNew; ++i) {
            adds[i] = address(uint160(0xF800 + actorSeed + postSeed + i));
        }
        vm.prank(actor_);
        try reg.addVictims(id, adds) {} catch {
            /* NotPoster, PostIsRemoved, PostNotFound, NotWhitelisted, EmptyAdditions, DuplicateAddress, ZeroAddress, PostTooLarge ok */
        }
    }
}
