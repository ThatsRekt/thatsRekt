// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Pure off-chain prediction of the canonical CREATE2 addresses
///         that `Deploy.s.sol` would produce for a given (multisig,
///         operator, initial-whitelisters) tuple. Doesn't deploy
///         anything; just logs predictions so we can verify what we're
///         about to ship before broadcasting.
///
///         Reads the same env vars as `Deploy.s.sol` so the prediction
///         uses the exact init code the real deploy will produce.
contract PredictAddresses is Script {
    function run() external view {
        Deploy d = Deploy(address(0)); // sentinel — only used for salt constants
        // ^ can't read `d.IMPL_SALT()` without a real instance; so we
        //   inline the salts here. They MUST match Deploy.s.sol
        //   exactly. Keep in sync.
        bytes32 IMPL_SALT             = keccak256("thatsRekt.impl.v1.0.0");
        bytes32 UPGRADE_TIMELOCK_SALT = keccak256("thatsRekt.upgradeTimelock.v1");
        bytes32 ADD_TIMELOCK_SALT     = keccak256("thatsRekt.addTimelock.v1");
        bytes32 PROXY_SALT            = keccak256("thatsRekt.proxy");

        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        address operator = vm.envAddress("WHITELIST_OPERATOR");
        address[] memory initialWhitelisters;
        try vm.envString("INITIAL_WHITELISTERS") returns (string memory raw) {
            if (bytes(raw).length == 0) {
                initialWhitelisters = new address[](0);
            } else {
                initialWhitelisters = vm.envAddress("INITIAL_WHITELISTERS", ",");
            }
        } catch {
            initialWhitelisters = new address[](0);
        }

        // 1. impl
        bytes32 implHash = keccak256(type(ThatsRekt).creationCode);
        address impl = computeCreate2Address(IMPL_SALT, implHash, CREATE2_FACTORY);

        // 2. upgrade TLC (multisig as proposer)
        address[] memory upProp = new address[](1); upProp[0] = multisig;
        address[] memory upExec = new address[](1); upExec[0] = multisig;
        bytes32 upHash = keccak256(abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(uint256(7 days), upProp, upExec, address(0))
        ));
        address upgradeTL = computeCreate2Address(UPGRADE_TIMELOCK_SALT, upHash, CREATE2_FACTORY);

        // 3. add TLC (operator as proposer)
        address[] memory addProp = new address[](1); addProp[0] = operator;
        address[] memory addExec = new address[](1); addExec[0] = operator;
        bytes32 addHash = keccak256(abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(uint256(3 days), addProp, addExec, address(0))
        ));
        address addTL = computeCreate2Address(ADD_TIMELOCK_SALT, addHash, CREATE2_FACTORY);

        // 4. proxy
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (upgradeTL, addTL, operator, initialWhitelisters)
        );
        bytes32 proxyHash = keccak256(abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        ));
        address proxy = computeCreate2Address(PROXY_SALT, proxyHash, CREATE2_FACTORY);

        console2.log("=== Predicted CREATE2 addresses (PROD salts) ===");
        console2.log("Multisig (gov):        ", multisig);
        console2.log("Operator (whitelister):", operator);
        console2.log("Initial whitelisters:  ", initialWhitelisters.length);
        for (uint256 i; i < initialWhitelisters.length; ++i) {
            console2.log("  -", initialWhitelisters[i]);
        }
        console2.log("");
        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", upgradeTL);
        console2.log("Add TLC (3-day):       ", addTL);
        console2.log("Proxy (canonical):     ", proxy);
        // Suppress unused-variable warning for the sentinel.
        d;
    }
}
