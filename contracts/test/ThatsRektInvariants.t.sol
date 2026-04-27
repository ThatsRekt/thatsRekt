// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {ThatsRektHandler} from "./handlers/ThatsRektHandler.sol";

contract ThatsRektInvariants is Test {
    ThatsRekt public reg;
    ThatsRektHandler public handler;
    address public governance;
    address[] public actors;

    function setUp() public {
        governance = makeAddr("governance");
        ThatsRekt impl = new ThatsRekt();
        bytes memory initCalldata = abi.encodeCall(ThatsRekt.initialize, (governance));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCalldata);
        reg = ThatsRekt(address(proxy));

        for (uint256 i; i < 5; ++i) {
            address a = address(uint160(0xACC0 + i));
            actors.push(a);
            vm.prank(governance);
            reg.addWhitelisted(a);
        }

        handler = new ThatsRektHandler(reg, actors);
        targetContract(address(handler));
    }

    /// I5/I7/I8: head/tail consistency
    function invariant_listEndsAreNullPointers() public view {
        uint256 head = reg.headPostId();
        uint256 tail = reg.tailPostId();
        if (head == 0) {
            assertEq(tail, 0, "head==0 implies tail==0");
        } else {
            assertEq(reg.prevPostId(head), 0, "head.prev must be 0");
        }
        if (tail != 0) {
            assertEq(reg.nextPostId(tail), 0, "tail.next must be 0");
        }
    }

    /// I3: every live post's listed victims must be flagged as victims
    function invariant_isVictim_consistentWithLiveVictim() public view {
        uint256 max = reg.postCount();
        if (max > 50) max = 50;
        for (uint256 id = 1; id <= max; ++id) {
            (address poster, , , , bool removed, , address[] memory vics, ) = reg.getPost(id);
            if (poster == address(0)) continue;
            if (removed) continue;
            for (uint256 i; i < vics.length; ++i) {
                assertTrue(reg.isVictim(vics[i]), "live victim must be flagged");
            }
        }
    }

    /// I12: cap on addresses-per-post (anything that landed must satisfy the cap)
    function invariant_postSizeRespectsCap() public view {
        uint256 max = reg.postCount();
        if (max > 50) max = 50;
        uint256 cap = reg.MAX_ADDRESSES_PER_POST();
        for (uint256 id = 1; id <= max; ++id) {
            (address poster, , , , , address[] memory atk, address[] memory vic, ) = reg.getPost(id);
            if (poster == address(0)) continue;
            assertLe(atk.length + vic.length, cap, "post exceeds size cap");
        }
    }

    /// I14: poster never has voteOf entry on own post
    function invariant_posterNeverVotedOnOwnPost() public view {
        uint256 max = reg.postCount();
        if (max > 50) max = 50;
        for (uint256 id = 1; id <= max; ++id) {
            (address poster, , , , , , , ) = reg.getPost(id);
            if (poster == address(0)) continue;
            assertTrue(
                reg.voteOf(id, poster) == ThatsRekt.VoteDirection.None,
                "poster voted on own post"
            );
        }
    }

    /// I15: per-post upvoter/downvoter set cardinality must match the
    /// `upvotes`/`downvotes` counters across every vote, flip, and unvote.
    function invariant_voterSetLengthsMatchCounters() public view {
        uint256 max = reg.postCount();
        if (max > 50) max = 50;
        for (uint256 id = 1; id <= max; ++id) {
            (address poster, , uint32 up, uint32 down, , , , ) = reg.getPost(id);
            if (poster == address(0)) continue;
            assertEq(reg.getUpvoterCount(id),   uint256(up),   "upvoter set length must equal post.upvotes");
            assertEq(reg.getDownvoterCount(id), uint256(down), "downvoter set length must equal post.downvotes");
        }
    }
}
