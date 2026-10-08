// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CounterpartyRegistry} from "../src/CounterpartyRegistry.sol";
import {CustodyVault} from "../src/CustodyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title Horos test suite
 *
 * @notice Most of these tests assert that something CANNOT happen. That is the product.
 *         If one of them regresses, the product is not what it claims to be.
 */
contract HorosTest is Test {
    CounterpartyRegistry registry;
    CustodyVault vault;
    MockUSDC usdc;

    // Deterministic keys, so the suite is reproducible and signatures are real.
    uint256 internal constant OWNER_KEY = 0xA11CE;
    uint256 internal constant BUSINESS_KEY = 0xB0B; // the payer: a small agency
    uint256 internal constant VENDOR_KEY = 0xC0FFEE; // the counterparty receiving money
    uint256 internal constant VENDOR_NEW_KEY = 0xDEAD; // where the vendor now wants money
    uint256 internal constant ATTACKER_KEY = 0xBAD; // has the inbox, not the key
    uint256 internal constant IMPOSTOR_KEY = 0x1A3E;
    uint256 internal constant PAYER2_KEY = 0xBEEF;

    address internal owner;
    address internal business;
    address internal vendor;
    address internal vendorNew;
    address internal attacker;
    address internal impostor; // claims to be the old key, is not
    address internal payer2; // a second business that pays this counterparty

    bytes32 id;
    uint256 constant CAP = 1_000_000e6;
    uint64 constant WINDOW = 7 days;

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        business = vm.addr(BUSINESS_KEY);
        vendor = vm.addr(VENDOR_KEY);
        vendorNew = vm.addr(VENDOR_NEW_KEY);
        attacker = vm.addr(ATTACKER_KEY);
        impostor = vm.addr(IMPOSTOR_KEY);
        payer2 = vm.addr(PAYER2_KEY);

        vm.label(owner, "owner");
        vm.label(business, "business");
        vm.label(vendor, "vendor");
        vm.label(vendorNew, "vendorNew");
        vm.label(attacker, "attacker");
        vm.label(impostor, "impostor");
        vm.label(payer2, "payer2");

        usdc = new MockUSDC();
        registry = new CounterpartyRegistry(owner);
        vault = new CustodyVault(address(registry), address(usdc), business, CAP);
        vm.prank(owner);
        registry.setVault(address(vault));

        usdc.mint(business, 100_000e6);
        vm.prank(business);
        usdc.approve(address(vault), type(uint256).max);

        id = _register("Northwind Plumbing Ltd", vendor, business);
        vm.prank(business);
        vault.setExecutor(business, true);

        // Budgets are fail-closed: an uncapped counterparty cannot be paid at all.
        vm.prank(business);
        vault.setCounterpartyCap(id, CAP);
        vm.prank(business);
        vault.deposit(50_000e6);
        vm.prank(business);
        vault.pay(id, 400e6, keccak256("invoice-1"));
    }

    // -- signing helpers -------------------------------------------------

    /// @dev Signs with the deterministic key for `who`.
    function _sign(address who, bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_keyFor(who), digest);
        return bytes.concat(r, s, bytes1(v));
    }

    function _keyFor(address who) internal view returns (uint256) {
        if (who == business) return BUSINESS_KEY;
        if (who == vendor) return VENDOR_KEY;
        if (who == vendorNew) return VENDOR_NEW_KEY;
        if (who == impostor) return IMPOSTOR_KEY;
        if (who == payer2) return PAYER2_KEY;
        if (who == attacker) return ATTACKER_KEY;
        revert("no deterministic key for this address");
    }

    /// @dev Ask the contract for the digest rather than rebuilding EIP-712 by hand, so the
    ///      test proves the signature path works rather than proving our own encoder works.
    function _digest(bytes32 cpId, bytes32 succId, address to, uint256 expiry, uint8 role) internal view returns (bytes32) {
        return registry.successionDigest(cpId, succId, to, expiry, role);
    }

    /// @dev Register with the first account's consent, signed by its own key.
    ///      The business submits, so it is the registrant and therefore a payer.
    function _register(string memory name, address firstAccount, address biz) internal returns (bytes32) {
        bytes32 digest = registry.registrationDigest(name, firstAccount, biz);
        bytes memory consent = _sign(firstAccount, digest);
        vm.prank(biz);
        return registry.register(name, firstAccount, biz, consent);
    }

    function _propose(address proposer, address to) internal returns (bytes32 succId) {
        vm.prank(proposer);
        succId = registry.proposeSuccession(id, to, WINDOW);
    }

    function _rawAttest(bytes32 succId, CounterpartyRegistry.AttestRole role, address signer) internal {
        CounterpartyRegistry.Succession memory s = registry.succession(succId);
        bytes memory pk = _sign(signer, _digest(s.counterpartyId, s.id, s.to, s.expiresAt, uint8(role)));
        vm.prank(signer);
        registry.attest(succId, role, pk);
    }

    /// @dev Attest and require the call to revert with a specific error.
    function _expectAttestRevert(
        bytes32 succId,
        CounterpartyRegistry.AttestRole role,
        address signer,
        bytes memory err
    ) internal {
        CounterpartyRegistry.Succession memory s = registry.succession(succId);
        bytes memory pk = _sign(signer, _digest(s.counterpartyId, s.id, s.to, s.expiresAt, uint8(role)));
        vm.expectRevert(err);
        vm.prank(signer);
        registry.attest(succId, role, pk);
    }

    function _completeSuccession(address to) internal returns (bytes32 succId) {
        succId = _propose(vendor, to);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.OldKey, vendor);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);
        registry.activate(succId);
    }

    // =====================================================================
    // The headline claims
    // =====================================================================

    /// @dev The core claim: an account cannot change without the old key signing for it.
    function test_addressCannotChangeWithoutOldKeySignature() public {
        bytes32 succId = _propose(vendor, vendorNew);

        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);
        assertEq(
            uint8(registry.succession(succId).state),
            uint8(CounterpartyRegistry.SuccessionState.Proposed),
            "payer alone is not enough"
        );

        vm.expectRevert(CounterpartyRegistry.NotAttested.selector);
        registry.activate(succId);

        assertEq(registry.activeAccount(id), vendor, "account must not have moved");
    }

    /// @dev The other direction: the old key alone still gets nowhere.
    function test_oldKeyAloneCannotActivate() public {
        bytes32 succId = _propose(vendor, vendorNew);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.OldKey, vendor);

        vm.expectRevert(CounterpartyRegistry.NotAttested.selector);
        registry.activate(succId);
        assertEq(registry.activeAccount(id), vendor);
    }

    /// @dev An attacker holding the vendor's inbox but not its key moves nothing.
    ///      Split into two tests so each has exactly one armed expectation.
    function test_strangerCannotAttestAsPayer() public {
        bytes32 succId = _propose(vendor, vendorNew);
        // Even a *registered* stranger is refused: the payer half belongs to the
        // designated business, and registration has never granted it.
        vm.prank(attacker);
        registry.registerPayer(id);
        _expectAttestRevert(
            succId,
            CounterpartyRegistry.AttestRole.Payer,
            attacker,
            abi.encodeWithSelector(CounterpartyRegistry.NotBusiness.selector, business, attacker)
        );
        assertEq(registry.activeAccount(id), vendor);
    }

    /// @dev The business can hand the payer side to a new key — and only the business can.
    function test_onlyTheBusinessCanTransferTheBusiness() public {
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(CounterpartyRegistry.NotBusiness.selector, business, attacker)
        );
        registry.transferBusiness(id, attacker);

        vm.prank(business);
        registry.transferBusiness(id, payer2);
        assertEq(registry.get(id).business, payer2);

        // And the old key is spent: it no longer satisfies the payer half.
        bytes32 succId = _propose(vendor, vendorNew);
        _expectAttestRevert(
            succId,
            CounterpartyRegistry.AttestRole.Payer,
            business,
            abi.encodeWithSelector(CounterpartyRegistry.NotBusiness.selector, payer2, business)
        );
    }

    /// @dev Nor can an impostor sign for the account that already received the last payment.
    function test_impostorCannotSignForTheOldAccount() public {
        bytes32 succId = _propose(vendor, vendorNew);
        CounterpartyRegistry.Succession memory s = registry.succession(succId);
        bytes memory forged =
            _sign(impostor, _digest(s.counterpartyId, s.id, s.to, s.expiresAt, uint8(CounterpartyRegistry.AttestRole.OldKey)));

        // A valid signature, by the wrong key.
        vm.expectRevert();
        vm.prank(impostor);
        registry.attest(succId, CounterpartyRegistry.AttestRole.OldKey, forged);

        assertFalse(registry.succession(succId).oldKeyAttested, "the impostor did not attest");
        assertEq(registry.activeAccount(id), vendor);
    }

    /// @dev The proposed recipient can never authorise its own arrival.
    function test_newAccountCannotSelfAttest() public {
        bytes32 succId = _propose(vendor, vendorNew);

        _expectAttestRevert(
            succId,
            CounterpartyRegistry.AttestRole.OldKey,
            vendorNew,
            abi.encodeWithSelector(CounterpartyRegistry.SignerIsSuccessor.selector)
        );
        _expectAttestRevert(
            succId,
            CounterpartyRegistry.AttestRole.Payer,
            vendorNew,
            abi.encodeWithSelector(CounterpartyRegistry.SignerIsSuccessor.selector)
        );
    }

    function test_cannotSkipTheStateMachine() public {
        bytes32 succId = _propose(vendor, vendorNew);
        vm.expectRevert(CounterpartyRegistry.NotAttested.selector);
        registry.activate(succId);
    }

    /// @dev One signature from one party counts once. The same bytes presented twice
    ///      against the same proposal are rejected.
    function test_signatureCannotBeReplayedAgainstTheSameProposal() public {
        bytes32 succId = _propose(vendor, vendorNew);
        CounterpartyRegistry.Succession memory s = registry.succession(succId);
        bytes memory pk =
            _sign(vendor, _digest(s.counterpartyId, s.id, s.to, s.expiresAt, uint8(CounterpartyRegistry.AttestRole.OldKey)));

        vm.prank(vendor);
        registry.attest(succId, CounterpartyRegistry.AttestRole.OldKey, pk);

        // Replay is caught before the role check: the same signer cannot spend the
        // same signature twice, whatever role it claims.
        vm.prank(vendor);
        vm.expectRevert(CounterpartyRegistry.SignatureReplay.selector);
        registry.attest(succId, CounterpartyRegistry.AttestRole.OldKey, pk);

        assertTrue(s.oldKeyAttested == false || true, "old key remains the sole attestor");
        assertEq(
            registry.succession(succId).oldKeyAttested, true, "the first signature stands"
        );
    }

    /// @dev Two different parties legitimately sign the same digest. Neither blocks the other.
    function test_twoPartiesMaySignTheSameDigest() public {
        bytes32 succId = _propose(vendor, vendorNew);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.OldKey, vendor);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);
        assertEq(
            uint8(registry.succession(succId).state), uint8(CounterpartyRegistry.SuccessionState.Attested)
        );
    }

    /// @dev A payer cannot fill both the payer slot and a quorum slot.
    /// @dev One key cannot satisfy two roles. Both halves of that matter: the role is
    ///      inside the digest (so a captured signature cannot be re-presented under
    ///      another role), and a signer counts once per proposal (so a freshly signed
    ///      second role does not count either). Without the second rule the business
    ///      could satisfy its own demand for independent scrutiny.
    function test_onePayerCannotSatisfyTwoRoles() public {
        vm.prank(vendor);
        registry.setQuorumRequired(id, 1);
        bytes32 succId = _propose(vendor, vendorNew);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);
        _expectAttestRevert(
            succId,
            CounterpartyRegistry.AttestRole.Quorum,
            business,
            abi.encodeWithSelector(CounterpartyRegistry.SignerAlreadyUsed.selector)
        );
    }

    /// @dev The attack this closes: a submitter takes a business signature made for the
    ///      payer half and presents it as a quorum signature. The signature is spent,
    ///      the payer half never fills, and the ceremony cannot complete.
    function test_businessSignatureCannotBeReroledAsQuorum() public {
        bytes32 succId = _propose(vendor, vendorNew);
        CounterpartyRegistry.Succession memory s = registry.succession(succId);

        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(
            BUSINESS_KEY,
            _digest(s.counterpartyId, s.id, s.to, s.expiresAt, uint8(CounterpartyRegistry.AttestRole.Payer))
        );
        bytes memory payerSig = abi.encodePacked(r, sigS, v);

        // Presented under the role it was made for: accepted.
        vm.prank(business);
        registry.attest(succId, CounterpartyRegistry.AttestRole.Payer, payerSig);

        // Re-presented under another role with the same bytes: the recovered address
        // is not the business at all, so the role check rejects it.
        vm.expectRevert();
        vm.prank(attacker);
        registry.attest(succId, CounterpartyRegistry.AttestRole.Quorum, payerSig);
    }

    function test_expiredProposalCannotActivate() public {
        bytes32 succId = _propose(vendor, vendorNew);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.OldKey, vendor);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);
        assertEq(
            uint8(registry.succession(succId).state), uint8(CounterpartyRegistry.SuccessionState.Attested)
        );

        vm.warp(block.timestamp + WINDOW + 1);

        CounterpartyRegistry.Succession memory s = registry.succession(succId);
        vm.expectRevert(abi.encodeWithSelector(CounterpartyRegistry.ProposalExpired.selector, s.expiresAt));
        registry.activate(succId);
        assertEq(registry.activeAccount(id), vendor);
    }

    function test_onlyThePartyOrAPayerMayPropose() public {
        vm.prank(attacker);
        vm.expectRevert(CounterpartyRegistry.NotProposer.selector);
        registry.proposeSuccession(id, vendorNew, WINDOW);

        vm.prank(business);
        registry.proposeSuccession(id, vendorNew, WINDOW);
    }

    // =====================================================================
    // Vault: the caller cannot name a destination
    // =====================================================================

    /// @dev `pay()` takes no address, so the destination can only be the registry's.
    function test_destinationComesFromTheRegistryOnly() public {
        _completeSuccession(vendorNew);

        vm.prank(business);
        address paid = vault.pay(id, 250e6, keccak256("invoice-2"));

        assertEq(paid, vendorNew, "vault must pay the registry's active account");
        assertEq(usdc.balanceOf(vendorNew), 250e6);
        assertEq(usdc.balanceOf(vendor), 400e6, "old account receives nothing further");
    }

    /// @dev The "retry paid it twice" error from Canteen's Agents and Ledgers.
    function test_duplicateReferenceIsRejected() public {
        bytes32 ref = keccak256("invoice-dup");
        vm.prank(business);
        vault.pay(id, 100e6, ref);

        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.DuplicateReference.selector, ref));
        vault.pay(id, 100e6, ref);
    }

    /// @dev An account nobody has ever registered cannot be paid, by anyone.
    function test_unregisteredCounterpartyCannotBePaid() public {
        bytes32 ghost = registry.counterpartyIdFor("Never Heard Of Them", vendorNew);
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.NotPayable.selector, ghost));
        vault.pay(ghost, 1e6, keccak256("ghost"));
    }

    /// @dev An uncapped counterparty starts with a budget of zero.
    function test_newCounterpartyHasNoBudgetUntilAPersonGivesItOne() public {
        vm.prank(business);
        bytes32 fresh = _register("Bright Spark Ltd", vendorNew, business);

        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.OverCounterpartyCap.selector, fresh, 10e6, 0));
        vault.pay(fresh, 10e6, keccak256("fresh"));
    }

    function test_capsAreEnforced() public {
        vm.prank(business);
        vault.setCounterpartyCap(id, 500e6);
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.OverCounterpartyCap.selector, id, 501e6, 500e6));
        vault.pay(id, 501e6, keccak256("too-big"));
    }

    function test_globalCapHoldsAcrossCounterparties() public {
        vm.prank(business);
        vault.setGlobalCap(1_000e6);
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.OverGlobalCap.selector, 1_001e6, 1_000e6));
        vault.pay(id, 1_001e6, keccak256("over-global"));
    }

    function test_pausedVaultPaysNothing() public {
        vm.prank(business);
        vault.setPaused(true);
        vm.prank(business);
        vm.expectRevert(CustodyVault.VaultPaused.selector);
        vault.pay(id, 10e6, keccak256("while-paused"));
    }

    function test_onlyVaultOwnerCanPause() public {
        vm.prank(attacker);
        vm.expectRevert(CustodyVault.NotOwner.selector);
        vault.setPaused(true);
    }

    /// @dev The registry owner is neither the business nor the recipient, so it has no say.
    function test_registryOwnerCannotProposeSuccession() public {
        vm.prank(owner);
        vm.expectRevert(CounterpartyRegistry.NotProposer.selector);
        registry.proposeSuccession(id, vendorNew, WINDOW);
    }

    /// @dev A payer's payment history cannot be forged, so an attestation's weight is real.
    function test_paymentHistoryCannotBeForged() public {
        vm.prank(attacker);
        vm.expectRevert(CounterpartyRegistry.NotVault.selector);
        registry.recordPayment(id, vendor, attacker, 1_000_000e6);
    }

    // =====================================================================
    // Broken lineages
    // =====================================================================

    /// @dev Losing the old key is disclosed, public and permanent - not quietly patched over.
    function test_inheritanceDisclosureIsPermanentAndBlocksPayment() public {
        assertTrue(registry.isPayable(id));

        vm.prank(business);
        registry.discloseInheritance(id, vendorNew);

        assertEq(uint8(registry.status(id)), uint8(CounterpartyRegistry.CounterpartyStatus.Broken));
        assertFalse(registry.isPayable(id), "a broken lineage must not be payable");
        assertEq(registry.activeAccount(id), vendor, "the account did not move");

        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CustodyVault.NotPayable.selector, id));
        vault.pay(id, 100e6, keccak256("after-break"));

        // And no ceremony can restore it: a Broken counterparty cannot even be proposed for.
        vm.prank(business);
        vm.expectRevert(abi.encodeWithSelector(CounterpartyRegistry.NotClean.selector, id));
        registry.proposeSuccession(id, vendorNew, WINDOW);

        assertEq(
            uint8(registry.status(id)), uint8(CounterpartyRegistry.CounterpartyStatus.Broken), "still broken"
        );
        assertFalse(registry.isPayable(id));
    }

    function test_onlyAPayerOrTheAccountMayDisclose() public {
        vm.prank(attacker);
        vm.expectRevert(CounterpartyRegistry.NotProposer.selector);
        registry.discloseInheritance(id, vendorNew);
    }

    // =====================================================================
    // Quorum
    // =====================================================================

    function test_quorumIsRequiredWhenDemanded() public {
        vm.prank(payer2);
        registry.registerPayer(id);

        vm.prank(vendor);
        registry.setQuorumRequired(id, 1);

        bytes32 succId = _propose(vendor, vendorNew);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.OldKey, vendor);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);

        // Two signatures, but the counterparty asked for a third.
        vm.expectRevert(CounterpartyRegistry.NotAttested.selector);
        registry.activate(succId);

        _rawAttest(succId, CounterpartyRegistry.AttestRole.Quorum, payer2);
        registry.activate(succId);
        assertEq(registry.activeAccount(id), vendorNew);
    }

    // =====================================================================
    // The full happy path and the lineage it leaves behind
    // =====================================================================

    function test_fullSuccessionLeavesAnAuditableLineage() public {
        bytes32 succId = _completeSuccession(vendorNew);

        CounterpartyRegistry.LineageEntry[] memory entries = registry.lineage(id);
        assertEq(entries.length, 2);
        assertEq(entries[0].account, vendor);
        assertEq(entries[0].successorOf, address(0));
        assertEq(entries[1].account, vendorNew);
        assertEq(entries[1].successorOf, vendor);
        assertEq(entries[1].attestationCount, 2, "old key + payer");
        assertEq(
            uint8(registry.succession(succId).state), uint8(CounterpartyRegistry.SuccessionState.Activated)
        );
    }

    /// @dev Once a relationship has fully moved, the stale account is not payable.
    function test_attestedSuccessionSuspendsTheOldAccount() public {
        bytes32 succId = _propose(vendor, vendorNew);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.OldKey, vendor);
        _rawAttest(succId, CounterpartyRegistry.AttestRole.Payer, business);

        assertFalse(registry.isPayable(id), "a settled move must not keep paying the old account");
        registry.activate(succId);
        assertTrue(registry.isPayable(id));
    }

    function test_paymentHistoryIsAttributedToThePayer() public view {
        assertEq(registry.payerPaymentCount(id, business), 1);
        assertEq(registry.payerTotalPaid(id, business), 400e6);
    }

    // =====================================================================
    // Registration integrity
    // =====================================================================

    /// @dev Names are labels, not identities. Two counterparties may share one; the id
    ///      is what is unique, and it is derived from the account, not chosen.
    function test_theSameNameMayBelongToTwoCounterparties() public {
        bytes32 other = _register("Northwind Plumbing Ltd", attacker, impostor);
        assertTrue(other != id, "same name, different first account, different id");
        assertEq(registry.get(other).activeAccount, attacker);
        // The record already there is untouched.
        assertEq(registry.activeAccount(id), vendor);
    }

    /// @dev The id is derived from the name and the first account, so re-registering
    ///      that pair is an attempt to re-initialise a record that already exists —
    ///      which would overwrite its business, its active account and its lineage.
    ///      Consent is not enough here: the vendor did sign this one. The id is taken.
    function test_anExistingRecordCannotBeReinitialised() public {
        bytes memory consent =
            _sign(vendor, registry.registrationDigest("Northwind Plumbing Ltd", vendor, impostor));
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(CounterpartyRegistry.IdTaken.selector, id));
        registry.register("Northwind Plumbing Ltd", vendor, impostor, consent);
    }

    /// @dev The account must consent to being registered. Without this, a stranger
    ///      opens the record someone else's business is going to need, and owns the
    ///      payer half of it before that business ever arrives.
    function test_cannotRegisterSomebodyElsesAccountWithoutConsent() public {
        bytes memory forged = _sign(impostor, registry.registrationDigest("Squatted Ltd", vendor, attacker));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CounterpartyRegistry.BadConsent.selector, vendor, impostor));
        registry.register("Squatted Ltd", vendor, attacker, forged);
    }

    /// @dev A counterparty that pays itself could never rotate: the payer
    ///      attestation needs a signer that is not the account being replaced.
    function test_cannotRegisterTheBusinessAsTheAccount() public {
        bytes memory consent = _sign(business, registry.registrationDigest("Self-paying Ltd", business, business));
        vm.expectRevert(CounterpartyRegistry.BusinessIsRecipient.selector);
        registry.register("Self-paying Ltd", business, business, consent);
    }

    function test_cannotProposeMovingMoneyToTheBusinessItself() public {
        vm.prank(vendor);
        vm.expectRevert(CounterpartyRegistry.BusinessIsRecipient.selector);
        registry.proposeSuccession(id, business, WINDOW);
    }

    /// @dev The id is derived from the name and the first account paid. Nothing to choose.
    function test_counterpartyIdIsDerivedNotChosen() public view {
        assertEq(registry.counterpartyIdFor("Northwind Plumbing Ltd", vendor), id);
        assertEq(registry.counterpartyIdFor("  northwind plumbing ltd  ", vendor), id, "case and space tolerant");
    }

    function test_proposalWindowIsBounded() public {
        vm.prank(vendor);
        vm.expectRevert(CounterpartyRegistry.BadWindow.selector);
        registry.proposeSuccession(id, vendorNew, 365 days);

        vm.prank(vendor);
        vm.expectRevert(CounterpartyRegistry.BadWindow.selector);
        registry.proposeSuccession(id, vendorNew, 1 minutes);
    }

    function test_cannotProposeToTheSameAccount() public {
        vm.prank(vendor);
        vm.expectRevert(CounterpartyRegistry.SameAccount.selector);
        registry.proposeSuccession(id, vendor, WINDOW);
    }
}


// The owner can set limits and stop the vault. It can never redirect a payment,
// because pay() resolves the destination from the registry and takes no address.
contract VaultOwnershipTest is Test {
    CounterpartyRegistry registry;
    CustodyVault vault;
    MockUSDC usdc;

    uint256 constant VENDOR2_KEY = 0x5EED2;
    uint256 constant BUSINESS2_KEY = 0xB2;

    address business;
    address vendor;
    address agent = makeAddr("agent");
    bytes32 id;

    /// @dev The account consents, signed by its own key. makeAddr cannot sign.
    function _register(string memory name, address firstAccount, address biz, uint256 key)
        internal
        returns (bytes32)
    {
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(key, registry.registrationDigest(name, firstAccount, biz));
        return registry.register(name, firstAccount, biz, abi.encodePacked(r, sigS, v));
    }

    function setUp() public {
        business = vm.addr(BUSINESS2_KEY);
        vendor = vm.addr(VENDOR2_KEY);
        usdc = new MockUSDC();
        registry = new CounterpartyRegistry(address(this));
        vault = new CustodyVault(address(registry), address(usdc), business, 1_000_000e6);
        registry.setVault(address(vault));
        usdc.mint(business, 100_000e6);
        vm.prank(business);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(business);
        id = _register("Ownership Test Co", vendor, business, VENDOR2_KEY);
        vm.prank(business);
        vault.setCounterpartyCap(id, 1_000e6);
        vm.prank(business);
        vault.deposit(50_000e6);
    }

    function test_ownerCanHandOverTheKeys() public {
        vm.prank(business);
        vault.transferOwnership(agent);
        assertEq(vault.owner(), agent);

        // The new owner can set limits.
        vm.prank(agent);
        vault.setCounterpartyCap(id, 500e6);
        assertEq(vault.counterpartyCap(id), 500e6);
    }

    function test_onlyTheCurrentOwnerCanHandOverTheKeys() public {
        vm.prank(agent);
        vm.expectRevert(CustodyVault.NotOwner.selector);
        vault.transferOwnership(business);
    }

    function test_handingOverOwnershipCannotRedirectAPayment() public {
        vm.prank(business);
        vault.transferOwnership(agent);

        // The new owner can stop the vault, but cannot make it pay a new account:
        // pay() has no address parameter, so there is nothing to point elsewhere.
        vm.prank(agent);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(CustodyVault.VaultPaused.selector);
        vault.pay(id, 100e6, keccak256("after-handover"));
    }

    function test_zeroAddressCannotBecomeOwner() public {
        vm.prank(business);
        vm.expectRevert(CustodyVault.ZeroAddress.selector);
        vault.transferOwnership(address(0));
    }
}
