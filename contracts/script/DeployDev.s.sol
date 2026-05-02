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
///         === Cross-canceller role split ===
///         Identical 4-step admin dance as production `Deploy.s.sol`,
///         exercised on testnet so the deploy mechanics are validated
///         before mainnet. Even when one EOA fills every logical role
///         (single-principal dev mode), the dance still runs end-to-end
///         and locks DEFAULT_ADMIN_ROLE — so a green Sepolia rehearsal
///         proves the code path will work on mainnet.
///
///         Cross-canceller mapping (env-driven, defaults below):
///           * Upgrade TLC (7-day):   proposer = DEPLOYDEV_GOVERNANCE_OWNER
///                                              (default: deployer EOA)
///                                    canceller = DEPLOYDEV_WHITELIST_REMOVER
///                                              (default: 0x5822…894c4)
///           * Whitelist-add (3-day): proposer = DEPLOYDEV_GOVERNANCE_OWNER
///                                    canceller = DEPLOYDEV_WHITELIST_REMOVER
///           * Purge TLC (1-day):     proposer = DEPLOYDEV_PURGE_REMOVER
///                                              (default: 0x5822…894c4)
///                                    canceller = DEPLOYDEV_GOVERNANCE_OWNER
///
///         With defaults: deployer proposes upgrades + whitelist; cold
///         wallet cancels them. Cold wallet proposes purges; deployer
///         cancels them. The cross-canceller pattern is non-vacuous on
///         Sepolia, so we can validate both directions before mainnet.
///
///         For a fully single-principal deploy (vacuous cross-canceller,
///         useful for tight Anvil iteration), set every env var to the
///         same address. The dance still runs and renounces — the role
///         config is identically locked, just with one principal on
///         both sides. The mechanics still get exercised.
///
///         Recommended dev EOA: Anvil default account 0
///           address: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
///           mnemonic: test test test test test test test test test test test junk
///         Reproducible across machines, no secret to manage. NEVER use
///         this on mainnet.
///
///         Env vars:
///           * GOVERNANCE_OWNER             (required)  — kept for backwards
///                                                        compatibility; aliased
///                                                        to DEPLOYDEV_GOVERNANCE_OWNER
///                                                        when the latter is unset.
///           * DEPLOYDEV_GOVERNANCE_OWNER   (optional)  — Proposer of upgrade
///                                                        + whitelist TLCs;
///                                                        canceller of purge TLC.
///                                                        Default: GOVERNANCE_OWNER.
///           * DEPLOYDEV_WHITELIST_REMOVER  (optional)  — Canceller of upgrade
///                                                        + whitelist TLCs;
///                                                        `whitelistRemover` slot
///                                                        on the proxy. Default:
///                                                        canonical cold wallet.
///           * DEPLOYDEV_PURGE_REMOVER      (optional)  — Proposer of purge TLC;
///                                                        `purgeRemover` slot on
///                                                        the proxy. Default:
///                                                        canonical cold wallet.
///           * INITIAL_WHITELISTERS         (optional)  — comma-separated address list.
contract DeployDev is Script {
    /*//////////////////////////////////////////////////////////////
                            DEV-NAMESPACED SALTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Versioned per impl deploy. Bump on every new impl version.
    bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.dev.v1.2.0");

    /// @dev 7-day TimelockController (owner slot). Bump on bytecode/config change.
    bytes32 public constant UPGRADE_TIMELOCK_SALT = keccak256("thatsRekt.upgradeTimelock.dev.v2");

    /// @dev 3-day TimelockController (whitelistAdmin slot). Bump on bytecode/config change.
    bytes32 public constant ADD_TIMELOCK_SALT = keccak256("thatsRekt.addTimelock.dev.v2");

    /// @dev 1-day TimelockController (purgeAdmin slot). Bump on bytecode/config change.
    bytes32 public constant PURGE_TIMELOCK_SALT = keccak256("thatsRekt.purgeTimelock.dev.v2");

    /// @dev Versioned dev proxy address (v2). Previous unversioned salt
    ///      `thatsRekt.proxy.dev` is claimed at 0x309c…fb80 with the buggy
    ///      pre-PR-#87/#89 contracts; v2 yields a fresh proxy address.
    bytes32 public constant PROXY_SALT = keccak256("thatsRekt.proxy.dev.v2");

    /// @dev Identical to production. Keeping the delays matched means
    ///      upgrade and rotation flows behave the same on testnet as on
    ///      mainnet. For tight dev loops on Anvil, advance time with
    ///      `vm.warp` / `evm_increaseTime` instead of shortening these.
    uint256 public constant UPGRADE_DELAY = 7 days;
    uint256 public constant ADD_DELAY     = 3 days;
    uint256 public constant PURGE_DELAY   = 1 days;

    /// @dev Default cold-wallet stand-in for the canceller / `whitelistRemover`
    ///      / `purgeRemover` roles. Mirrors `Deploy.DEFAULT_PURGE_REMOVER_EOA`
    ///      so testnet runs with default env vars exercise the same
    ///      cross-canceller geometry as mainnet (deployer ↔ canonical cold
    ///      wallet), just with a different proposer on the upgrade path.
    address public constant DEFAULT_COLD_WALLET = 0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4;

    /// @notice CLI entrypoint. Reads role addresses from env (with
    ///         documented defaults) and executes the deploy with
    ///         `msg.sender` as the temporary DEFAULT_ADMIN of each TLC.
    function run() external {
        address deployerAddr = msg.sender;
        address governanceOwner   = _readGovernanceOwner(deployerAddr);
        address whitelistRemover  = _readWhitelistRemover();
        address purgeRemover      = _readPurgeRemover();
        deploy(deployerAddr, governanceOwner, whitelistRemover, purgeRemover);
    }

    /// @notice Programmatic entrypoint. Tests call this directly to avoid
    ///         env-var races (Foundry runs tests in parallel; vm.setEnv
    ///         mutates process state).
    /// @dev    NOTE: deliberately NO `code.length > 0` check — that's the
    ///         sole behavioral difference vs production Deploy.s.sol.
    /// @param  deployerAddr     Temporary DEFAULT_ADMIN_ROLE holder during
    ///                          the role-split dance. Must equal the
    ///                          msg.sender of subsequent calls (broadcaster
    ///                          in prod, script contract in tests).
    /// @param  governanceOwner  Proposer of upgrade + whitelist TLCs;
    ///                          canceller of purge TLC.
    /// @param  whitelistRemover Canceller of upgrade + whitelist TLCs;
    ///                          `whitelistRemover` slot on the proxy.
    /// @param  purgeRemover     Proposer of purge TLC; `purgeRemover` slot
    ///                          on the proxy.
    function deploy(
        address deployerAddr,
        address governanceOwner,
        address whitelistRemover,
        address purgeRemover
    ) public {
        require(deployerAddr     != address(0), "deployer is zero");
        require(governanceOwner  != address(0), "governanceOwner is zero");
        require(whitelistRemover != address(0), "whitelistRemover is zero");
        require(purgeRemover     != address(0), "purgeRemover is zero");

        address[] memory initialWhitelisters = _readInitialWhitelisters();

        // === 1. Implementation.
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl", deployerAddr);

        // Permissive executor list: governanceOwner OR anyone after delay.
        address[] memory sharedExecutors = new address[](2);
        sharedExecutors[0] = governanceOwner;
        sharedExecutors[1] = address(0);

        // === 2. Upgrade TimelockController.
        TimelockController upgradeTLC = _deployTLCWithSplitRoles(
            UPGRADE_TIMELOCK_SALT,
            UPGRADE_DELAY,
            governanceOwner,    // proposer
            whitelistRemover,   // canceller
            sharedExecutors,
            deployerAddr,
            "upgradeTimelock"
        );

        // === 3. Add TimelockController.
        TimelockController addTLC = _deployTLCWithSplitRoles(
            ADD_TIMELOCK_SALT,
            ADD_DELAY,
            governanceOwner,    // proposer
            whitelistRemover,   // canceller
            sharedExecutors,
            deployerAddr,
            "addTimelock"
        );

        // === 4. Purge TimelockController.
        TimelockController purgeTLC = _deployTLCWithSplitRoles(
            PURGE_TIMELOCK_SALT,
            PURGE_DELAY,
            purgeRemover,       // proposer
            governanceOwner,    // canceller
            sharedExecutors,
            deployerAddr,
            "purgeTimelock"
        );

        // === 5. ERC1967Proxy.
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (address(upgradeTLC), address(addTLC), whitelistRemover, address(purgeTLC), purgeRemover, initialWhitelisters)
        );
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy", deployerAddr);

        console2.log("=== DeployDev (testnet / dev) ===");
        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", address(upgradeTLC));
        console2.log("  proposer:            ", governanceOwner);
        console2.log("  canceller:           ", whitelistRemover);
        console2.log("Add TLC (3-day):       ", address(addTLC));
        console2.log("  proposer:            ", governanceOwner);
        console2.log("  canceller:           ", whitelistRemover);
        console2.log("Purge TLC (1-day):     ", address(purgeTLC));
        console2.log("  proposer:            ", purgeRemover);
        console2.log("  canceller:           ", governanceOwner);
        console2.log("whitelistRemover slot: ", whitelistRemover);
        console2.log("purgeRemover slot:     ", purgeRemover);
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

    /// @dev Backwards-compatible 2-arg overload. Sets:
    ///        * governanceOwner  = `owner`
    ///        * whitelistRemover = `operator`
    ///        * purgeRemover     = `operator`
    ///      Old single-principal callers passing the same address for both
    ///      get a fully-vacuous role split (one wallet on every side); the
    ///      dance still runs and locks role config.
    function deploy(address deployerAddr, address owner, address operator) public {
        deploy(deployerAddr, owner, operator, operator);
    }

    /// @dev Backwards-compatible single-arg overload. All four roles
    ///      collapse to the same address — fully-vacuous cross-canceller,
    ///      useful for one-EOA Anvil loops where the goal is just to
    ///      validate the deploy mechanics, not the role geometry.
    function deploy(address ownerAndDeployer) public {
        deploy(ownerAndDeployer, ownerAndDeployer, ownerAndDeployer, ownerAndDeployer);
    }

    /*//////////////////////////////////////////////////////////////
                          ROLE-SPLIT DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev Identical pattern to `Deploy._deployTLCWithSplitRoles`. See
    ///      Deploy.s.sol for the full explanation of the 4-step admin
    ///      dance and why role config is locked permanently after step 4.
    ///
    ///      Note: this helper allows `proposer == canceller` (vacuous
    ///      mode) so single-principal dev deploys still validate the
    ///      mechanics. Production `Deploy._deployTLCWithSplitRoles`
    ///      rejects that case to enforce the security invariant.
    function _deployTLCWithSplitRoles(
        bytes32 salt,
        uint256 delay,
        address proposer,
        address canceller,
        address[] memory executors,
        address deployerAddr,
        string memory label
    ) internal returns (TimelockController tlc) {
        require(proposer != address(0),  "proposer is zero");
        require(canceller != address(0), "canceller is zero");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        bytes memory tlcInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(delay, proposers, executors, deployerAddr)
        );

        bytes32 initHash = keccak256(tlcInitCode);
        address predicted = computeCreate2Address(salt, initHash, CREATE2_FACTORY);

        if (predicted.code.length > 0) {
            console2.log(string.concat(label, " already deployed:"), predicted);
            return TimelockController(payable(predicted));
        }

        vm.startBroadcast(deployerAddr);
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, tlcInitCode));
        require(ok, string.concat(label, " deploy failed"));
        require(predicted.code.length > 0, string.concat(label, " not deployed"));
        tlc = TimelockController(payable(predicted));

        // === Steps 2/3: grant CANCELLER to the cross-canceller, revoke
        //     OZ's auto-grant from the proposer. In single-principal
        //     mode (proposer == canceller), the order matters: grant
        //     first (no-op since proposer already has it), then revoke
        //     would also strip it from the canceller. So skip both and
        //     leave the auto-grant as-is.
        if (proposer != canceller) {
            tlc.grantRole(tlc.CANCELLER_ROLE(), canceller);
            tlc.revokeRole(tlc.CANCELLER_ROLE(), proposer);
        }

        // Step 4: renounce DEFAULT_ADMIN_ROLE — locks role config.
        tlc.renounceRole(tlc.DEFAULT_ADMIN_ROLE(), deployerAddr);
        vm.stopBroadcast();

        console2.log(string.concat(label, " deployed (split):"), predicted);
    }

    /// @dev `DEPLOYDEV_GOVERNANCE_OWNER` env first, then `GOVERNANCE_OWNER`
    ///      (legacy alias), then deployer EOA. Returning `address(0)` for
    ///      empty/missing env triggers the next fallback.
    function _readGovernanceOwner(address fallbackAddr) internal view returns (address) {
        try vm.envAddress("DEPLOYDEV_GOVERNANCE_OWNER") returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        try vm.envAddress("GOVERNANCE_OWNER") returns (address a) {
            if (a != address(0)) return a;
        } catch {}
        return fallbackAddr;
    }

    /// @dev `DEPLOYDEV_WHITELIST_REMOVER` env, then canonical cold wallet.
    function _readWhitelistRemover() internal view returns (address) {
        try vm.envAddress("DEPLOYDEV_WHITELIST_REMOVER") returns (address a) {
            return a == address(0) ? DEFAULT_COLD_WALLET : a;
        } catch {
            return DEFAULT_COLD_WALLET;
        }
    }

    /// @dev `DEPLOYDEV_PURGE_REMOVER` env, then canonical cold wallet.
    function _readPurgeRemover() internal view returns (address) {
        try vm.envAddress("DEPLOYDEV_PURGE_REMOVER") returns (address a) {
            return a == address(0) ? DEFAULT_COLD_WALLET : a;
        } catch {
            return DEFAULT_COLD_WALLET;
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
    ///      predicted address if it's already deployed. Used for impl
    ///      and proxy (no role-split dance needed).
    function _create2(
        bytes32 salt,
        bytes memory initCode,
        string memory label,
        address deployerAddr
    ) internal returns (address) {
        bytes32 initHash = keccak256(initCode);
        address predicted = computeCreate2Address(salt, initHash, CREATE2_FACTORY);
        if (predicted.code.length > 0) {
            console2.log(string.concat(label, " already deployed:"), predicted);
            return predicted;
        }
        vm.startBroadcast(deployerAddr);
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        require(ok, string.concat(label, " deploy failed"));
        vm.stopBroadcast();
        require(predicted.code.length > 0, string.concat(label, " not deployed"));
        return predicted;
    }
}
