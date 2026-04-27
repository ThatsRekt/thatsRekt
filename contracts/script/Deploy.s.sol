// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Three-stage deterministic deploy of the v1 upgradeable system:
///         (1) implementation, (2) TimelockController, (3) ERC1967Proxy.
///         All three deployments use CREATE2 via the singleton factory
///         (`CREATE2_FACTORY = 0x4e59...` inherited from forge-std/Base.sol)
///         so the addresses are identical on every chain that runs this
///         script with the same `GOVERNANCE_OWNER` (the multisig).
///
///         The proxy is the canonical permanent address. Implementations
///         can be replaced via timelocked upgrade proposals; the
///         TimelockController itself is a one-time deploy unless its
///         contract changes (then bump TIMELOCK_SALT).
///
///         Trust model: multisig holds proposer + executor + canceller
///         roles on the timelock; admin role is `address(0)` (the
///         contract itself), so role changes can only happen via a
///         timelocked proposal. The multisig has no direct upgrade
///         authority — every upgrade goes through the 7-day timelock
///         window first, giving integrators time to react.
contract Deploy is Script {
    /*//////////////////////////////////////////////////////////////
                                 SALTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Versioned per impl deploy. Bump on every new implementation
    ///      version (e.g. `thatsRekt.impl.v1.1.0`) so the new impl can
    ///      coexist alongside the old one and the upgrade tx flips the
    ///      proxy from one to the other.
    bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.v1.0.0");

    /// @dev Versioned per timelock deploy. Bump only if the
    ///      TimelockController's bytecode/config changes (rare —
    ///      delay tweaks happen through the timelock itself, not via
    ///      redeploy).
    bytes32 public constant TIMELOCK_SALT = keccak256("thatsRekt.timelock.v1");

    /// @dev NOT versioned — the proxy is the canonical permanent address
    ///      that integrators bake in. Never change this salt.
    bytes32 public constant PROXY_SALT = keccak256("thatsRekt.proxy");

    /// @dev Window between proposing and executing an upgrade. 7 days is
    ///      the industry-standard middle ground (Uniswap, Aave, Compound
    ///      use 2-7 day windows). Adjustable via timelocked proposal
    ///      after deploy, so this is just the initial value.
    uint256 public constant TIMELOCK_DELAY = 7 days;

    function run() external {
        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        require(multisig != address(0), "GOVERNANCE_OWNER env var is zero");
        require(multisig.code.length > 0, "GOVERNANCE_OWNER has no code (must be a Safe / contract)");

        // === 1. Implementation (no constructor args -> deterministic init code).
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl");

        // === 2. TimelockController.
        // Multisig holds proposer + executor + canceller; admin = address(0)
        // means there is no DEFAULT_ADMIN_ROLE holder beyond the timelock
        // contract itself, so role changes can only happen via a timelocked
        // proposal. Standard secure config.
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;
        bytes memory tlInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(TIMELOCK_DELAY, proposers, executors, address(0))
        );
        address timelock = _create2(TIMELOCK_SALT, tlInitCode, "timelock");

        // === 3. ERC1967Proxy. Owner = timelock, NOT the multisig directly.
        // The proxy's init code embeds (impl, initCalldata); both parts are
        // identical across chains, so the CREATE2 address is identical.
        bytes memory initCalldata = abi.encodeCall(ThatsRekt.initialize, (timelock));
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy");

        console2.log("Implementation:    ", impl);
        console2.log("TimelockController:", timelock);
        console2.log("Proxy:             ", proxy);
        console2.log("Multisig:          ", multisig);
        console2.log("Timelock delay:    ", TIMELOCK_DELAY);
    }

    /// @dev Deploys `initCode` via the singleton CREATE2 factory at `salt`,
    ///      asserting the resulting address matches the computed prediction.
    ///      Idempotent: returns the predicted address if it already has
    ///      code (allowing this script to be re-run on more chains
    ///      without disturbing chains that have already deployed).
    function _create2(bytes32 salt, bytes memory initCode, string memory label) internal returns (address) {
        bytes32 initHash = keccak256(initCode);
        address predicted = computeCreate2Address(salt, initHash, CREATE2_FACTORY);
        if (predicted.code.length > 0) {
            console2.log(string.concat(label, " already deployed:"), predicted);
            return predicted;
        }
        vm.startBroadcast();
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        require(ok, string.concat(label, " deploy failed"));
        vm.stopBroadcast();
        require(predicted.code.length > 0, string.concat(label, " not deployed"));
        return predicted;
    }
}
