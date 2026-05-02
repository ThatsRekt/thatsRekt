// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Tests for the production deploy script's cross-canceller
///         role-split mechanics. The production script enforces three
///         constraints absent from `DeployDev.s.sol`:
///           1. `GOVERNANCE_OWNER` must have code (must be a Safe).
///           2. `proposer != canceller` is required (role-split helper
///              rejects vacuous mode — production must NEVER deploy
///              with proposer == canceller).
///           3. Three distinct env vars (no defaults except the
///              cold wallet) — every deploy is explicit about its
///              role tuple.
///
///         Tests call the parameter-driven `deploy(deployerAddr, multisig,
///         operator, purgeRemoverEOA, initialWhitelisters)` overload to
///         avoid env-var races that would arise if multiple tests in
///         this file used `vm.setEnv` (Foundry can run tests in parallel
///         and env mutations are process-global).
///
///         Each test asserts the resulting role configuration matches
///         the spec table:
///           * Upgrade TLC:  proposer = Safe;        canceller = cold wallet
///           * Add TLC:      proposer = Safe;        canceller = cold wallet
///           * Purge TLC:    proposer = cold wallet; canceller = Safe
///         and DEFAULT_ADMIN_ROLE is renounced on all three.
contract DeployTest is Test {
    /// @dev Canonical cold wallet (matches `Deploy.DEFAULT_PURGE_REMOVER_EOA`).
    address constant COLD = 0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4;

    /// @dev Stand-in Safe address — etched with non-empty code so the
    ///      production script's `code.length > 0` check passes.
    address internal safe;

    Deploy internal deployer;

    function setUp() public {
        deployer = new Deploy();
        safe = makeAddr("safe-stand-in");
        // Etch arbitrary non-empty code so the `multisig.code.length > 0`
        // check in `Deploy.deploy()` passes — we don't actually call into
        // it during the deploy, only read its address.
        vm.etch(safe, hex"60006000F3");
    }

    /// @notice Happy path: full production deploy with the canonical
    ///         cross-canceller geometry (Safe ↔ cold wallet).
    function test_deploy_role_split_canonical() public {
        deployer.deploy(address(deployer), safe, COLD, COLD, new address[](0));

        (address upgrade, address add_, address purge) = _predictTLCs(address(deployer), safe, COLD);

        TimelockController upTl    = TimelockController(payable(upgrade));
        TimelockController addTl   = TimelockController(payable(add_));
        TimelockController purgeTl = TimelockController(payable(purge));

        // === Upgrade TLC: proposer = Safe; canceller = cold wallet ===
        assertTrue(upTl.hasRole(upTl.PROPOSER_ROLE(), safe),     "Safe missing PROPOSER on upgrade");
        assertFalse(upTl.hasRole(upTl.CANCELLER_ROLE(), safe),   "Safe is canceller on upgrade (defeats split)");
        assertTrue(upTl.hasRole(upTl.CANCELLER_ROLE(), COLD),    "cold missing CANCELLER on upgrade");
        assertFalse(upTl.hasRole(upTl.PROPOSER_ROLE(), COLD),    "cold is proposer on upgrade");

        // === Add TLC: proposer = Safe; canceller = cold wallet ===
        assertTrue(addTl.hasRole(addTl.PROPOSER_ROLE(), safe),    "Safe missing PROPOSER on add");
        assertFalse(addTl.hasRole(addTl.CANCELLER_ROLE(), safe),  "Safe is canceller on add (defeats split)");
        assertTrue(addTl.hasRole(addTl.CANCELLER_ROLE(), COLD),   "cold missing CANCELLER on add");
        assertFalse(addTl.hasRole(addTl.PROPOSER_ROLE(), COLD),   "cold is proposer on add");

        // === Purge TLC: proposer = cold wallet; canceller = Safe ===
        assertTrue(purgeTl.hasRole(purgeTl.PROPOSER_ROLE(), COLD),   "cold missing PROPOSER on purge");
        assertFalse(purgeTl.hasRole(purgeTl.CANCELLER_ROLE(), COLD), "cold is canceller on purge (defeats split)");
        assertTrue(purgeTl.hasRole(purgeTl.CANCELLER_ROLE(), safe),  "Safe missing CANCELLER on purge");
        assertFalse(purgeTl.hasRole(purgeTl.PROPOSER_ROLE(), safe),  "Safe is proposer on purge");

        // === Admin renounced on all three TLCs ===
        // Production deployer EOA was `address(deployer)` (the script
        // contract) for tests; renounce should have stripped it.
        assertFalse(upTl.hasRole(upTl.DEFAULT_ADMIN_ROLE(), address(deployer)),       "deployer still admin on upgrade");
        assertFalse(addTl.hasRole(addTl.DEFAULT_ADMIN_ROLE(), address(deployer)),     "deployer still admin on add");
        assertFalse(purgeTl.hasRole(purgeTl.DEFAULT_ADMIN_ROLE(), address(deployer)), "deployer still admin on purge");
        // TLC self-admin is preserved (so future role rotations can go
        // through a timelocked proposal).
        assertTrue(upTl.hasRole(upTl.DEFAULT_ADMIN_ROLE(), address(upTl)),       "upgrade TLC missing self-admin");
        assertTrue(addTl.hasRole(addTl.DEFAULT_ADMIN_ROLE(), address(addTl)),    "add TLC missing self-admin");
        assertTrue(purgeTl.hasRole(purgeTl.DEFAULT_ADMIN_ROLE(), address(purgeTl)), "purge TLC missing self-admin");

        // === Delays match production ===
        assertEq(upTl.getMinDelay(),    7 days, "upgrade delay");
        assertEq(addTl.getMinDelay(),   3 days, "add delay");
        assertEq(purgeTl.getMinDelay(), 1 days, "purge delay");
    }

    /// @notice Behavioral test on the upgrade TLC: Safe proposes, Safe
    ///         tries to cancel (rejected), cold wallet cancels (succeeds).
    function test_upgradeTLC_proposer_cannot_cancel() public {
        deployer.deploy(address(deployer), safe, COLD, COLD, new address[](0));
        (address upgrade,,) = _predictTLCs(address(deployer), safe, COLD);
        TimelockController tlc = TimelockController(payable(upgrade));

        address target = makeAddr("dummy-target");
        bytes32 salt = bytes32(uint256(0x77));

        vm.prank(safe);
        tlc.schedule(target, 0, "", bytes32(0), salt, 7 days);
        bytes32 opId = tlc.hashOperation(target, 0, "", bytes32(0), salt);
        assertTrue(tlc.isOperationPending(opId), "op not scheduled");

        // Safe (proposer) cannot cancel.
        vm.prank(safe);
        vm.expectRevert();
        tlc.cancel(opId);

        // Cold wallet (canceller) cancels.
        vm.prank(COLD);
        tlc.cancel(opId);
        assertFalse(tlc.isOperationPending(opId), "op still pending");
    }

    /// @notice Behavioral test on the add TLC.
    function test_addTLC_proposer_cannot_cancel() public {
        deployer.deploy(address(deployer), safe, COLD, COLD, new address[](0));
        (, address add_,) = _predictTLCs(address(deployer), safe, COLD);
        TimelockController tlc = TimelockController(payable(add_));

        bytes32 salt = bytes32(uint256(0x88));
        vm.prank(safe);
        tlc.schedule(makeAddr("add-target"), 0, "", bytes32(0), salt, 3 days);
        bytes32 opId = tlc.hashOperation(makeAddr("add-target"), 0, "", bytes32(0), salt);

        vm.prank(safe);
        vm.expectRevert();
        tlc.cancel(opId);

        vm.prank(COLD);
        tlc.cancel(opId);
        assertFalse(tlc.isOperationPending(opId));
    }

    /// @notice Behavioral test on the purge TLC: cold wallet proposes,
    ///         cold tries to cancel (rejected), Safe cancels (succeeds).
    function test_purgeTLC_proposer_cannot_cancel() public {
        deployer.deploy(address(deployer), safe, COLD, COLD, new address[](0));
        (,, address purge) = _predictTLCs(address(deployer), safe, COLD);
        TimelockController tlc = TimelockController(payable(purge));

        bytes32 salt = bytes32(uint256(0x99));
        vm.prank(COLD);
        tlc.schedule(makeAddr("purge-target"), 0, "", bytes32(0), salt, 1 days);
        bytes32 opId = tlc.hashOperation(makeAddr("purge-target"), 0, "", bytes32(0), salt);

        // Proposer (cold wallet) cannot cancel.
        vm.prank(COLD);
        vm.expectRevert();
        tlc.cancel(opId);

        // Canceller (Safe) cancels.
        vm.prank(safe);
        tlc.cancel(opId);
        assertFalse(tlc.isOperationPending(opId));
    }

    /// @notice The production helper rejects vacuous role splits to
    ///         enforce the security invariant. If GOVERNANCE_OWNER ==
    ///         WHITELIST_OPERATOR (i.e., the multisig is also the cold
    ///         wallet), the upgrade + add TLCs would have proposer ==
    ///         canceller, defeating the cross-canceller pattern.
    function test_deploy_rejects_vacuous_split_safe_eq_operator() public {
        vm.expectRevert("proposer == canceller (defeats role split)");
        deployer.deploy(address(deployer), safe, safe, COLD, new address[](0));
    }

    /// @notice The production helper rejects when purgeRemover ==
    ///         multisig (purge TLC would have proposer == canceller).
    function test_deploy_rejects_vacuous_split_safe_eq_purge_remover() public {
        vm.expectRevert("proposer == canceller (defeats role split)");
        deployer.deploy(address(deployer), safe, COLD, safe, new address[](0));
    }

    /// @notice Idempotent: re-running the deploy on a chain that already
    ///         has the contracts is a no-op (each helper sees code at
    ///         the predicted address and returns).
    function test_deploy_idempotent() public {
        deployer.deploy(address(deployer), safe, COLD, COLD, new address[](0));
        deployer.deploy(address(deployer), safe, COLD, COLD, new address[](0));
    }

    /// @notice GOVERNANCE_OWNER may be an EOA on the v1.1.0 re-launch
    ///         path — the historical Safe-only requirement was dropped
    ///         (see Deploy.s.sol comment). The script now logs a warning
    ///         instead of reverting. We assert the deploy succeeds with
    ///         a no-code governance owner so a regression that re-adds
    ///         the require fails this test.
    function test_deploy_acceptsEOAGovernanceOwner() public {
        address eoa = makeAddr("eoa-no-code");
        // Should not revert; the deploy completes with governance pointing at an EOA.
        deployer.deploy(address(deployer), eoa, COLD, COLD, new address[](0));
    }

    /// @notice Zero deployer rejected.
    function test_deploy_rejects_zero_deployer() public {
        vm.expectRevert("deployer is zero");
        deployer.deploy(address(0), safe, COLD, COLD, new address[](0));
    }

    /// @notice Zero multisig rejected.
    function test_deploy_rejects_zero_multisig() public {
        vm.expectRevert("GOVERNANCE_OWNER env var is zero");
        deployer.deploy(address(deployer), address(0), COLD, COLD, new address[](0));
    }

    /// @notice Zero operator rejected.
    function test_deploy_rejects_zero_operator() public {
        vm.expectRevert("WHITELIST_OPERATOR env var is zero");
        deployer.deploy(address(deployer), safe, address(0), COLD, new address[](0));
    }

    /// @notice Zero purge remover rejected.
    function test_deploy_rejects_zero_purge_remover() public {
        vm.expectRevert("PURGE_REMOVER_EOA resolved to zero");
        deployer.deploy(address(deployer), safe, COLD, address(0), new address[](0));
    }

    // -------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------

    function _predictTLCs(
        address deployerAddr,
        address governanceOwner,
        address coldWallet
    ) internal view returns (address upgrade, address add_, address purge) {
        address[] memory executors = new address[](2);
        executors[0] = governanceOwner;
        executors[1] = address(0);

        upgrade = _predict(
            deployer.UPGRADE_TIMELOCK_SALT(),
            keccak256(_timelockInitCode(7 days, governanceOwner, executors, deployerAddr))
        );
        add_ = _predict(
            deployer.ADD_TIMELOCK_SALT(),
            keccak256(_timelockInitCode(3 days, governanceOwner, executors, deployerAddr))
        );
        purge = _predict(
            deployer.PURGE_TIMELOCK_SALT(),
            keccak256(_timelockInitCode(1 days, coldWallet, executors, deployerAddr))
        );
    }

    function _predict(bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        address factory = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash)))));
    }

    function _timelockInitCode(
        uint256 delay,
        address proposer,
        address[] memory executors,
        address deployerAddr
    ) internal pure returns (bytes memory) {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        return abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(delay, proposers, executors, deployerAddr)
        );
    }
}
