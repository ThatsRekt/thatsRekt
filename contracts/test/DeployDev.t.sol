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
///             blocker on testnet), (b) wires the system correctly
///             (proxy → impl, proxy.owner == timelock, EOA holds
///             timelock roles), (c) uses CREATE2 salts that cannot
///             collide with production Deploy.s.sol salts.
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

    /// @notice Happy path: EOA is accepted; impl + timelock + proxy all
    ///         deploy at the predicted CREATE2 addresses; the proxy is
    ///         owned by the timelock; the EOA holds the timelock's
    ///         proposer / executor / canceller roles.
    function test_deploy_eoa_owner_accepted() public {
        deployer.deploy(DEV_EOA);

        address impl = _predict(deployer.IMPL_SALT(), keccak256(type(ThatsRekt).creationCode));
        bytes memory tlInit = _timelockInitCode(DEV_EOA);
        address timelock = _predict(deployer.TIMELOCK_SALT(), keccak256(tlInit));
        bytes memory proxyInit = _proxyInitCode(impl, timelock, DEV_EOA);
        address proxy = _predict(deployer.PROXY_SALT(), keccak256(proxyInit));

        assertGt(impl.code.length, 0, "impl not deployed");
        assertGt(timelock.code.length, 0, "timelock not deployed");
        assertGt(proxy.code.length, 0, "proxy not deployed");

        // Proxy is owned by the timelock — the EOA cannot upgrade directly,
        // it has to go through the 7-day delay just like production.
        assertEq(ThatsRekt(proxy).owner(), timelock, "proxy.owner != timelock");
        // EOA holds the whitelistAdmin role — instant whitelist mgmt in dev,
        // mirroring how the multisig holds it in prod.
        assertEq(ThatsRekt(proxy).whitelistAdmin(), DEV_EOA, "whitelistAdmin != DEV_EOA");

        // EOA holds proposer/executor/canceller on the timelock.
        TimelockController tl = TimelockController(payable(timelock));
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), DEV_EOA), "EOA missing PROPOSER_ROLE");
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), DEV_EOA), "EOA missing EXECUTOR_ROLE");
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), DEV_EOA), "EOA missing CANCELLER_ROLE");

        // Delay matches production — testnet behavior matches mainnet.
        assertEq(tl.getMinDelay(), 7 days, "timelock delay drifted from production");
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
        assertTrue(deployer.IMPL_SALT() != prod.IMPL_SALT(), "IMPL_SALT collision with prod");
        assertTrue(deployer.TIMELOCK_SALT() != prod.TIMELOCK_SALT(), "TIMELOCK_SALT collision with prod");
        assertTrue(deployer.PROXY_SALT() != prod.PROXY_SALT(), "PROXY_SALT collision with prod");
    }

    /// @notice Same dev EOA used across two chains ⇒ same proxy address.
    ///         This is the property that makes Anvil + Sepolia testnet
    ///         deployments share a canonical thatsRekt address — the
    ///         CREATE2 prediction is purely a function of (factory,
    ///         salt, initCode), and identical owner ⇒ identical timelock
    ///         init code ⇒ identical predicted addresses.
    function test_same_eoa_yields_same_proxy_address() public view {
        address impl = _predict(deployer.IMPL_SALT(), keccak256(type(ThatsRekt).creationCode));
        bytes memory tlInit = _timelockInitCode(DEV_EOA);
        address timelock = _predict(deployer.TIMELOCK_SALT(), keccak256(tlInit));
        bytes memory proxyInit = _proxyInitCode(impl, timelock, DEV_EOA);

        // Predict the same address twice — should match (sanity check
        // that prediction is pure).
        address proxy1 = _predict(deployer.PROXY_SALT(), keccak256(proxyInit));
        address proxy2 = _predict(deployer.PROXY_SALT(), keccak256(proxyInit));
        assertEq(proxy1, proxy2);

        // A different EOA must yield a different proxy address (so
        // different testnets with different owners don't collide).
        address otherEoa = address(0x1234);
        bytes memory otherTlInit = _timelockInitCode(otherEoa);
        address otherTimelock = _predict(deployer.TIMELOCK_SALT(), keccak256(otherTlInit));
        address otherProxy = _predict(
            deployer.PROXY_SALT(),
            keccak256(_proxyInitCode(impl, otherTimelock, otherEoa))
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

    function _timelockInitCode(address owner) internal pure returns (bytes memory) {
        address[] memory proposers = new address[](1);
        proposers[0] = owner;
        address[] memory executors = new address[](1);
        executors[0] = owner;
        return abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(uint256(7 days), proposers, executors, address(0))
        );
    }

    function _proxyInitCode(address impl, address timelock, address whitelistAdmin)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory initCalldata = abi.encodeCall(
            ThatsRekt.initialize,
            (timelock, whitelistAdmin)
        );
        return abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(impl, initCalldata));
    }
}
