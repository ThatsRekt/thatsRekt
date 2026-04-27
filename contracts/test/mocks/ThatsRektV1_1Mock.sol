// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {ThatsRekt} from "../../src/ThatsRekt.sol";

/// @notice Minimal mock impl used to test the upgrade flow. Inherits the
///         full v1.0.0 logic and adds one read-only function that does
///         not exist in v1.0.0; observing a successful call to `version()`
///         on the proxy after an upgrade proves the new bytecode is in
///         use.
/// @dev    Carries no new storage — relying on a new function alone keeps
///         the test focused on the upgrade plumbing rather than storage
///         migration semantics.
contract ThatsRektV1_1Mock is ThatsRekt {
    function version() external pure returns (string memory) {
        return "1.1";
    }
}
