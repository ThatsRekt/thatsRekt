// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Deploy} from "./Deploy.s.sol";

/// @notice Pure off-chain prediction of the canonical CREATE2 addresses
///         that `Deploy.s.sol` would produce for a given (deployer,
///         multisig, operator, purgeRemover, initial-whitelisters)
///         tuple. Doesn't deploy anything; just logs predictions so we
///         can verify what we're about to ship before broadcasting.
///
///         === Deployer included in init code ===
///         The cross-canceller role split (see Deploy.s.sol) requires
///         the deployer EOA to be the temporary DEFAULT_ADMIN of every
///         TLC during the 4-step admin dance. The deployer address is
///         baked into each TLC's constructor args, so it's now part of
///         the CREATE2 init code hash → must be passed in here too.
///
///         The proxy address depends on the predicted TLC addresses,
///         which depend on the deployer, so a different deployer EOA
///         yields a different canonical proxy. Production deploys must
///         use the same deployer EOA on every chain to keep the proxy
///         identical across chains.
///
///         Reads the same env vars as `Deploy.s.sol` plus
///         `DEPLOYER_ADDRESS` (required) so the prediction matches
///         exactly what the real deploy will produce.
contract PredictAddresses is Script {
    function run() external view {
        Deploy d = Deploy(address(0)); // sentinel — only used for salt constants
        // ^ can't read `d.IMPL_SALT()` without a real instance; so we
        //   inline the salts here. They MUST match Deploy.s.sol
        //   exactly. Keep in sync.
        bytes32 implSalt            = keccak256("thatsRekt.impl.v1.2.0");
        bytes32 upgradeTimelockSalt = keccak256("thatsRekt.upgradeTimelock.v3");
        bytes32 addTimelockSalt     = keccak256("thatsRekt.addTimelock.v3");
        bytes32 purgeTimelockSalt   = keccak256("thatsRekt.purgeTimelock.v3");
        bytes32 proxySalt           = keccak256("thatsRekt.proxy.v3");

        address deployerAddr = vm.envAddress("DEPLOYER_ADDRESS");
        require(deployerAddr != address(0), "DEPLOYER_ADDRESS env var is zero");

        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        address operator = vm.envAddress("WHITELIST_OPERATOR");
        // Match Deploy.s.sol: env-or-default. Duplicate the literal — must
        // stay in sync with Deploy.DEFAULT_PURGE_REMOVER_EOA.
        address purgeRemoverEOA;
        try vm.envAddress("PURGE_REMOVER_EOA") returns (address eoa) {
            purgeRemoverEOA = eoa == address(0)
                ? 0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4
                : eoa;
        } catch {
            purgeRemoverEOA = 0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4;
        }
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

        // Shared executor list: [multisig, address(0)] — anyone can execute
        // after the delay elapses. MUST match Deploy.s.sol's
        // `sharedExecutors`.
        address[] memory sharedExecutors = new address[](2);
        sharedExecutors[0] = multisig;
        sharedExecutors[1] = address(0);

        // 1. impl
        bytes32 implHash = keccak256(type(ThatsRekt).creationCode);
        address impl = computeCreate2Address(implSalt, implHash, CREATE2_FACTORY);

        // 2. upgrade TLC (multisig as proposer; deployer as temp admin).
        address[] memory upProp = new address[](1); upProp[0] = multisig;
        bytes32 upHash = keccak256(abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(uint256(7 days), upProp, sharedExecutors, deployerAddr)
        ));
        address upgradeTl = computeCreate2Address(upgradeTimelockSalt, upHash, CREATE2_FACTORY);

        // 3. add TLC (multisig as proposer; deployer as temp admin).
        address[] memory addProp = new address[](1); addProp[0] = multisig;
        bytes32 addHash = keccak256(abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(uint256(3 days), addProp, sharedExecutors, deployerAddr)
        ));
        address addTl = computeCreate2Address(addTimelockSalt, addHash, CREATE2_FACTORY);

        // 4. purge TLC (purge remover EOA as proposer; deployer as temp admin).
        address[] memory purgeProp = new address[](1); purgeProp[0] = purgeRemoverEOA;
        bytes32 purgeHash = keccak256(abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(uint256(1 days), purgeProp, sharedExecutors, deployerAddr)
        ));
        address purgeTl = computeCreate2Address(purgeTimelockSalt, purgeHash, CREATE2_FACTORY);

        // 5. proxy
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (upgradeTl, addTl, operator, purgeTl, purgeRemoverEOA, initialWhitelisters)
        );
        bytes32 proxyHash = keccak256(abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        ));
        address proxy = computeCreate2Address(proxySalt, proxyHash, CREATE2_FACTORY);

        console2.log("=== Predicted CREATE2 addresses (PROD salts) ===");
        console2.log("Deployer EOA:          ", deployerAddr);
        console2.log("Multisig (gov):        ", multisig);
        console2.log("Operator (whitelister):", operator);
        console2.log("Purge remover EOA:     ", purgeRemoverEOA);
        console2.log("Cross-cancellers:");
        console2.log("  upgrade canceller:   ", operator);
        console2.log("  add     canceller:   ", operator);
        console2.log("  purge   canceller:   ", multisig);
        console2.log("Initial whitelisters:  ", initialWhitelisters.length);
        for (uint256 i; i < initialWhitelisters.length; ++i) {
            console2.log("  -", initialWhitelisters[i]);
        }
        console2.log("");
        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", upgradeTl);
        console2.log("Add TLC (3-day):       ", addTl);
        console2.log("Purge TLC (1-day):     ", purgeTl);
        console2.log("Proxy (canonical):     ", proxy);
        // Suppress unused-variable warning for the sentinel.
        d;
    }
}
