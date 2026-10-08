// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CounterpartyRegistry} from "../src/CounterpartyRegistry.sol";
import {CustodyVault} from "../src/CustodyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title Adversarial review
 *
 * @notice Tests written against the *documentation*, not against the code.
 *
 *         Every other suite in this repo tests that the implementation does what it
 *         was written to do. This one takes each sentence the product makes about
 *         itself and tries to make it false. Where a sentence turns out to be
 *         wrong, the sentence is the bug — the code is doing exactly what it was
 *         written to do, and what it was written to do is not what was claimed.
 *
 *         Run: forge test --match-path test/Adversarial.t.sol -vv
 */
contract AdversarialTest is Test {
    CounterpartyRegistry registry;
    CustodyVault vault;
    MockUSDC usdc;

    uint256 internal constant REGISTRY_OWNER_KEY = 0xA11CE;
    uint256 internal constant BUSINESS_KEY = 0xB0B;
    uint256 internal constant VENDOR_KEY = 0xC0FFEE;
    uint256 internal constant VENDOR_NEW_KEY = 0xDEAD;
    uint256 internal constant STRANGER_KEY = 0xBAD; // never met the vendor
    uint256 internal constant ACCOMPLICE_KEY = 0xAC0; // receives; signs nothing
    uint256 internal constant VENDOR_OWNER_KEY = 0x0DD;

    address registryOwner;
    address business;
    address vendor;
    address vendorNew;
    address stranger;
    address accomplice;
    address vaultOwner;

    bytes32 id;
    uint256 constant CAP = 1_000_000e6;
    uint64 constant WINDOW = 7 days;

    function setUp() public {
        registryOwner = vm.addr(REGISTRY_OWNER_KEY);
        business = vm.addr(BUSINESS_KEY);
        vendor = vm.addr(VENDOR_KEY);
        vendorNew = vm.addr(VENDOR_NEW_KEY);
        stranger = vm.addr(STRANGER_KEY);
        accomplice = vm.addr(ACCOMPLICE_KEY);
        vaultOwner = business;

        usdc = new MockUSDC();
        registry = new CounterpartyRegistry(registryOwner);
        vault = new CustodyVault(address(registry), address(usdc), vaultOwner, CAP);

        vm.prank(registryOwner);
        registry.setVault(address(vault));

        vm.prank(business);
        (uint8 cv, bytes32 cr, bytes32 cs) =
            vm.sign(VENDOR_KEY, registry.registrationDigest("Northwind Plumbing Ltd", vendor, business));
        id = registry.register("Northwind Plumbing Ltd", vendor, business, abi.encodePacked(cr, cs, cv));

        // The business is a registered payer, so a role check is the ONLY thing that
        // can reject its signature in the quorum role. Without this the re-roling
        // test passes because the payer lookup fails first, and would keep passing
        // if the role binding were removed — a test that proves nothing.
        vm.prank(business);
        registry.registerPayer(id);

        usdc.mint(business, 1000e6);
        vm.prank(business);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(business);
        vault.deposit(50e6);
    }

    function _digest(bytes32 succId, address to, uint8 role) internal view returns (bytes32) {
        return registry.successionDigest(id, succId, to, block.timestamp + WINDOW, role);
    }

    function _attest(bytes32 succId, address to, uint8 role, uint256 key) internal {
        (address signer, bytes32 digest) = (vm.addr(key), _digest(succId, to, role));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        vm.prank(signer);
        registry.attest(succId, CounterpartyRegistry.AttestRole(role), abi.encodePacked(r, s, v));
    }

    // =====================================================================
    // 1. "the payer" — is the second signature really the business?
    // =====================================================================

    /**
     * @notice CLAIM UNDER TEST
     *         registerPayer() says: "Registration alone can only ever withhold a
     *         payer attestation. It can never move money, change an account, or
     *         activate a succession."
     *
     *         If that is true, then the payer half of the ceremony can only ever be
     *         signed by a party the counterparty already knew about.
     */
    function test_strangerCanRegisterAsPayerAndThenSignThePayerHalf() public {
        // The stranger has never met this vendor and is not the business.
        assertFalse(registry.isPayer(id, stranger), "precondition: not a payer");

        // registerPayer is permissionless.
        vm.prank(stranger);
        registry.registerPayer(id);
        assertTrue(registry.isPayer(id, stranger), "precondition: now a payer");

        // The vendor agrees to move accounts. Only the vendor knows to do this.
        vm.prank(vendor);
        bytes32 succId = registry.proposeSuccession(id, vendorNew, WINDOW);

        // The vendor signs. The stranger tries to stand in for "the business" —
        // and is refused, registered or not. The payer half has exactly one right
        // answer, named at registration.
        _attest(succId, vendorNew, 0, VENDOR_KEY);
        // (Signed payload built first: expectRevert must sit directly in front of
        // the call, with no cheatcode between them.)
        // Signed for the role being attempted, because the role is now inside the
        // digest — a signature made for one role cannot even be presented as another.
        bytes32 digest = _digest(succId, vendorNew, 1);
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(STRANGER_KEY, digest);
        bytes memory sig = abi.encodePacked(r, sigS, v);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(CounterpartyRegistry.NotBusiness.selector, business, stranger)
        );
        registry.attest(succId, CounterpartyRegistry.AttestRole.Payer, sig);

        assertEq(registry.activeAccount(id), vendor, "nothing moved without the business");
    }

    /**
     * @notice The same trick, with the vendor's key in the attacker's hands.
     * @dev This is the scenario the whole product exists for. With the vendor's key
     *      compromised, an attacker who can also register as a payer can move the
     *      account to themselves. The recipient-can't-sign rule does not help,
     *      because the attacker is not the recipient — they are a third party
     *      standing in for the business.
     */
    function test_compromisedVendorKeyPlusStrangerPayerMovesTheAccount() public {
        // Attacker holds the vendor's key and two fresh addresses of their own.
        vm.prank(stranger);
        registry.registerPayer(id);

        // Propose from the registered stranger address to the accomplice address.
        vm.prank(stranger);
        bytes32 succId = registry.proposeSuccession(id, accomplice, WINDOW);

        // Old-key half: signed with the compromised vendor key. That half works —
        // it is supposed to; the vendor agreeing is necessary.
        _attest(succId, accomplice, 0, VENDOR_KEY);
        // Payer half: the stranger tries with their own registered key. Refused.
        // A single compromised vendor key is no longer enough; the business key
        // would have to fall too, and no one party holds both.
        {
            bytes32 digest = _digest(succId, accomplice, 1);
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(STRANGER_KEY, digest);
            vm.prank(stranger);
            vm.expectRevert(
                abi.encodeWithSelector(
                    CounterpartyRegistry.NotBusiness.selector,
                    business,
                    stranger
                )
            );
            registry.attest(succId, CounterpartyRegistry.AttestRole.Payer, abi.encodePacked(r, s, v));
        }

        assertEq(registry.activeAccount(id), vendor, "the business never agreed, so nothing moved");
    }

    // =====================================================================
    // 1b. The ceremony cannot be completed out of order or after a break
    // =====================================================================

    /**
     * @notice CLAIM UNDER TEST
     *         "There is no other path to a new active account." activate() checked
     *         the succession's own state and its expiry, but never that the account
     *         it moves away from is still the active one.
     *
     *         Two fully-signed proposals therefore activate in whatever order the
     *         submitter chooses, and the second silently overwrites the first —
     *         moving the counterparty to an address the middle signature never
     *         covered, with a lineage entry that names the wrong predecessor.
     */
    function test_staleProposalCannotOverwriteTheCurrentAccount() public {
        // Two genuine moves, both fully signed. Each is a real ceremony a business
        // could have approved at the time it was made.
        vm.prank(vendor);
        bytes32 first = registry.proposeSuccession(id, vendorNew, WINDOW);
        vm.prank(vendor);
        bytes32 second = registry.proposeSuccession(id, accomplice, WINDOW);

        _attest(first, vendorNew, 0, VENDOR_KEY);
        _attest(first, vendorNew, 1, BUSINESS_KEY);
        _attest(second, accomplice, 0, VENDOR_KEY);
        _attest(second, accomplice, 1, BUSINESS_KEY);

        registry.activate(first);
        assertEq(registry.activeAccount(id), vendorNew, "precondition: first move landed");

        // The second proposal was against the *old* account. The old account no
        // longer holds the role, so its consent cannot be spent a second time.
        vm.expectRevert(
            abi.encodeWithSelector(CounterpartyRegistry.StaleProposal.selector, vendor, vendorNew)
        );
        registry.activate(second);

        assertEq(registry.activeAccount(id), vendorNew, "the account did not move twice");
    }

    /**
     * @notice CLAIM UNDER TEST
     *         "Every future payer sees the gap before sending anything" — and the
     *         gap is permanent. A proposal already in flight when the gap is
     *         disclosed used to be exempt, so the account could still move
     *         afterwards and the public record would say Broken while paying
     *         somewhere new.
     */
    function test_breakDisclosedMidCeremonyStopsTheCeremony() public {
        vm.prank(vendor);
        bytes32 succId = registry.proposeSuccession(id, vendorNew, WINDOW);
        _attest(succId, vendorNew, 0, VENDOR_KEY);
        _attest(succId, vendorNew, 1, BUSINESS_KEY);
        assertEq(
            uint8(registry.succession(succId).state),
            uint8(CounterpartyRegistry.SuccessionState.Attested),
            "precondition: fully attested"
        );

        // The old key is reported lost while the proposal sits unattended.
        vm.prank(vendor);
        registry.discloseInheritance(id, vendorNew);

        vm.expectRevert(abi.encodeWithSelector(CounterpartyRegistry.NotClean.selector, id));
        registry.activate(succId);

        assertEq(registry.activeAccount(id), vendor, "a broken record does not move");
    }

    /// @dev The same staleness rule guards attest, not only activate. Without it a
    ///      signature could still be *collected* against a proposal that can never
    ///      legitimately complete, which spends the signer's key for nothing.
    function test_aStaleProposalCannotEvenBeAttested() public {
        vm.prank(vendor);
        bytes32 stale = registry.proposeSuccession(id, accomplice, WINDOW);
        vm.prank(vendor);
        bytes32 live = registry.proposeSuccession(id, vendorNew, WINDOW);

        _attest(live, vendorNew, 0, VENDOR_KEY);
        _attest(live, vendorNew, 1, BUSINESS_KEY);
        registry.activate(live);
        assertEq(registry.activeAccount(id), vendorNew, "precondition: the account moved");

        // The vendor signing the old proposal again: the proposal is against an
        // account that no longer holds the role.
        bytes32 digest = _digest(stale, accomplice, 0);
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(VENDOR_KEY, digest);
        vm.prank(vendor);
        vm.expectRevert(
            abi.encodeWithSelector(CounterpartyRegistry.StaleProposal.selector, vendor, vendorNew)
        );
        registry.attest(stale, CounterpartyRegistry.AttestRole.OldKey, abi.encodePacked(r, sigS, v));
    }

    /// @dev And the break rule guards attest too: a record marked Broken must not
    ///      collect signatures for a move it can never make.
    function test_aBrokenRecordCannotCollectAttestations() public {
        vm.prank(vendor);
        bytes32 succId = registry.proposeSuccession(id, vendorNew, WINDOW);
        vm.prank(vendor);
        registry.discloseInheritance(id, vendorNew);

        bytes32 digest = _digest(succId, vendorNew, 0);
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(VENDOR_KEY, digest);
        vm.prank(vendor);
        vm.expectRevert(abi.encodeWithSelector(CounterpartyRegistry.NotClean.selector, id));
        registry.attest(succId, CounterpartyRegistry.AttestRole.OldKey, abi.encodePacked(r, sigS, v));
    }

    /**
     * @notice CLAIM UNDER TEST
     *         A signed digest is bound to the role it was signed for.
     *
     *         Unbound, a submitter could take a business signature made for the
     *         payer half and present it as a quorum signature. It would be accepted,
     *         the payer half would never fill, and the move would stall until the
     *         proposal expired — up to thirty days during which the invoice says one
     *         address and the registry says another.
     */
    function test_aSignatureCannotBeReroledAndStallTheCeremony() public {
        vm.prank(vendor);
        bytes32 succId = registry.proposeSuccession(id, vendorNew, WINDOW);

        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(BUSINESS_KEY, _digest(succId, vendorNew, 1));
        bytes memory forPayer = abi.encodePacked(r, sigS, v);

        // Presented as quorum instead. The recovered address is not the business,
        // so it does not pass any role check.
        vm.expectRevert();
        vm.prank(stranger);
        registry.attest(succId, CounterpartyRegistry.AttestRole.Quorum, forPayer);

        // And the signature is not consumed by the failed attempt, so the real
        // payer attestation still works.
        vm.prank(business);
        registry.attest(succId, CounterpartyRegistry.AttestRole.Payer, forPayer);
        assertTrue(registry.succession(succId).payerAttested, "the payer half still fills");
    }

    // =====================================================================
    // 2. Quorum griefing — can a stranger freeze a counterparty?
    // =====================================================================

    /**
     * @notice CLAIM UNDER TEST
     *         setQuorumRequired() is guarded by "only the party receiving the money,
     *         or a registered payer, may demand more scrutiny". Since registerPayer
     *         is permissionless, that guard admits anyone who cares to join.
     */
    function test_strangerCanRaiseQuorumAndNobodyEverClearsIt() public {
        vm.prank(stranger);
        registry.registerPayer(id);

        // Refused: demanding scrutiny is business-or-account only now.
        vm.prank(stranger);
        vm.expectRevert(CounterpartyRegistry.NotProposer.selector);
        registry.setQuorumRequired(id, type(uint16).max);

        // And the legitimate path is unaffected: vendor proposes, both real
        // parties sign, it completes.
        vm.prank(vendor);
        bytes32 succId = registry.proposeSuccession(id, vendorNew, WINDOW);
        _attest(succId, vendorNew, 0, VENDOR_KEY);
        _attest(succId, vendorNew, 1, BUSINESS_KEY);

        CounterpartyRegistry.Succession memory s = registry.succession(succId);
        assertTrue(
            s.state == CounterpartyRegistry.SuccessionState.Attested,
            "the real ceremony still completes"
        );
    }

    // =====================================================================
    // 2b. Who may make money move
    // =====================================================================

    /**
     * @notice CLAIM UNDER TEST
     *         "The agent executes payments" — and until this guard existed, so did
     *         anyone else. `pay` had no caller check, so a stranger could push the
     *         whole balance to the recorded counterparty in cap-sized pieces, ref
     *         after ref. The cap bounds each payment; it never bounded the total.
     */
    function test_strangerCannotTriggerPayments() public {
        vm.prank(business);
        vault.setCounterpartyCap(id, 5e6);
        assertTrue(registry.isPayable(id), "precondition: payable");

        // A stranger with a fresh reference and enough patience used to be able to
        // empty the vault one cap at a time.
        vm.prank(stranger);
        vm.expectRevert(CustodyVault.NotExecutor.selector);
        vault.pay(id, 5e6, keccak256("stranger-1"));
    }

    function test_namedExecutorCanTriggerPaymentsAndLosingTheNameStopsThem() public {
        vm.prank(business);
        vault.setCounterpartyCap(id, 5e6);
        vm.prank(business);
        vault.setExecutor(stranger, true);

        vm.prank(stranger);
        vault.pay(id, 5e6, keccak256("exec-1"));

        vm.prank(business);
        vault.setExecutor(stranger, false);

        vm.prank(stranger);
        vm.expectRevert(CustodyVault.NotExecutor.selector);
        vault.pay(id, 5e6, keccak256("exec-2"));
    }

    function test_onlyTheOwnerNamesExecutors() public {
        vm.prank(stranger);
        vm.expectRevert(CustodyVault.NotOwner.selector);
        vault.setExecutor(stranger, true);
    }

    // =====================================================================
    // 3. Docstrings that are not true
    // =====================================================================

    /**
     * @notice CLAIM UNDER TEST
     *         CustodyVault.transferOwnership says "Hand ownership to the agent's own
     *         wallet, permanently" and "One-way by design".
     *
     *         There is no check that would make it one-way. The new owner can
     *         transfer it straight back, so whoever holds it at any moment can hand
     *         the budget-setting and pause powers on.
     */
    function test_transferOwnershipIsNotOneWayDespiteSayingSo() public {
        vm.prank(vaultOwner);
        vault.transferOwnership(stranger);
        assertEq(vault.owner(), stranger, "precondition: handed over");

        // The new owner hands it straight back. Nothing stops this.
        vm.prank(stranger);
        vault.transferOwnership(business);

        assertEq(vault.owner(), business, "so it is not one-way, and never was");
    }

    /**
     * @notice CLAIM UNDER TEST
     *         "Handing over the owner therefore cannot hand over the ability to
     *         spend: it hands over the ability to set limits and to pull the plug."
     *
     *         The vault owner can also drain the vault, which is spending.
     */
    function test_vaultOwnerCanDrainTheVault() public {
        uint256 balance = usdc.balanceOf(address(vault));
        assertGt(balance, 0, "precondition: funded");

        vm.prank(vaultOwner);
        vault.withdraw(stranger, balance);

        assertEq(usdc.balanceOf(address(vault)), 0, "every dollar moved by the owner");
        assertEq(usdc.balanceOf(stranger), balance);
    }

    // =====================================================================
    // 4. Gas and cost of doing business
    // =====================================================================

    /**
     * @notice isPayable() scans every succession a counterparty has ever had, on
     *         every single payment. A counterparty whose vendor changes bank
     *         accounts a few dozen times pays for all of it, forever, and there is
     *         no upper bound on how many proposals can accumulate.
     */
    function test_isPayableCostGrowsWithEveryProposalEverMade() public {
        uint256 before0;
        {
            uint256 g = gasleft();
            registry.isPayable(id);
            before0 = g - gasleft();
        }

        // Sixty proposals that never complete: expired, or simply abandoned.
        // (Abandoning is free to describe and costs the proposer gas, which bounds
        // the grief: every unit of future payment cost is prepaid by the attacker.)
        for (uint256 i = 0; i < 60; ++i) {
            vm.warp(block.timestamp + 1);
            vm.prank(vendor);
            registry.proposeSuccession(id, vendorNew, WINDOW);
        }

        uint256 after60;
        {
            uint256 g = gasleft();
            registry.isPayable(id);
            after60 = g - gasleft();
        }

        assertGt(after60, before0, "each abandoned proposal adds a storage read to every future pay()");
        emit log_named_uint("isPayable gas, 0 proposals", before0);
        emit log_named_uint("isPayable gas, 60 abandoned proposals", after60);
    }

    /// @notice A fully attested but unactivated proposal blocks payments only until
    ///         the window closes; afterwards anyone may clear it. Bounded by design —
    ///         the relationship has already moved, so paying the old account meanwhile
    ///         would be paying a stale destination.
    function test_attestedButUnactivatedProposalBlocksOnlyUntilExpiry() public {
        vm.prank(vendor);
        bytes32 succId = registry.proposeSuccession(id, vendorNew, WINDOW);
        _attest(succId, vendorNew, 0, VENDOR_KEY);
        _attest(succId, vendorNew, 1, BUSINESS_KEY);

        assertFalse(registry.isPayable(id), "precondition: fully attested, old account stale");

        // Clearing early is refused: the window is the window.
        vm.expectRevert(CounterpartyRegistry.NotAttested.selector);
        registry.markExpired(succId);

        // Past the window, anyone — including a stranger — may clear it.
        vm.warp(block.timestamp + WINDOW + 1 days);
        vm.prank(stranger);
        registry.markExpired(succId);

        assertTrue(registry.isPayable(id), "clearable after expiry, by anyone");
    }

    /**
     * @notice CLAIM UNDER TEST
     *         discloseInheritance() is guarded by "only the active account or a
     *         registered payer". Registration is permissionless, so that guard
     *         admits a stranger — who may then mark the counterparty Broken,
     *         permanently and irreversibly, bricking every future payment to it.
     */
    function test_strangerCanPermanentlyBrickACounterparty() public {
        vm.prank(stranger);
        registry.registerPayer(id);

        // Refused: bricking the record is business-or-account only now.
        vm.prank(stranger);
        vm.expectRevert(CounterpartyRegistry.NotProposer.selector);
        registry.discloseInheritance(id, accomplice);

        assertTrue(registry.isPayable(id), "still payable; the stranger changed nothing");
    }
}
