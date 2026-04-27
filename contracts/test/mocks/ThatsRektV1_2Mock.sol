// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ThatsRekt} from "../../src/ThatsRekt.sol";

/// @notice Mock impl that adds a new mapping by reducing the storage gap by 1.
///         Used to test that __gap reservation prevents storage collisions when
///         a real upgrade introduces new state.
/// @dev    In OZ's UUPS pattern, child impls inherit ALL state of the parent
///         including `__gap`. The new field `postCountByPoster` lands at the
///         slot the gap previously reserved (the slot just past the parent's
///         last sequential state var). The gap is "spent" by the addition,
///         which is exactly the safe upgrade pattern the gap exists for.
///
///         Do NOT also redeclare `__gap` in this contract — it would cause
///         a parent/child storage collision. The gap shrinks implicitly at
///         the source level by virtue of new state being appended below it
///         in the inherited layout.
contract ThatsRektV1_2Mock is ThatsRekt {
    /// @dev New state — claims one slot from the parent's `__gap[50]`,
    ///      shrinking the effective gap to 49 unused slots.
    mapping(address => uint256) public postCountByPoster;

    /// @notice Manual setter so the test can write the new field through
    ///         the proxy without depending on production posting paths.
    function bumpPosterCount(address poster) external {
        unchecked { ++postCountByPoster[poster]; }
    }
}
