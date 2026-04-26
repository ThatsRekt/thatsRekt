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
}
