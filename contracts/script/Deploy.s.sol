// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Four-stage deterministic deploy of the v1 upgradeable system:
///         (1) implementation, (2) upgrade TimelockController (7-day),
///         (3) add TimelockController (3-day), (4) ERC1967Proxy. All
///         four use CREATE2 via the singleton factory (`CREATE2_FACTORY`
///         from forge-std/Base.sol) so addresses are identical on every
///         chain that runs this script with the same `GOVERNANCE_OWNER`
///         and the same `INITIAL_WHITELISTERS`.
///
///         Three-role governance (asymmetric delays):
///           * `owner`            = upgrade TLC (7-day) — `_authorizeUpgrade`
///                                  and 7-day re-install path for the
///                                  whitelistAdmin slot.
///           * `whitelistAdmin`   = add TLC (3-day) — adds posters and
///                                  self-rotates. 3 days from proposal
///                                  to effect.
///           * `whitelistRemover` = multisig directly — instant remove
///                                  + instant kill-switch on the
///                                  whitelistAdmin slot.
///
///         Both timelocks have the multisig as proposer + executor;
///         admin = address(0) (the contracts themselves), so role
///         changes can only happen via timelocked proposals.
///
///         The CREATE2 address of the proxy depends on the
///         `initialWhitelisters` array: same set on every chain → same
///         proxy address on every chain. Pre-population at init is the
///         only legitimate bypass of the 3-day add timelock.
///
///         Env vars:
///           * GOVERNANCE_OWNER     (required) — Safe address. Must have code.
///           * INITIAL_WHITELISTERS (optional) — comma-separated address list,
///                                              e.g. "0xabc...,0xdef...".
///                                              Empty/unset → no pre-pop.
contract Deploy is Script {
    /*//////////////////////////////////////////////////////////////
                                 SALTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Versioned per impl deploy. Bump on every new implementation
    ///      version (e.g. `thatsRekt.impl.v1.1.0`) so the new impl can
    ///      coexist alongside the old one and the upgrade tx flips the
    ///      proxy from one to the other.
    bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.v1.0.0");

    /// @dev 7-day TimelockController. Holds the `owner` slot — controls
    ///      upgrades and the 7-day re-install path for whitelistAdmin.
    ///      Bump only if its bytecode/config changes (rare — delay
    ///      tweaks happen through this timelock itself, not via
    ///      redeploy).
    bytes32 public constant UPGRADE_TIMELOCK_SALT = keccak256("thatsRekt.upgradeTimelock.v1");

    /// @dev 3-day TimelockController. Holds the `whitelistAdmin` slot —
    ///      adds posters and self-rotates. Bump only if its
    ///      bytecode/config changes.
    bytes32 public constant ADD_TIMELOCK_SALT = keccak256("thatsRekt.addTimelock.v1");

    /// @dev NOT versioned — the proxy is the canonical permanent address
    ///      that integrators bake in. Never change this salt.
    bytes32 public constant PROXY_SALT = keccak256("thatsRekt.proxy");

    /*//////////////////////////////////////////////////////////////
                                DELAYS
    //////////////////////////////////////////////////////////////*/

    /// @dev Upgrade window. 7 days is the industry-standard middle
    ///      ground (Uniswap, Aave, Compound use 2-7 day windows).
    ///      Adjustable post-deploy via the timelock itself.
    uint256 public constant UPGRADE_DELAY = 7 days;

    /// @dev Add window. 3 days is short enough that a fresh poster can
    ///      be onboarded in normal-time, long enough that integrators
    ///      can react to a hostile rotation before it lands.
    uint256 public constant ADD_DELAY = 3 days;

    function run() external {
        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        require(multisig != address(0), "GOVERNANCE_OWNER env var is zero");
        require(multisig.code.length > 0, "GOVERNANCE_OWNER has no code (must be a Safe / contract)");

        address[] memory initialWhitelisters = _readInitialWhitelisters();

        // === 1. Implementation (no constructor args -> deterministic init code).
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl");

        // === 2 & 3. Two TimelockControllers — same proposer/executor
        // (multisig), different delays. Admin = address(0) means there is
        // no DEFAULT_ADMIN_ROLE holder beyond each timelock contract
        // itself, so role changes can only happen via a timelocked
        // proposal. Standard secure config.
        address[] memory proposers = new address[](1);
        proposers[0] = multisig;
        address[] memory executors = new address[](1);
        executors[0] = multisig;

        bytes memory upgradeTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(UPGRADE_DELAY, proposers, executors, address(0))
        );
        address upgradeTimelock = _create2(UPGRADE_TIMELOCK_SALT, upgradeTLInitCode, "upgradeTimelock");

        bytes memory addTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(ADD_DELAY, proposers, executors, address(0))
        );
        address addTimelock = _create2(ADD_TIMELOCK_SALT, addTLInitCode, "addTimelock");

        // === 4. ERC1967Proxy.
        //   - owner            = upgradeTimelock (7-day)
        //   - whitelistAdmin   = addTimelock     (3-day)
        //   - whitelistRemover = multisig        (instant)
        //   - initialWhitelisters = pre-populated at init
        // The proxy's init code embeds (impl, initCalldata); both parts
        // are identical across chains for the same multisig + initial
        // list, so the CREATE2 address is identical.
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (upgradeTimelock, addTimelock, multisig, initialWhitelisters)
        );
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy");

        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", upgradeTimelock);
        console2.log("Add TLC (3-day):       ", addTimelock);
        console2.log("Multisig (remover):    ", multisig);
        console2.log("Proxy:                 ", proxy);
        console2.log("Initial whitelisters:  ", initialWhitelisters.length);
        for (uint256 i; i < initialWhitelisters.length; ++i) {
            console2.log("  -", initialWhitelisters[i]);
        }
    }

    /// @dev Reads `INITIAL_WHITELISTERS` env as a comma-separated
    ///      address list. Empty/unset → empty array.
    function _readInitialWhitelisters() internal view returns (address[] memory) {
        try vm.envString("INITIAL_WHITELISTERS") returns (string memory raw) {
            if (bytes(raw).length == 0) return new address[](0);
            return vm.envAddress("INITIAL_WHITELISTERS", ",");
        } catch {
            return new address[](0);
        }
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
