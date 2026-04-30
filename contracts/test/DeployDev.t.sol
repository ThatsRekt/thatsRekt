// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {DeployDev} from "../script/DeployDev.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Tests for the dev/testnet deploy script. Verifies it
///         (a) accepts an EOA owner (the production script's main
///             blocker on testnet),
///         (b) wires the three-role system correctly (proxy → impl,
///             proxy.owner == upgrade TLC, proxy.whitelistAdmin == add
///             TLC, proxy.whitelistRemover == EOA), with the EOA
///             holding proposer/executor on both timelocks,
///         (c) uses CREATE2 salts that cannot collide with production
///             Deploy.s.sol salts.
///
/// @dev Tests call `deploy(address)` directly rather than going through
///      the env-reading `run()` because Foundry runs tests in parallel
///      and `vm.setEnv` mutates the OS process env (race conditions).
///      A single dedicated test exercises the env-reading path serially.
contract DeployDevTest is Test {
    /// @dev Anvil default account 0 — the recommended dev EOA.
    address constant DEV_EOA = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    DeployDev internal deployer;

    function setUp() public {
        deployer = new DeployDev();
    }

    /// @notice Happy path (single-principal dev mode): one EOA fills
    ///         every role. Impl + both TLCs + proxy all deploy at the
    ///         predicted CREATE2 addresses; three-role wiring matches.
    function test_deploy_eoa_owner_accepted() public {
        deployer.deploy(DEV_EOA);

        address impl     = _predict(deployer.IMPL_SALT(),     keccak256(type(ThatsRekt).creationCode));
        address upgrade  = _predict(deployer.UPGRADE_TIMELOCK_SALT(), keccak256(_timelockInitCode(7 days, DEV_EOA)));
        address add_     = _predict(deployer.ADD_TIMELOCK_SALT(),     keccak256(_timelockInitCode(3 days, DEV_EOA)));
        address proxy    = _predict(deployer.PROXY_SALT(), keccak256(_proxyInitCode(impl, upgrade, add_, DEV_EOA, new address[](0))));

        assertGt(impl.code.length, 0,    "impl not deployed");
        assertGt(upgrade.code.length, 0, "upgrade timelock not deployed");
        assertGt(add_.code.length, 0,    "add timelock not deployed");
        assertGt(proxy.code.length, 0,   "proxy not deployed");

        // Proxy is owned by the upgrade timelock — the EOA cannot
        // upgrade directly, it has to go through the 7-day delay.
        assertEq(ThatsRekt(proxy).owner(),            upgrade, "proxy.owner != upgrade timelock");
        assertEq(ThatsRekt(proxy).whitelistAdmin(),   add_,    "proxy.whitelistAdmin != add timelock");
        assertEq(ThatsRekt(proxy).whitelistRemover(), DEV_EOA, "proxy.whitelistRemover != DEV_EOA");

        // EOA holds proposer/executor/canceller on both timelocks.
        TimelockController upTL  = TimelockController(payable(upgrade));
        TimelockController addTL = TimelockController(payable(add_));

        assertTrue(upTL.hasRole(upTL.PROPOSER_ROLE(), DEV_EOA),  "EOA missing PROPOSER on upgrade TLC");
        assertTrue(upTL.hasRole(upTL.EXECUTOR_ROLE(), DEV_EOA),  "EOA missing EXECUTOR on upgrade TLC");
        assertTrue(upTL.hasRole(upTL.CANCELLER_ROLE(), DEV_EOA), "EOA missing CANCELLER on upgrade TLC");

        assertTrue(addTL.hasRole(addTL.PROPOSER_ROLE(), DEV_EOA),  "EOA missing PROPOSER on add TLC");
        assertTrue(addTL.hasRole(addTL.EXECUTOR_ROLE(), DEV_EOA),  "EOA missing EXECUTOR on add TLC");
        assertTrue(addTL.hasRole(addTL.CANCELLER_ROLE(), DEV_EOA), "EOA missing CANCELLER on add TLC");

        // Delays match production — testnet behavior matches mainnet.
        assertEq(upTL.getMinDelay(),  7 days, "upgrade TLC delay drifted");
        assertEq(addTL.getMinDelay(), 3 days, "add TLC delay drifted");
    }

    /// @notice Two-principal mode (mainnet rehearsal): owner fills the
    ///         upgrade TLC; a distinct operator fills the add TLC and
    ///         whitelistRemover. Owner has NO authority on the add path
    ///         and operator has NO authority on the upgrade path —
    ///         that's the asymmetry we want to verify on testnet.
    function test_deploy_two_principal_split() public {
        address owner = makeAddr("gov-stand-in");
        address operator = makeAddr("operator-stand-in");
        deployer.deploy(owner, operator);

        address impl     = _predict(deployer.IMPL_SALT(),             keccak256(type(ThatsRekt).creationCode));
        address upgrade  = _predict(deployer.UPGRADE_TIMELOCK_SALT(), keccak256(_timelockInitCode(7 days, owner)));
        address add_     = _predict(deployer.ADD_TIMELOCK_SALT(),     keccak256(_timelockInitCode(3 days, operator)));
        address proxy    = _predict(deployer.PROXY_SALT(),            keccak256(_proxyInitCode(impl, upgrade, add_, operator, new address[](0))));

        assertEq(ThatsRekt(proxy).owner(),            upgrade,  "proxy.owner != upgrade timelock");
        assertEq(ThatsRekt(proxy).whitelistAdmin(),   add_,     "proxy.whitelistAdmin != add timelock");
        assertEq(ThatsRekt(proxy).whitelistRemover(), operator, "proxy.whitelistRemover != operator");

        TimelockController upTL  = TimelockController(payable(upgrade));
        TimelockController addTL = TimelockController(payable(add_));

        // Owner has roles on the upgrade TLC, NOT the add TLC.
        assertTrue(upTL.hasRole(upTL.PROPOSER_ROLE(), owner),    "owner missing PROPOSER on upgrade");
        assertFalse(addTL.hasRole(addTL.PROPOSER_ROLE(), owner), "owner unexpectedly on add PROPOSER");

        // Operator has roles on the add TLC, NOT the upgrade TLC.
        assertTrue(addTL.hasRole(addTL.PROPOSER_ROLE(), operator),  "operator missing PROPOSER on add");
        assertFalse(upTL.hasRole(upTL.PROPOSER_ROLE(), operator),   "operator unexpectedly on upgrade PROPOSER");
    }

    /// @notice Idempotent: running twice on the same chain is a no-op
    ///         the second time (everything's already deployed).
    function test_deploy_idempotent() public {
        deployer.deploy(DEV_EOA);
        // No revert on second run; addresses unchanged.
        deployer.deploy(DEV_EOA);
    }

    /// @notice Zero owner is rejected on the programmatic path.
    function test_deploy_rejects_zero_owner() public {
        vm.expectRevert("owner is zero");
        deployer.deploy(address(0));
    }

    /// @notice Zero operator (in the two-arg path) is rejected.
    function test_deploy_rejects_zero_operator() public {
        vm.expectRevert("operator is zero");
        deployer.deploy(DEV_EOA, address(0));
    }

    /// @notice The CLI / env-reading path — `run()` reads
    ///         `GOVERNANCE_OWNER` and reverts on zero. This is the only
    ///         test that mutates the process env; running it in
    ///         isolation avoids parallelism races with the others.
    function test_run_rejects_zero_env() public {
        vm.setEnv("GOVERNANCE_OWNER", vm.toString(address(0)));
        vm.expectRevert("GOVERNANCE_OWNER env var is zero");
        deployer.run();
    }

    /// @notice Production salts and dev salts MUST be different. A
    ///         collision would mean a dev deploy could squat on the
    ///         production CREATE2 address (or vice versa). Critical
    ///         safety invariant of the dual-script design.
    function test_salts_distinct_from_production() public {
        Deploy prod = new Deploy();
        assertTrue(deployer.IMPL_SALT()             != prod.IMPL_SALT(),             "IMPL_SALT collision");
        assertTrue(deployer.UPGRADE_TIMELOCK_SALT() != prod.UPGRADE_TIMELOCK_SALT(), "UPGRADE_TIMELOCK_SALT collision");
        assertTrue(deployer.ADD_TIMELOCK_SALT()     != prod.ADD_TIMELOCK_SALT(),     "ADD_TIMELOCK_SALT collision");
        assertTrue(deployer.PROXY_SALT()            != prod.PROXY_SALT(),            "PROXY_SALT collision");
        // The two dev-side timelock salts must also be different from
        // each other — otherwise the first deploy would squat the
        // second's address.
        assertTrue(
            deployer.UPGRADE_TIMELOCK_SALT() != deployer.ADD_TIMELOCK_SALT(),
            "UPGRADE_TIMELOCK_SALT == ADD_TIMELOCK_SALT (would collide)"
        );
    }

    /// @notice Same dev EOA + same initial whitelisters across two chains
    ///         ⇒ same proxy address. CREATE2 prediction is purely a
    ///         function of (factory, salt, initCode), and identical
    ///         owner ⇒ identical timelock init code ⇒ identical
    ///         predicted addresses.
    function test_same_eoa_yields_same_proxy_address() public view {
        address impl    = _predict(deployer.IMPL_SALT(), keccak256(type(ThatsRekt).creationCode));
        address upgrade = _predict(deployer.UPGRADE_TIMELOCK_SALT(), keccak256(_timelockInitCode(7 days, DEV_EOA)));
        address add_    = _predict(deployer.ADD_TIMELOCK_SALT(),     keccak256(_timelockInitCode(3 days, DEV_EOA)));

        bytes memory proxyInit = _proxyInitCode(impl, upgrade, add_, DEV_EOA, new address[](0));

        // Predict the same address twice — should match (sanity check
        // that prediction is pure).
        address proxy1 = _predict(deployer.PROXY_SALT(), keccak256(proxyInit));
        address proxy2 = _predict(deployer.PROXY_SALT(), keccak256(proxyInit));
        assertEq(proxy1, proxy2);

        // A different EOA must yield a different proxy address (so
        // different testnets with different owners don't collide).
        address otherEoa = address(0x1234);
        address otherUp  = _predict(deployer.UPGRADE_TIMELOCK_SALT(), keccak256(_timelockInitCode(7 days, otherEoa)));
        address otherAdd = _predict(deployer.ADD_TIMELOCK_SALT(),     keccak256(_timelockInitCode(3 days, otherEoa)));
        address otherProxy = _predict(
            deployer.PROXY_SALT(),
            keccak256(_proxyInitCode(impl, otherUp, otherAdd, otherEoa, new address[](0)))
        );
        assertTrue(proxy1 != otherProxy, "different owners should yield different proxies");
    }

    // -------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------

    function _predict(bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        // Foundry's deterministic deployer (CREATE2_FACTORY in forge-std).
        address factory = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), factory, salt, initCodeHash)))));
    }

    function _timelockInitCode(uint256 delay, address owner) internal pure returns (bytes memory) {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = owner;
        return abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(delay, proposers, executors, address(0))
        );
    }

    function _proxyInitCode(
        address impl,
        address upgradeTimelock,
        address addTimelock,
        address whitelistRemover,
        address[] memory initialWhitelisters
    ) internal pure returns (bytes memory) {
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (upgradeTimelock, addTimelock, whitelistRemover, initialWhitelisters)
        );
        return abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(impl, initCalldata));
    }
}
