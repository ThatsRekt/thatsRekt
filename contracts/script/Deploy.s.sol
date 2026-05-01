// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Script, console2} from "forge-std/Script.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Five-stage deterministic deploy of the v1 upgradeable system:
///         (1) implementation, (2) upgrade TimelockController (7-day),
///         (3) add TimelockController (3-day), (4) purge
///         TimelockController (1-day), (5) ERC1967Proxy. All five use
///         CREATE2 via the singleton factory (`CREATE2_FACTORY` from
///         forge-std/Base.sol) so addresses are identical on every
///         chain that runs this script with the same
///         `GOVERNANCE_OWNER`, `WHITELIST_OPERATOR`,
///         `PURGE_REMOVER_EOA`, and `INITIAL_WHITELISTERS`.
///
///         Five-role governance (asymmetric delays + asymmetric
///         operational ownership):
///           * `owner`            = upgrade TLC (7-day). Proposer/executor
///                                  is the GOVERNANCE_OWNER multisig
///                                  (rare, board-level decisions:
///                                  upgrades, role rotation).
///           * `whitelistAdmin`   = add TLC (3-day). Proposer/executor is
///                                  the WHITELIST_OPERATOR cold wallet
///                                  (day-to-day decisions: onboarding
///                                  new posters). Multisig has no path
///                                  to scheduling adds — that's
///                                  intentional, the multisig only
///                                  re-routes the role itself (slow,
///                                  7-day) if the operator is lost or
///                                  compromised.
///           * `whitelistRemover` = WHITELIST_OPERATOR cold wallet
///                                  directly — instant remove + instant
///                                  kill-switch on the whitelistAdmin
///                                  slot. Same address as the add TLC's
///                                  proposer so one team handles all
///                                  whitelist ops; rotation requires
///                                  the multisig (7-day) so the
///                                  kill-switch survives operator
///                                  compromise.
///           * `purgeAdmin`       = purge TLC (1-day). Proposer/executor
///                                  is the PURGE_REMOVER_EOA. 1-day
///                                  delay so spam / illegal / abusive
///                                  posts can be cleaned up promptly
///                                  while still giving integrators an
///                                  auditable public window before
///                                  each purge lands.
///           * `purgeRemover`     = PURGE_REMOVER_EOA directly —
///                                  instant kill-switch on the
///                                  `purgeAdmin` slot. Deliberately the
///                                  same address that proposes purges
///                                  on the 1-day TLC, so one principal
///                                  can both schedule purges, cancel
///                                  them mid-delay, AND neutralize
///                                  the TLC role itself if compromised.
///                                  Rotation is owner-only (7-day) so
///                                  the purge kill-switch survives
///                                  compromise of the EOA.
///
///         Both timelocks use `admin = address(0)` (the contracts
///         themselves), so role changes can only happen via timelocked
///         proposals.
///
///         The CREATE2 address of the proxy depends on the
///         `initialWhitelisters` array, the multisig address, AND the
///         operator address: same triple on every chain → same proxy
///         address on every chain. Pre-population at init is the only
///         legitimate bypass of the 3-day add timelock.
///
///         Env vars:
///           * GOVERNANCE_OWNER     (required) — Safe multisig. Must have code.
///                                              Becomes proposer/executor on
///                                              the 7-day upgrade TLC.
///           * WHITELIST_OPERATOR   (required) — Cold wallet (EOA or contract).
///                                              Becomes proposer/executor on
///                                              the 3-day add TLC AND holds
///                                              the whitelistRemover slot.
///           * PURGE_REMOVER_EOA    (optional) — Cold wallet (EOA or contract).
///                                              Becomes (a) proposer/executor
///                                              on the 1-day purge TLC and
///                                              (b) the `purgeRemover` slot
///                                              on the proxy — same principal
///                                              proposes purges, cancels
///                                              pending purges, AND holds
///                                              the kill-switch on the
///                                              `purgeAdmin` slot. Defaults
///                                              to the canonical operator EOA
///                                              (`0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4`).
///                                              The purge TLC's address is
///                                              installed as `purgeAdmin` on
///                                              the proxy.
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

    /// @dev 1-day TimelockController. Holds the `purgeAdmin` slot —
    ///      governance-driven content moderation (`purgePost`). Bump
    ///      only if its bytecode/config changes.
    bytes32 public constant PURGE_TIMELOCK_SALT = keccak256("thatsRekt.purgeTimelock.v1");

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

    /// @dev Purge window. 1 day balances "clean up illegal/spam content
    ///      promptly" against "auditable public window". The purge
    ///      action is moderator-flavored, not financial, so it doesn't
    ///      warrant the longer integrator-disengage windows used for
    ///      adds (3d) or upgrades (7d).
    uint256 public constant PURGE_DELAY = 1 days;

    /// @dev Default purge-remover EOA — the operator's cold
    ///      wallet, picked by the operator. Same address fills two
    ///      roles in production: proposer/canceller on the 1-day
    ///      purge TLC, and the `purgeRemover` slot on the proxy.
    ///      Override at runtime via `PURGE_REMOVER_EOA` env var. The
    ///      default exists so a one-shot deploy without env vars
    ///      still produces a sane CREATE2 address.
    address public constant DEFAULT_PURGE_REMOVER_EOA = 0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4;

    function run() external {
        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        require(multisig != address(0), "GOVERNANCE_OWNER env var is zero");
        require(multisig.code.length > 0, "GOVERNANCE_OWNER has no code (must be a Safe / contract)");

        address operator = vm.envAddress("WHITELIST_OPERATOR");
        require(operator != address(0), "WHITELIST_OPERATOR env var is zero");

        address purgeRemoverEOA = _readPurgeRemoverOrDefault();
        require(purgeRemoverEOA != address(0), "PURGE_REMOVER_EOA resolved to zero");

        address[] memory initialWhitelisters = _readInitialWhitelisters();

        // === 1. Implementation (no constructor args -> deterministic init code).
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl");

        // === 2. Upgrade TimelockController — multisig as proposer/executor.
        // High-stakes governance role: only the multisig can schedule
        // upgrades and role rotations. 7-day delay.
        address[] memory upgradeProposers = new address[](1);
        upgradeProposers[0] = multisig;
        address[] memory upgradeExecutors = new address[](1);
        upgradeExecutors[0] = multisig;
        bytes memory upgradeTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(UPGRADE_DELAY, upgradeProposers, upgradeExecutors, address(0))
        );
        address upgradeTimelock = _create2(UPGRADE_TIMELOCK_SALT, upgradeTLInitCode, "upgradeTimelock");

        // === 3. Add TimelockController — operator (cold wallet) as proposer/executor.
        // Day-to-day whitelist role: only the operator can schedule new
        // posters. 3-day delay so onboarding is publicly visible before
        // it lands.
        address[] memory addProposers = new address[](1);
        addProposers[0] = operator;
        address[] memory addExecutors = new address[](1);
        addExecutors[0] = operator;
        bytes memory addTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(ADD_DELAY, addProposers, addExecutors, address(0))
        );
        address addTimelock = _create2(ADD_TIMELOCK_SALT, addTLInitCode, "addTimelock");

        // === 4. Purge TimelockController — purge-remover EOA as proposer/executor.
        // Governance-driven content moderation. 1-day delay so spam /
        // illegal / abusive posts can be cleaned up promptly while still
        // giving integrators a public audit window before each purge
        // lands. The same EOA is also installed as the proxy's
        // `purgeRemover` slot below, so it can both (a) cancel a
        // pending purge on this TLC before the 1-day delay elapses and
        // (b) instantly revoke `purgeAdmin` on the proxy if this TLC
        // is captured. `address(0)` admin: role rotations on this TLC
        // must go through this TLC itself.
        address[] memory purgeProposers = new address[](1);
        purgeProposers[0] = purgeRemoverEOA;
        address[] memory purgeExecutors = new address[](1);
        purgeExecutors[0] = purgeRemoverEOA;
        bytes memory purgeTLInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(PURGE_DELAY, purgeProposers, purgeExecutors, address(0))
        );
        address purgeTimelock = _create2(PURGE_TIMELOCK_SALT, purgeTLInitCode, "purgeTimelock");

        // === 5. ERC1967Proxy.
        //   - owner            = upgradeTimelock (7-day)
        //   - whitelistAdmin   = addTimelock     (3-day, operator-proposed)
        //   - whitelistRemover = operator        (instant whitelist kill-switch)
        //   - purgeAdmin       = purgeTimelock   (1-day, purge-remover-proposed)
        //   - purgeRemover     = purgeRemoverEOA (instant purge kill-switch +
        //                                          purge TLC canceller)
        //   - initialWhitelisters = pre-populated at init
        // The proxy's init code embeds (impl, initCalldata); identical
        // across chains for the same (multisig, operator, purgeRemover,
        // initial list) tuple, so the CREATE2 address is identical.
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (upgradeTimelock, addTimelock, operator, purgeTimelock, purgeRemoverEOA, initialWhitelisters)
        );
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy");

        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", upgradeTimelock);
        console2.log("Add TLC (3-day):       ", addTimelock);
        console2.log("Purge TLC (1-day):     ", purgeTimelock);
        console2.log("Multisig (gov):        ", multisig);
        console2.log("Operator (whitelister):", operator);
        console2.log("Purge remover EOA:     ", purgeRemoverEOA);
        console2.log("  (also: purgeAdmin    = Purge TLC, purgeRemover = same EOA)");
        console2.log("Proxy:                 ", proxy);
        console2.log("Initial whitelisters:  ", initialWhitelisters.length);
        for (uint256 i; i < initialWhitelisters.length; ++i) {
            console2.log("  -", initialWhitelisters[i]);
        }
    }

    /// @dev Reads `PURGE_REMOVER_EOA` env. Empty/unset → fallback to the
    ///      hardcoded operator cold wallet
    ///      (`DEFAULT_PURGE_REMOVER_EOA`), which is what the operator
    ///      asked us to use for v1.3 deploys. Documented and overridable
    ///      so testnet rehearsals can swap in a different EOA without
    ///      touching this script.
    function _readPurgeRemoverOrDefault() internal view returns (address) {
        try vm.envAddress("PURGE_REMOVER_EOA") returns (address eoa) {
            return eoa == address(0) ? DEFAULT_PURGE_REMOVER_EOA : eoa;
        } catch {
            return DEFAULT_PURGE_REMOVER_EOA;
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
