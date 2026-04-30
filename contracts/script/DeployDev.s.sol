// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Dev/testnet variant of `Deploy.s.sol` that accepts an EOA as
///         `GOVERNANCE_OWNER`. Mirrors the production deploy in every way
///         except (a) it does NOT require the owner to be a contract, and
///         (b) it uses a distinct set of CREATE2 salts so dev deploys can
///         never collide with production deploys at the same address.
///
///         Use case: spinning up thatsRekt on Sepolia or a local Anvil
///         fork without standing up a Safe. The EOA holds the timelock's
///         proposer / executor / canceller roles directly. Upgrades still
///         go through the 7-day timelock — testnet behavior matches
///         production behavior exactly.
///
///         Recommended dev EOA: Anvil default account 0
///           address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///           mnemonic: test test test test test test test test test test test junk
///         Reproducible across machines, no secret to manage. NEVER use
///         this on mainnet.
///
///         Same EOA across Anvil + Sepolia ⇒ identical thatsRekt CREATE2
///         address on both, convenient for parity testing.
contract DeployDev is Script {
    /*//////////////////////////////////////////////////////////////
                            DEV-NAMESPACED SALTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Versioned per impl deploy. Bump on every new impl version.
    bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.dev.v1.0.0");

    /// @dev Versioned per timelock deploy. Bump only if the
    ///      TimelockController's bytecode/config changes.
    bytes32 public constant TIMELOCK_SALT = keccak256("thatsRekt.timelock.dev.v1");

    /// @dev Unversioned — the canonical dev proxy address. Same across
    ///      every testnet that runs DeployDev with the same
    ///      GOVERNANCE_OWNER.
    bytes32 public constant PROXY_SALT = keccak256("thatsRekt.proxy.dev");

    /// @dev Identical to production's 7 days. Keeping the delay matches
    ///      means upgrade flows behave the same on testnet as on mainnet.
    ///      For tight dev loops on Anvil, advance time with
    ///      `vm.warp` / `evm_increaseTime` instead of shortening this.
    uint256 public constant TIMELOCK_DELAY = 7 days;

    /// @notice CLI entrypoint — reads `GOVERNANCE_OWNER` from env and
    ///         deploys. This is the path `forge script` takes when
    ///         invoked without arguments (matches production Deploy.s.sol).
    function run() external {
        address owner = vm.envAddress("GOVERNANCE_OWNER");
        require(owner != address(0), "GOVERNANCE_OWNER env var is zero");
        deploy(owner);
    }

    /// @notice Programmatic entrypoint — used by tests, by `forge script
    ///         --sig "deploy(address)" ...`, and by any caller that
    ///         already has the owner address in hand. Avoids the env
    ///         indirection (and its parallel-test pitfalls).
    /// @dev    NOTE: deliberately NO `code.length > 0` check here —
    ///         that's the sole behavioral difference vs production
    ///         Deploy.s.sol. EOAs are accepted; contracts are also fine
    ///         if you want a real Safe on a testnet for parity.
    function deploy(address owner) public {
        require(owner != address(0), "owner is zero");

        // === 1. Implementation.
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl");

        // === 2. TimelockController. Owner holds proposer + executor +
        // canceller. Admin = address(0) so role changes can only happen
        // via a timelocked proposal. Same secure config as production.
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = owner;
        bytes memory tlInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(TIMELOCK_DELAY, proposers, executors, address(0))
        );
        address timelock = _create2(TIMELOCK_SALT, tlInitCode, "timelock");

        // === 3. ERC1967Proxy.
        //   - owner            = timelock (upgrade authority, 7-day gated)
        //   - whitelistAdmin   = the EOA directly (instant whitelist mgmt
        //                        — same operational model as prod where
        //                        the multisig holds whitelist authority)
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (timelock, owner)
        );
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy");

        console2.log("=== DeployDev (testnet / dev) ===");
        console2.log("Implementation:    ", impl);
        console2.log("TimelockController:", timelock);
        console2.log("Proxy:             ", proxy);
        console2.log("EOA owner:         ", owner);
        console2.log("Timelock delay:    ", TIMELOCK_DELAY);
        console2.log("");
        console2.log("Indexer config:");
        console2.log("  CONTRACT_<chain>=     ", proxy);
        console2.log("  START_BLOCK_<chain>=  ", block.number);
    }

    /// @dev See Deploy.s.sol for rationale. Idempotent — returns the
    ///      predicted address if it's already deployed.
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
