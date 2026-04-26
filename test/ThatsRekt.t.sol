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
}
