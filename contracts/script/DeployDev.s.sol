// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Dev/testnet variant of `Deploy.s.sol` that accepts an EOA as
///         `GOVERNANCE_OWNER`. Mirrors the production deploy in every way
///         except (a) it does NOT require the owner to be a contract, and
///         (b) it uses dev-namespaced CREATE2 salts so dev deploys can
///         never collide with production deploys at the same address.
///
///         By default, the same EOA fills proposer/executor on BOTH
///         timelocks AND holds the `whitelistRemover` slot directly —
///         single-principal dev workflow, no cold wallet to manage.
///         Pass `WHITELIST_OPERATOR` to split the roles (multisig
///         stand-in vs cold wallet stand-in) and exercise the exact
///         prod env-var contract on testnet — useful for mainnet
///         rehearsals.
///
///         Recommended dev EOA: Anvil default account 0
///           address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///           mnemonic: test test test test test test test test test test test junk
///         Reproducible across machines, no secret to manage. NEVER use
///         this on mainnet.
///
///         Env vars:
///           * GOVERNANCE_OWNER     (required)  — EOA or contract. Becomes
///                                                upgrade TLC proposer/executor.
///           * WHITELIST_OPERATOR   (optional)  — EOA or contract. Becomes
///                                                add TLC proposer/executor +
///                                                whitelistRemover. Defaults
///                                                to GOVERNANCE_OWNER.
///           * INITIAL_WHITELISTERS (optional)  — comma-separated address list.
contract DeployDev is Script {
    /*//////////////////////////////////////////////////////////////
                            DEV-NAMESPACED SALTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Versioned per impl deploy. Bump on every new impl version.
    bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.dev.v1.0.0");

    /// @dev 7-day TimelockController (owner slot). Bump on bytecode/config change.
    bytes32 public constant UPGRADE_TIMELOCK_SALT = keccak256("thatsRekt.upgradeTimelock.dev.v1");

    /// @dev 3-day TimelockController (whitelistAdmin slot). Bump on bytecode/config change.
    bytes32 public constant ADD_TIMELOCK_SALT = keccak256("thatsRekt.addTimelock.dev.v1");

    /// @dev Unversioned — the canonical dev proxy address. Same across
    ///      every testnet that runs DeployDev with the same
    ///      GOVERNANCE_OWNER + INITIAL_WHITELISTERS.
    bytes32 public constant PROXY_SALT = keccak256("thatsRekt.proxy.dev");

    /// @dev Identical to production. Keeping the delays matched means
    ///      upgrade and rotation flows behave the same on testnet as on
    ///      mainnet. For tight dev loops on Anvil, advance time with
    ///      `vm.warp` / `evm_increaseTime` instead of shortening these.
    uint256 public constant UPGRADE_DELAY = 7 days;
    uint256 public constant ADD_DELAY     = 3 days;

    /// @notice CLI entrypoint — reads `GOVERNANCE_OWNER` (required) and
    ///         `WHITELIST_OPERATOR` (optional, defaults to owner) from
    ///         env and deploys. Matches production Deploy.s.sol's
    ///         env-var contract.
    function run() external {
        address owner = vm.envAddress("GOVERNANCE_OWNER");
        require(owner != address(0), "GOVERNANCE_OWNER env var is zero");
        address operator = _readOperatorOrDefault(owner);
        deploy(owner, operator);
    }

    /// @notice Programmatic entrypoint — used by tests, by `forge script
    ///         --sig "deploy(address,address)" ...`, and by any caller
    ///         that already has both addresses in hand. Avoids the env
    ///         indirection (and its parallel-test pitfalls).
    /// @dev    NOTE: deliberately NO `code.length > 0` check here —
    ///         that's the sole behavioral difference vs production
    ///         Deploy.s.sol. EOAs are accepted; contracts are also fine
    ///         if you want real Safes on a testnet for parity.
    /// @param  owner    Becomes upgrade TLC proposer/executor.
    /// @param  operator Becomes add TLC proposer/executor AND
    ///                  `whitelistRemover`. Pass the same address as
    ///                  `owner` for the single-principal dev model.
    function deploy(address owner, address operator) public {
        require(owner != address(0), "owner is zero");
        require(operator != address(0), "operator is zero");

        address[] memory initialWhitelisters = _readInitialWhitelisters();

        // === 1. Implementation.
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl");

        // === 2. Upgrade TimelockController — owner as proposer/executor.
        address[] memory upgradeProposers = new address[](1);
        upgradeProposers[0] = owner;
        address[] memory upgradeExecutors = new address[](1);
        upgradeExecutors[0] = owner;
        bytes memory upgradeTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(UPGRADE_DELAY, upgradeProposers, upgradeExecutors, address(0))
        );
        address upgradeTimelock = _create2(UPGRADE_TIMELOCK_SALT, upgradeTLInitCode, "upgradeTimelock");

        // === 3. Add TimelockController — operator as proposer/executor.
        address[] memory addProposers = new address[](1);
        addProposers[0] = operator;
        address[] memory addExecutors = new address[](1);
        addExecutors[0] = operator;
        bytes memory addTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(ADD_DELAY, addProposers, addExecutors, address(0))
        );
        address addTimelock = _create2(ADD_TIMELOCK_SALT, addTLInitCode, "addTimelock");

        // === 4. ERC1967Proxy.
        //   - owner            = upgradeTimelock (7-day)
        //   - whitelistAdmin   = addTimelock     (3-day, operator-proposed)
        //   - whitelistRemover = operator        (instant)
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (upgradeTimelock, addTimelock, operator, initialWhitelisters)
        );
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy");

        console2.log("=== DeployDev (testnet / dev) ===");
        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", upgradeTimelock);
        console2.log("Add TLC (3-day):       ", addTimelock);
        console2.log("Owner (gov):           ", owner);
        console2.log("Operator (whitelister):", operator);
        console2.log("Proxy:                 ", proxy);
        console2.log("Initial whitelisters:  ", initialWhitelisters.length);
        for (uint256 i; i < initialWhitelisters.length; ++i) {
            console2.log("  -", initialWhitelisters[i]);
        }
        console2.log("");
        console2.log("Indexer config:");
        console2.log("  CONTRACT_<chain>=     ", proxy);
        console2.log("  START_BLOCK_<chain>=  ", block.number);
    }

    /// @dev Backwards-compatible single-arg overload — kept so existing
    ///      tests / scripts that call `deploy(address)` still work.
    ///      Uses the same address for owner and operator (single-
    ///      principal dev model).
    function deploy(address owner) public {
        deploy(owner, owner);
    }

    /// @dev Reads `WHITELIST_OPERATOR` env. Empty/unset → fallback.
    function _readOperatorOrDefault(address fallbackAddr) internal view returns (address) {
        try vm.envAddress("WHITELIST_OPERATOR") returns (address op) {
            return op == address(0) ? fallbackAddr : op;
        } catch {
            return fallbackAddr;
        }
    }

    /// @dev See Deploy.s.sol. Empty/unset → empty array.
    function _readInitialWhitelisters() internal view returns (address[] memory) {
        try vm.envString("INITIAL_WHITELISTERS") returns (string memory raw) {
            if (bytes(raw).length == 0) return new address[](0);
            return vm.envAddress("INITIAL_WHITELISTERS", ",");
        } catch {
            return new address[](0);
        }
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
