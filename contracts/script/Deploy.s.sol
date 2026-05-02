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
///         === Cross-canceller role split (security invariant) ===
///         Inside every TimelockController, the proposer MUST NEVER
///         also hold the canceller role: a single compromised wallet
///         must not be able to BOTH push an op through the timelock AND
///         silence its public watchdog. OpenZeppelin's default
///         constructor auto-grants `CANCELLER_ROLE` to every proposer,
///         so the deploy performs a 4-step admin dance per TLC to undo
///         that and grant `CANCELLER_ROLE` to a separate principal:
///
///             1. constructor(delay, [proposer], executors, deployerEOA)
///                → deployerEOA is the temporary DEFAULT_ADMIN.
///             2. tlc.grantRole(CANCELLER_ROLE, crossCanceller)
///             3. tlc.revokeRole(CANCELLER_ROLE, proposer)
///                → undoes OZ's auto-grant.
///             4. tlc.renounceRole(DEFAULT_ADMIN_ROLE, deployerEOA)
///                → role config is locked permanently; further changes
///                  must go through the TLC itself.
///
///         Cross-canceller mapping (production):
///           * Upgrade TLC (7-day):    proposer = Safe;        canceller = WHITELIST_OPERATOR cold wallet
///           * Whitelist-add (3-day):  proposer = Safe;        canceller = WHITELIST_OPERATOR cold wallet
///           * Purge TLC (1-day):      proposer = PURGE_REMOVER cold wallet; canceller = Safe
///
///         In production wiring `WHITELIST_OPERATOR` and `PURGE_REMOVER`
///         resolve to the same EOA (`0x5822…894c4`), so one cold wallet
///         plays kill-switch on the slow lanes AND proposer on the fast
///         lane, while the Safe plays kill-switch on the purge lane.
///         Compromise of either single principal cannot push a hostile
///         op through any single TLC.
///
///         Five-role governance (asymmetric delays + asymmetric
///         operational ownership):
///           * `owner`            = upgrade TLC (7-day). Proposer is the
///                                  GOVERNANCE_OWNER multisig (rare,
///                                  board-level decisions: upgrades, role
///                                  rotation). Canceller is the cold wallet.
///           * `whitelistAdmin`   = add TLC (3-day). Proposer is the
///                                  GOVERNANCE_OWNER multisig (mass
///                                  onboarding decisions). Canceller is
///                                  the cold wallet.
///           * `whitelistRemover` = WHITELIST_OPERATOR cold wallet —
///                                  instant remove + instant kill-switch
///                                  on the whitelistAdmin slot. Same
///                                  address that cancels both Safe-proposed
///                                  TLCs.
///           * `purgeAdmin`       = purge TLC (1-day). Proposer is the
///                                  PURGE_REMOVER cold wallet (same EOA
///                                  as WHITELIST_OPERATOR in canonical
///                                  wiring). Canceller is the Safe.
///                                  1-day delay so spam / illegal /
///                                  abusive posts can be cleaned up
///                                  promptly while still giving
///                                  integrators an auditable public
///                                  window before each purge lands.
///           * `purgeRemover`     = PURGE_REMOVER_EOA directly — instant
///                                  kill-switch on the `purgeAdmin` slot.
///                                  Same address that proposes purges on
///                                  the 1-day TLC. Rotation is owner-only
///                                  (7-day) so the purge kill-switch
///                                  survives compromise of the EOA.
///
///         The CREATE2 address of the proxy depends on the
///         `initialWhitelisters` array, the multisig address, AND the
///         operator address: same triple on every chain → same proxy
///         address on every chain. Pre-population at init is the only
///         legitimate bypass of the 3-day add timelock.
///
///         === Deployer / broadcaster ===
///         The deployer EOA (the address signing this script) is the
///         temporary DEFAULT_ADMIN of every TLC during the dance, then
///         renounces. It does NOT end up with any role on any TLC after
///         the dance. The deployer address is captured from `msg.sender`
///         at the `run()` entry point — under `forge script
///         --broadcast`, this is the broadcaster EOA.
///
///         Env vars:
///           * GOVERNANCE_OWNER     (required) — Safe multisig. Must have code.
///                                              Becomes proposer/executor on
///                                              the upgrade + add TLCs AND
///                                              canceller on the purge TLC.
///           * WHITELIST_OPERATOR   (required) — Cold wallet (EOA or contract).
///                                              Becomes the `whitelistRemover`
///                                              slot on the proxy AND
///                                              canceller on the upgrade
///                                              + add TLCs.
///           * PURGE_REMOVER_EOA    (optional) — Cold wallet (EOA or contract).
///                                              Becomes (a) proposer/executor
///                                              on the 1-day purge TLC and
///                                              (b) the `purgeRemover` slot
///                                              on the proxy. Defaults to the
///                                              canonical operator EOA
///                                              (`0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4`).
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
    bytes32 public constant IMPL_SALT = keccak256("thatsRekt.impl.v1.1.0");

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

    /*//////////////////////////////////////////////////////////////
                                 RUN
    //////////////////////////////////////////////////////////////*/

    /// @notice CLI entrypoint — reads env vars and executes the deploy
    ///         using `msg.sender` as the temporary DEFAULT_ADMIN of each
    ///         TLC. Under `forge script --broadcast`, `msg.sender` is the
    ///         broadcaster EOA.
    function run() external {
        deploy(msg.sender);
    }

    /// @notice Env-reading entrypoint. Tests pass the script contract
    ///         address (because that's what `msg.sender` of subsequent
    ///         calls will be in test mode); production passes the
    ///         broadcaster EOA via `run()`. Reads `GOVERNANCE_OWNER`,
    ///         `WHITELIST_OPERATOR`, `PURGE_REMOVER_EOA`, and
    ///         `INITIAL_WHITELISTERS` from env, then delegates to the
    ///         pure parameter-driven `deploy(...)` overload below.
    /// @param  deployerAddr The address that will hold the temporary
    ///                      DEFAULT_ADMIN_ROLE on each TLC during the
    ///                      role-split dance and then renounce. Must be
    ///                      the same address from which the dance calls
    ///                      are made (i.e. the broadcaster in prod, the
    ///                      script contract in tests).
    function deploy(address deployerAddr) public {
        address multisig = vm.envAddress("GOVERNANCE_OWNER");
        require(multisig != address(0), "GOVERNANCE_OWNER env var is zero");

        address operator = vm.envAddress("WHITELIST_OPERATOR");
        require(operator != address(0), "WHITELIST_OPERATOR env var is zero");

        address purgeRemoverEOA = _readPurgeRemoverOrDefault();
        require(purgeRemoverEOA != address(0), "PURGE_REMOVER_EOA resolved to zero");

        address[] memory initialWhitelisters = _readInitialWhitelisters();

        deploy(deployerAddr, multisig, operator, purgeRemoverEOA, initialWhitelisters);
    }

    /// @notice Pure parameter-driven entrypoint. All inputs are explicit;
    ///         no env reads. Used by tests (deterministic, no env-var
    ///         races across parallel tests) and by callers that have
    ///         already resolved the role tuple.
    /// @dev    Same role-split semantics as `deploy(deployerAddr)`.
    ///         Production constraint: `multisig` must have code (must be
    ///         a Safe / contract). The role-split helper additionally
    ///         enforces `proposer != canceller` per TLC, so passing
    ///         `multisig == operator` or `multisig == purgeRemoverEOA`
    ///         will revert.
    function deploy(
        address deployerAddr,
        address multisig,
        address operator,
        address purgeRemoverEOA,
        address[] memory initialWhitelisters
    ) public {
        require(deployerAddr != address(0), "deployer is zero");
        require(multisig != address(0), "GOVERNANCE_OWNER env var is zero");
        require(multisig.code.length > 0, "GOVERNANCE_OWNER has no code (must be a Safe / contract)");
        require(operator != address(0), "WHITELIST_OPERATOR env var is zero");
        require(purgeRemoverEOA != address(0), "PURGE_REMOVER_EOA resolved to zero");

        // === 1. Implementation (no constructor args -> deterministic init code).
        bytes memory implInitCode = type(ThatsRekt).creationCode;
        address impl = _create2(IMPL_SALT, implInitCode, "impl", deployerAddr);

        // Anyone can execute after the delay elapses — we keep the
        // executor list permissive (multisig + open) so liveness doesn't
        // depend on a single key. Same `executors` for all three TLCs.
        address[] memory sharedExecutors = new address[](2);
        sharedExecutors[0] = multisig;
        sharedExecutors[1] = address(0); // address(0) makes EXECUTOR_ROLE open

        // === 2. Upgrade TimelockController.
        //   proposer  = multisig (Safe) — only the multisig schedules upgrades.
        //   canceller = operator (cold wallet) — independent kill-switch on
        //               every Safe-proposed upgrade. Operator can NEVER
        //               schedule, only cancel.
        TimelockController upgradeTLC = _deployTLCWithSplitRoles(
            UPGRADE_TIMELOCK_SALT,
            UPGRADE_DELAY,
            multisig,           // proposer
            operator,           // canceller (≠ proposer; cross-canceller)
            sharedExecutors,
            deployerAddr,
            "upgradeTimelock"
        );

        // === 3. Add TimelockController.
        //   proposer  = multisig (Safe) — onboards new whitelisters.
        //   canceller = operator (cold wallet) — same independent
        //               kill-switch as upgrade TLC.
        TimelockController addTLC = _deployTLCWithSplitRoles(
            ADD_TIMELOCK_SALT,
            ADD_DELAY,
            multisig,           // proposer
            operator,           // canceller (≠ proposer; cross-canceller)
            sharedExecutors,
            deployerAddr,
            "addTimelock"
        );

        // === 4. Purge TimelockController.
        //   proposer  = purgeRemoverEOA (cold wallet) — schedules purges.
        //   canceller = multisig (Safe) — independent kill-switch on
        //               every cold-wallet-proposed purge. The Safe can
        //               NEVER schedule a purge, only cancel one.
        TimelockController purgeTLC = _deployTLCWithSplitRoles(
            PURGE_TIMELOCK_SALT,
            PURGE_DELAY,
            purgeRemoverEOA,    // proposer
            multisig,           // canceller (≠ proposer; cross-canceller)
            sharedExecutors,
            deployerAddr,
            "purgeTimelock"
        );

        // === 5. ERC1967Proxy.
        //   - owner            = upgradeTimelock (7-day)
        //   - whitelistAdmin   = addTimelock     (3-day, multisig-proposed)
        //   - whitelistRemover = operator        (instant whitelist kill-switch)
        //   - purgeAdmin       = purgeTimelock   (1-day, cold-wallet-proposed)
        //   - purgeRemover     = purgeRemoverEOA (instant purge kill-switch +
        //                                          purge TLC proposer)
        //   - initialWhitelisters = pre-populated at init
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (address(upgradeTLC), address(addTLC), operator, address(purgeTLC), purgeRemoverEOA, initialWhitelisters)
        );
        bytes memory proxyInitCode = abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(impl, initCalldata)
        );
        address proxy = _create2(PROXY_SALT, proxyInitCode, "proxy", deployerAddr);

        console2.log("Implementation:        ", impl);
        console2.log("Upgrade TLC (7-day):   ", address(upgradeTLC));
        console2.log("Add TLC (3-day):       ", address(addTLC));
        console2.log("Purge TLC (1-day):     ", address(purgeTLC));
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

    /*//////////////////////////////////////////////////////////////
                          ROLE-SPLIT DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    /// @dev Deploys a `TimelockController` with `proposer != canceller`,
    ///      then locks the role config by renouncing DEFAULT_ADMIN_ROLE.
    ///      Idempotent: if a TLC at the predicted address already has
    ///      code, returns it without attempting the dance again
    ///      (prior deploy already locked the roles).
    ///
    ///      Encoding details:
    ///        * `admin = deployerAddr` in the constructor — temporary
    ///          DEFAULT_ADMIN_ROLE holder. Step 4 renounces, leaving
    ///          only the TLC itself as admin (self-administered).
    ///        * `proposers = [proposer]` — OZ auto-grants both
    ///          PROPOSER_ROLE and CANCELLER_ROLE to each entry. Step 3
    ///          revokes the auto-granted CANCELLER_ROLE from `proposer`.
    ///        * `executors` — passed through verbatim (typically
    ///          `[multisig, address(0)]` so anyone can execute after
    ///          the delay elapses).
    function _deployTLCWithSplitRoles(
        bytes32 salt,
        uint256 delay,
        address proposer,
        address canceller,
        address[] memory executors,
        address deployerAddr,
        string memory label
    ) internal returns (TimelockController tlc) {
        require(proposer != address(0), "proposer is zero");
        require(canceller != address(0), "canceller is zero");
        require(proposer != canceller, "proposer == canceller (defeats role split)");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        bytes memory tlcInitCode = abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(delay, proposers, executors, deployerAddr)
        );

        bytes32 initHash = keccak256(tlcInitCode);
        address predicted = computeCreate2Address(salt, initHash, CREATE2_FACTORY);

        // Idempotent: if this TLC already exists, the dance was already
        // performed (step 4 renounced DEFAULT_ADMIN_ROLE; we cannot redo
        // it). Trust the prior deploy and return.
        if (predicted.code.length > 0) {
            console2.log(string.concat(label, " already deployed:"), predicted);
            return TimelockController(payable(predicted));
        }

        // === The 4-step admin dance. All four steps share one broadcast
        //     scope so they're sent from the same `deployerAddr` (in test
        //     mode, msg.sender of subsequent calls = `deployerAddr`).
        vm.startBroadcast(deployerAddr);
        // Step 1: deploy via CREATE2 factory (admin = deployerAddr in initCode).
        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(salt, tlcInitCode));
        require(ok, string.concat(label, " deploy failed"));
        require(predicted.code.length > 0, string.concat(label, " not deployed"));
        tlc = TimelockController(payable(predicted));

        // Step 2: grant CANCELLER_ROLE to the cross-canceller.
        tlc.grantRole(tlc.CANCELLER_ROLE(), canceller);

        // Step 3: revoke OZ's auto-granted CANCELLER_ROLE from the proposer.
        tlc.revokeRole(tlc.CANCELLER_ROLE(), proposer);

        // Step 4: renounce DEFAULT_ADMIN_ROLE — locks role config forever.
        tlc.renounceRole(tlc.DEFAULT_ADMIN_ROLE(), deployerAddr);
        vm.stopBroadcast();

        console2.log(string.concat(label, " deployed (split):"), predicted);
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
    ///      Used for impl + proxy (no role-split dance needed).
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
