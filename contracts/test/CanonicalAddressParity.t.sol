// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ThatsRekt} from "../src/ThatsRekt.sol";

/// @notice Regression gate: verifies that executing the real `Deploy.deploy()`
///         script with the canonical v1.2.0 production tuple produces contracts
///         at the five live addresses deployed on Ethereum mainnet, Base,
///         Arbitrum, and Optimism — and, crucially, that they WILL match on any
///         future chain deployment including BNB Chain (BSC, chain 56).
///
///         === Why this test uses the REAL deploy path ===
///         The previous version of this test re-implemented init-code construction
///         in `_predictAll()`, independent of `Deploy.deploy()`. That approach
///         proved chain-independence (CREATE2 addresses are chain-agnostic) but
///         was BLIND to deploy-wiring regressions: reordering `sharedExecutors`,
///         swapping proposer/canceller assignments, or changing `initialize()`
///         argument order inside `Deploy.deploy()` would change every TLC + proxy
///         address yet leave the re-implemented prediction unchanged — the gate
///         would pass green while a non-canonical BSC deploy was about to ship.
///
///         This version drives the gate through the REAL deploy: it calls
///         `Deploy.deploy(DEPLOYER, GOV_SAFE, OPERATOR, PURGE_EOA, whitelisters)`
///         with the canonical tuple and then asserts the RESULTING on-chain
///         artifacts exist exactly at the expected canonical addresses and carry
///         the correct role wiring.  Any wiring change inside `Deploy.deploy()`
///         that would shift an address or mis-wire a role is now caught here.
///
///         === CREATE2 + chain-independence ===
///         computeCreate2Address uses only (factory, salt, initCodeHash) — no
///         chainId.  Because `Deploy.deploy()` uses the singleton CREATE2 factory
///         (`0x4e59b44847b379578588920cA78FbF26c0B4956C`) the addresses produced
///         by this test are simultaneously a proof that the same bytecode + tuple
///         yields the canonical addresses on BSC. No RPC, no broadcast, no BSC
///         node required.
///
///         === Deployer EOA caveat ===
///         The DEPLOYER constant below must match the actual BSC broadcaster EOA.
///         If the broadcaster changes, the TLC addresses diverge (the deployer is
///         the temporary DEFAULT_ADMIN encoded in every TLC's constructor
///         calldata).  This caveat is called out in the relayer issue #112.
///
///         === What this test catches (compared to the old prediction approach) ===
///           - Reordering `sharedExecutors` inside `Deploy.deploy()`
///           - Swapping proposer / canceller on any TLC
///           - Changing the `initialize()` argument order on the proxy
///           - Salt bumps in any of the five `*_SALT` constants
///           - Compiler / optimizer changes (bytecode changes → address drift)
///           - Dependency bumps that touch TLC or proxy bytecode
///
///         === Canonical production tuple (v1.2.0) ===
///         These are the exact values used for the live deploys on
///         Ethereum / Base / Arbitrum / Optimism and must be reproduced on BSC:
///
///           DEPLOYER_ADDRESS      = 0xb5a6c8ca369e38050784e2a6793bee6447109340
///           GOVERNANCE_OWNER      = 0x59E4DBc95BD312A882Bb36b7f3E8298682340679
///           WHITELIST_OPERATOR    = 0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45
///           PURGE_REMOVER_EOA     = 0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45
///           INITIAL_WHITELISTERS  = [6 addresses in order below]
///
///           Expected on-chain addresses:
///             impl       = 0xd7A06A47325b9e439Df5FCE3F5C64AD010ab6eD9
///             upgradeTLC = 0xf6F807f095D6D09c1216ffBd6AaCBB73D8F02aB6
///             addTLC     = 0xB83AB5772f919BE72b4AaB98456eDdED5ad68D4f
///             purgeTLC   = 0xd8Dbce72f488c7664c6bdFae4aa819daBEEF98a8
///             proxy      = 0xBfaEEE9662b4c037De24e5Caa65815350d57b89A
contract CanonicalAddressParityTest is Test {
    // -----------------------------------------------------------------------
    // Canonical production tuple (v1.2.0) — DO NOT CHANGE without a full
    // cross-chain re-deploy. Changing any of these values means the BSC proxy
    // will land at a different address than the one already live on other chains.
    // -----------------------------------------------------------------------

    /// @dev The EOA that must sign the BSC broadcast. Encoded as the temporary
    ///      DEFAULT_ADMIN in every TLC's constructor — changing this shifts all
    ///      TLC addresses. Must match the actual broadcaster or the deploy is
    ///      non-canonical (see relayer issue #112).
    address constant DEPLOYER  = 0xb5A6c8ca369e38050784e2A6793beE6447109340;
    address constant GOV_SAFE  = 0x59E4DBc95BD312A882Bb36b7f3E8298682340679;
    address constant OPERATOR  = 0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45;
    address constant PURGE_EOA = 0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45;

    // Six initial whitelisters in canonical order.
    address constant WL_0 = 0x5822B262EDdA82d2C6A436b598Ff96fA9AB894c4;
    address constant WL_1 = 0xda1b9dFA299d655135C1ECdc4f0b4c9aED9a7f45;
    address constant WL_2 = 0x9E8680dbBcA1127add812abE209A10E621b385dF;
    address constant WL_3 = 0x24C2167054A9A9e00F67233F1eBc4060501f54FA;
    address constant WL_4 = 0xE0396d6d738e726D39f96099b8f6a55d11184374;
    address constant WL_5 = 0xb5A6c8ca369e38050784e2A6793beE6447109340;

    // -----------------------------------------------------------------------
    // Expected canonical addresses (live on Mainnet / Base / Arb / OP,
    // and must reproduce on BSC with the same tuple + compiler settings).
    // -----------------------------------------------------------------------

    address constant EXPECTED_IMPL        = 0xd7A06A47325b9e439Df5FCE3F5C64AD010ab6eD9;
    address constant EXPECTED_UPGRADE_TLC = 0xf6F807f095D6D09c1216ffBd6AaCBB73D8F02aB6;
    address constant EXPECTED_ADD_TLC     = 0xB83AB5772f919BE72b4AaB98456eDdED5ad68D4f;
    address constant EXPECTED_PURGE_TLC   = 0xd8Dbce72f488c7664c6bdFae4aa819daBEEF98a8;
    address constant EXPECTED_PROXY       = 0xBfaEEE9662b4c037De24e5Caa65815350d57b89A;

    Deploy internal d;

    function setUp() public {
        d = new Deploy();
    }

    /// @notice Core parity gate. Runs the REAL `Deploy.deploy()` with the
    ///         canonical production tuple, then asserts:
    ///           (a) Every contract landed at its expected canonical address.
    ///           (b) The proxy's on-chain role wiring is correct.
    ///
    ///         This is NOT a prediction re-implementation. The real deploy code
    ///         runs; if it diverges from the canonical wiring (executor order,
    ///         proposer/canceller assignment, initialize() arg order) the
    ///         CREATE2 addresses produced will differ and the code-existence
    ///         checks below will fail.
    ///
    ///         Failure means the current `Deploy.s.sol` would deploy to different
    ///         addresses than the ones live on all existing chains — BSC deployment
    ///         MUST be blocked until the discrepancy is understood and resolved.
    function test_canonicalAddressParity() public {
        // Run the real deploy with the canonical production tuple.
        // DEPLOYER is used as the temporary DEFAULT_ADMIN in every TLC's
        // constructor and renounced at the end of the dance.
        d.deploy(DEPLOYER, GOV_SAFE, OPERATOR, PURGE_EOA, _canonicalWhitelisters());

        // ----------------------------------------------------------------
        // (a) Address parity: every contract must exist at its canonical
        //     address.  A wiring change in Deploy.deploy() shifts the
        //     CREATE2 address → nothing lands here → assertion fails.
        // ----------------------------------------------------------------
        assertGt(EXPECTED_IMPL.code.length,        0, "impl not at canonical address: parity BROKEN");
        assertGt(EXPECTED_UPGRADE_TLC.code.length, 0, "upgradeTLC not at canonical address: parity BROKEN");
        assertGt(EXPECTED_ADD_TLC.code.length,     0, "addTLC not at canonical address: parity BROKEN");
        assertGt(EXPECTED_PURGE_TLC.code.length,   0, "purgeTLC not at canonical address: parity BROKEN");
        assertGt(EXPECTED_PROXY.code.length,       0, "proxy not at canonical address: BSC deploy BLOCKED");

        // ----------------------------------------------------------------
        // (b) Proxy role wiring: confirms initialize() arg order is correct
        //     and that the right TLC controls each slot.  A swap of
        //     upgradeTLC ↔ addTLC in the initialize() call, for example,
        //     passes (a) but fails here.
        // ----------------------------------------------------------------
        ThatsRekt proxy = ThatsRekt(EXPECTED_PROXY);

        assertEq(proxy.owner(),           EXPECTED_UPGRADE_TLC, "proxy.owner != upgradeTLC: wiring BROKEN");
        assertEq(proxy.whitelistAdmin(),  EXPECTED_ADD_TLC,     "proxy.whitelistAdmin != addTLC: wiring BROKEN");
        assertEq(proxy.whitelistRemover(), OPERATOR,            "proxy.whitelistRemover != OPERATOR: wiring BROKEN");
        assertEq(proxy.purgeAdmin(),      EXPECTED_PURGE_TLC,   "proxy.purgeAdmin != purgeTLC: wiring BROKEN");
        assertEq(proxy.purgeRemover(),    PURGE_EOA,            "proxy.purgeRemover != PURGE_EOA: wiring BROKEN");
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// @dev Returns the six canonical initial whitelisters in order.
    function _canonicalWhitelisters() internal pure returns (address[] memory wl) {
        wl = new address[](6);
        wl[0] = WL_0;
        wl[1] = WL_1;
        wl[2] = WL_2;
        wl[3] = WL_3;
        wl[4] = WL_4;
        wl[5] = WL_5;
    }
}
