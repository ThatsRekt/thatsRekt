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
}
