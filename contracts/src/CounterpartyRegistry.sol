// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title CounterpartyRegistry
 * @notice A durable identity for a party you pay, and a public lineage of every
 *         account that party has ever received money at.
 *
 * @dev The one rule this contract exists to enforce:
 *
 *        A change of payment address is a succession ceremony, not a field update.
 *
 *      There is no `updateAccount(address)`. There is no owner function that can
 *      set an active account. The active account of a counterparty can only ever
 *      change by going through `proposeSuccession` -> `attest` -> `activate`, and
 *      activation requires TWO independent signatures that cannot come from the
 *      party trying to receive the money:
 *
 *        - the OLD account (the one that received the last payment), and
 *        - a registered payer (the business that is paying).
 *
 *      The proposed new account can never supply either signature. If the old key
 *      is lost, the only path forward is `discloseInheritance`, which marks the
 *      counterparty BROKEN in public and permanently. That is deliberate: the
 *      alternative to a disclosed break is a quiet reset, and a quiet reset
 *      launders fraud.
 */
contract CounterpartyRegistry {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum CounterpartyStatus {
        None, // not registered
        Clean, // has an active account, no disclosed break
        Broken // an inheritance gap was disclosed in public and is permanent
    }

    enum SuccessionState {
        None,
        Proposed, // requested, expires, does nothing on its own
        Attested, // old key + payer ( + quorum ) have signed; waiting for activation
        Activated, // the new account is now the active account
        Expired // the window closed; the proposal is dead
    }

    /// @dev `OldKey` is the account that received the last payment.
    ///      `Payer` and `Quorum` are businesses that pay this counterparty.
    ///      The proposed new account is never a valid signer for any role.
    enum AttestRole {
        OldKey,
        Payer,
        Quorum
    }

    struct LineageEntry {
        address account;
        uint64 activatedAt;
        uint16 attestationCount; // how many independent parties signed this account in
        address successorOf; // address(0) for the first account
        address activatedBy;
    }

    struct Succession {
        bytes32 counterpartyId;
        bytes32 id;
        address from;
        address to;
        address proposer;
        uint64 proposedAt;
        uint64 expiresAt;
        SuccessionState state;
        bool oldKeyAttested;
        bool payerAttested;
        address[] quorumAttestors;
    }

    struct Counterparty {
        bytes32 id;
        string canonicalName;
        CounterpartyStatus status;
        address activeAccount;
        address registrant;
        /**
         * The one address whose signature satisfies the payer half of a succession.
         *
         * Set once at registration, transferable only by itself. This is the entire
         * difference between "someone countersigned" and "the business agreed": without
         * a designated party, any stranger could register as a payer and sign the payer
         * half themselves, and a single compromised vendor key would be enough to
         * redirect everything. With it, moving an account needs two keys that no one
         * party holds.
         */
        address business;
        uint64 registeredAt;
        uint16 version; // number of accounts in the lineage
        uint16 quorumRequired;
        uint64 brokenDisclosedAt;
        address disclosedSuccessor;
        bytes32[] successionIds;
        LineageEntry[] entries;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    bytes32 public constant SUCCESSION_ATTESTATION_TYPEHASH = keccak256(
        "SuccessionAttestation(bytes32 counterpartyId,bytes32 successionId,address to,uint256 expiry,uint8 role)"
    );

    /// @dev The first account consents to being registered. Without this, a
    ///      stranger can open a record at someone else's address and leave the
    ///      honest business either locked out of its own counterparty or forced to
    ///      abandon the name.
    bytes32 public constant REGISTRATION_CONSENT_TYPEHASH = keccak256(
        "RegisterCounterparty(bytes32 nameHash,address firstAccount,address business)"
    );

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant _NAME = keccak256("Horos Counterparty Registry");
    string private constant _VERSION = "1";

    /// @dev A proposal window can never be longer than this, however long the proposer asks for.
    uint64 public constant MAX_PROPOSAL_WINDOW = 30 days;
    uint64 public constant MIN_PROPOSAL_WINDOW = 1 hours;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    Counterparty private _cp;
    address public immutable registryOwner;

    /// @dev canonical name hash -> counterparty id. First registrant holds the name.
    mapping(bytes32 => bytes32) public nameIndex;
    mapping(bytes32 => Counterparty) private _counterparties;
    mapping(bytes32 => bytes32[]) private _byName;

    /// @dev Registered payers. Registration grants the right to propose a succession
    ///      and to attest as quorum — nothing else. It has never granted the payer half
    ///      of a succession, which belongs to the designated business alone.
    mapping(bytes32 => mapping(address => bool)) public isPayer;
    /// @dev Successful payments attributed to a payer. An attestation carries its own history.
    mapping(bytes32 => mapping(address => uint256)) public payerPaymentCount;
    mapping(bytes32 => mapping(address => uint256)) public payerTotalPaid;

    mapping(bytes32 => Succession) private _successions;
    mapping(bytes32 => uint256) private _proposalNonce;

    /// @dev Global replay protection: a signature is good exactly once, ever.
    mapping(bytes32 => bool) public signatureUsed;

    /// @dev One key counts once per proposal, whatever role it is presented under.
    ///      Role-binding the digest stops a captured signature being spent under a
    ///      different role, but it also means a fresh signature per role is possible
    ///      — so the business could sign again as quorum and satisfy its own demand
    ///      for independent scrutiny. This is what refuses that.
    mapping(bytes32 => mapping(address => bool)) public signerUsed;

    /// @dev Only the vault may call this.
    mapping(address => bool) public vault;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CounterpartyRegistered(
        bytes32 indexed id, string canonicalName, address indexed firstAccount, address indexed registrant
    );
    event PayerRegistered(bytes32 indexed id, address indexed payer);
    event BusinessTransferred(bytes32 indexed id, address indexed from, address indexed to);
    event SuccessionProposed(
        bytes32 indexed successionId,
        bytes32 indexed counterpartyId,
        address indexed from,
        address to,
        address proposer,
        uint64 expiresAt
    );
    event SuccessionAttested(
        bytes32 indexed successionId, AttestRole role, address indexed signer, bool complete
    );
    event SuccessionActivated(bytes32 indexed successionId, bytes32 indexed counterpartyId, address account);
    event SuccessionExpired(bytes32 indexed successionId);
    event InheritanceDisclosed(bytes32 indexed counterpartyId, address indexed disclosedSuccessor, address by);
    event PaymentRecorded(
        bytes32 indexed counterpartyId, address indexed account, address indexed payer, uint256 amount
    );
    event QuorumRequiredSet(bytes32 indexed counterpartyId, uint16 quorumRequired);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotRegistryOwner();
    error NotVault();
    error EmptyName();
    error NameTaken(bytes32 nameHash, bytes32 existingId);
    error UnknownCounterparty(bytes32 id);
    error ZeroAddress();
    error SameAccount();
    error NotClean(bytes32 id);
    error NotActiveAccount();
    error NotRegisteredPayer();
    error NotProposer();
    error BadWindow();
    error UnknownSuccession(bytes32 successionId);
    error NotProposed();
    error ProposalExpired(uint64 expiresAt);
    error BadSigner(address expected, address got);
    error NotBusiness(address expected, address got);
    error IdTaken(bytes32 id);
    error BadConsent(address expected, address got);
    error StaleProposal(address proposalFrom, address activeAccount);
    error BusinessIsRecipient();
    error SignerIsSuccessor();
    error SignerAlreadyUsed();
    error SignatureReplay();
    error NotAttested();
    error AlreadyAttested();
    error AlreadyFinal();
    error QuorumNotMet(uint256 have, uint256 need);
    error BadSignature();
    error BadSignatureLength();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        registryOwner = initialOwner;
        _cp = Counterparty(bytes32(0), "", CounterpartyStatus.None, address(0), address(0), address(0), 0, 0, 0, 0, address(0), new bytes32[](0), new LineageEntry[](0));
    }

    modifier onlyRegistryOwner() {
        if (msg.sender != registryOwner) revert NotRegistryOwner();
        _;
    }

    modifier onlyVault() {
        if (!vault[msg.sender]) revert NotVault();
        _;
    }

    function setVault(address v) external onlyRegistryOwner {
        if (v == address(0)) revert ZeroAddress();
        vault[v] = true;
    }

    // ---------------------------------------------------------------------
    // EIP-712
    // ---------------------------------------------------------------------

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                _EIP712_DOMAIN_TYPEHASH, _NAME, _VERSION, block.chainid, address(this)
            )
        );
    }

    function successionDigest(bytes32 counterpartyId, bytes32 successionId, address to, uint256 expiry, uint8 role)
        public
        view
        returns (bytes32)
    {
        return _attestationDigest(counterpartyId, successionId, to, expiry, role);
    }

    /// @notice The message the first account signs to consent to being registered.
    function registrationDigest(string calldata canonicalName, address firstAccount, address business)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(
                    abi.encode(
                        REGISTRATION_CONSENT_TYPEHASH, keccak256(bytes(_canonicalise(canonicalName))), firstAccount, business
                    )
                )
            )
        );
    }

    function _attestationDigest(bytes32 counterpartyId, bytes32 successionId, address to, uint256 expiry, uint8 role)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator(),
                keccak256(
                    abi.encode(
                        SUCCESSION_ATTESTATION_TYPEHASH, counterpartyId, successionId, to, expiry, role
                    )
                )
            )
        );
    }

    // ---------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------

    /**
     * @notice Register a counterparty, open its lineage at `firstAccount`, and name the
     *         one party whose signature satisfies the payer half of every future succession.
     * @dev The counterparty id is derived deterministically from the canonical name and the
     *      first account that received money. Anyone who can show they paid `firstAccount`
     *      computes the same id. There is no random salt, so there is nothing to squat on
     *      except by being the first to actually pay.
     *
     *      `business` must be a key the actual business holds — never the agent wallet,
     *      never a hot demo key left in a shell. Anyone may register, and the registrant
     *      names the business, because for a brand-new counterparty there is nobody else
     *      to ask; from then on, only the business speaks for the payer side.
     */
    function register(
        string calldata canonicalName,
        address firstAccount,
        address business,
        bytes calldata consent
    ) external returns (bytes32 id) {
        if (firstAccount == address(0)) revert ZeroAddress();
        if (business == address(0)) revert ZeroAddress();
        // A counterparty whose own account pays it cannot rotate: the payer
        // attestation requires a signer that is not the account being replaced.
        // Refusing the shape here is cheaper than a counterparty that can never
        // leave a bad key.
        if (business == firstAccount) revert BusinessIsRecipient();

        string memory canon = _canonicalise(canonicalName);
        if (bytes(canon).length == 0) revert EmptyName();

        bytes32 nameHash = keccak256(bytes(canon));

        // The account itself must agree. An id is derived from the name and the
        // first account, so a stranger who could name someone else's account would
        // create the record that account's real business is going to want -- and
        // would hold the payer half of it. Consent is what makes "first to pay"
        // meaningful; without it, "first to type" was enough.
        {
            bytes32 consentDigest = keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator(),
                    keccak256(abi.encode(REGISTRATION_CONSENT_TYPEHASH, nameHash, firstAccount, business))
                )
            );
            address consenter = _recover(consentDigest, consent);
            if (consenter != firstAccount) revert BadConsent(firstAccount, consenter);
        }

        id = keccak256(abi.encode(nameHash, firstAccount, address(this)));
        if (_counterparties[id].status != CounterpartyStatus.None) revert IdTaken(id);

        // Names are not exclusive. The id is the identity; a name is a label two
        // different counterparties may share, and making the label unique handed
        // anyone a way to lock a competitor out of the registry for free. The name
        // index keeps the first id seen under a name as a convenience only --
        // callers who need a specific record use counterpartyIdFor().
        if (nameIndex[nameHash] == bytes32(0)) nameIndex[nameHash] = id;
        _byName[nameHash].push(id);

        Counterparty storage c = _counterparties[id];
        c.id = id;
        c.canonicalName = canon;
        c.status = CounterpartyStatus.Clean;
        c.activeAccount = firstAccount;
        c.registrant = msg.sender;
        c.business = business;
        c.registeredAt = uint64(block.timestamp);
        c.version = 1;
        c.entries.push(
            LineageEntry({
                account: firstAccount,
                activatedAt: uint64(block.timestamp),
                attestationCount: 1, // opened by the payer's own payment evidence
                successorOf: address(0),
                activatedBy: msg.sender
            })
        );

        isPayer[id][msg.sender] = true;

        emit CounterpartyRegistered(id, canon, firstAccount, msg.sender);
    }

    /// @notice Register yourself as a payer of this counterparty.
    /// @dev Registration alone can only ever withhold a payer attestation. It can never
    ///      move money, change an account, or activate a succession.
    function registerPayer(bytes32 id) external {
        _requireKnown(id);
        isPayer[id][msg.sender] = true;
        emit PayerRegistered(id, msg.sender);
    }

    /**
     * @notice Hand the payer side of a counterparty to a new key.
     * @dev Only the current business. Lost the key? That is what
     *      discloseInheritance() is for — a public, permanent break, not a quiet one.
     */
    function transferBusiness(bytes32 id, address newBusiness) external {
        Counterparty storage c = _counterparties[id];
        if (c.status == CounterpartyStatus.None) revert UnknownCounterparty(id);
        if (msg.sender != c.business) revert NotBusiness(c.business, msg.sender);
        if (newBusiness == address(0)) revert ZeroAddress();
        emit BusinessTransferred(id, c.business, newBusiness);
        c.business = newBusiness;
    }

    function setQuorumRequired(bytes32 id, uint16 quorum) external {
        Counterparty storage c = _counterparties[id];
        if (c.status == CounterpartyStatus.None) revert UnknownCounterparty(id);
        // Only the party receiving the money, or the business paying it, may demand
        // more scrutiny. Any registered payer used to qualify, and registration is
        // permissionless — so any stranger could set an unmeetable quorum and strand
        // the counterparty. That door is now shut.
        if (msg.sender != c.activeAccount && msg.sender != c.business) revert NotProposer();
        c.quorumRequired = quorum;
        emit QuorumRequiredSet(id, quorum);
    }

    // ---------------------------------------------------------------------
    // Succession
    // ---------------------------------------------------------------------

    /**
     * @notice Propose moving a counterparty to a new account.
     * @dev A proposal does nothing by itself. It expires. It changes no state a payer relies on.
     *      Either the current account or a registered payer may propose; nobody else.
     */
    function proposeSuccession(bytes32 id, address to, uint64 validFor)
        external
        returns (bytes32 successionId)
    {
        Counterparty storage c = _counterparties[id];
        if (c.status == CounterpartyStatus.None) revert UnknownCounterparty(id);
        if (c.status != CounterpartyStatus.Clean) revert NotClean(id);
        if (to == address(0)) revert ZeroAddress();
        if (to == c.activeAccount) revert SameAccount();
        if (to == c.business) revert BusinessIsRecipient();

        // Only the party currently entitled to the money, or someone who pays it, may propose.
        if (msg.sender != c.activeAccount && !isPayer[id][msg.sender]) revert NotProposer();

        if (validFor < MIN_PROPOSAL_WINDOW || validFor > MAX_PROPOSAL_WINDOW) revert BadWindow();
        uint64 expiry = uint64(block.timestamp) + validFor;

        successionId = keccak256(
            abi.encode(id, c.activeAccount, to, expiry, _proposalNonce[id]++)
        );

        Succession storage s = _successions[successionId];
        s.counterpartyId = id;
        s.id = successionId;
        s.from = c.activeAccount;
        s.to = to;
        s.proposer = msg.sender;
        s.proposedAt = uint64(block.timestamp);
        s.expiresAt = expiry;
        s.state = SuccessionState.Proposed;

        c.successionIds.push(successionId);

        emit SuccessionProposed(successionId, id, c.activeAccount, to, msg.sender, expiry);
    }

    /**
     * @notice Attach a signature to a succession proposal.
     * @param role OldKey signs with the account that received the last payment.
     *             Payer signs with the designated business key — the one named at
     *             registration, nobody else. Quorum signs with a registered payer's key.
     * @dev The proposed new account (`to`) is never a valid signer. It cannot pay itself in.
     */
    function attest(bytes32 successionId, AttestRole role, bytes calldata signature) external {
        Succession storage s = _successions[successionId];
        Counterparty storage c = _counterparties[s.counterpartyId];

        // A break is permanent, so it must also stop a proposal that was already
        // in flight when it was disclosed. Otherwise the account moves after the
        // public record says the relationship is over.
        if (c.status != CounterpartyStatus.Clean) revert NotClean(s.counterpartyId);

        // A proposal is against the account that was active when it was made. Once
        // that changes, the old proposal is a request from a party that no longer
        // holds the role, and replaying it would let an old key move the account
        // twice -- with the middle address never signed for.
        if (s.from != c.activeAccount) revert StaleProposal(s.from, c.activeAccount);

        if (s.state != SuccessionState.Proposed && s.state != SuccessionState.Attested) {
            revert NotProposed();
        }
        if (block.timestamp > s.expiresAt) {
            s.state = SuccessionState.Expired;
            emit SuccessionExpired(successionId);
            revert ProposalExpired(s.expiresAt);
        }

        bytes32 digest = successionDigest(s.counterpartyId, s.id, s.to, s.expiresAt, uint8(role));
        address signer = _recover(digest, signature);

        // The account trying to receive the money can never authorise its own arrival.
        if (signer == s.to) revert SignerIsSuccessor();

        // One signature per (signer, proposal). Two different parties sign the same digest
        // legitimately; the same party signing twice does not count twice.
        bytes32 used = keccak256(abi.encode(signer, digest));
        if (signatureUsed[used]) revert SignatureReplay();
        if (signerUsed[s.id][signer]) revert SignerAlreadyUsed();

        bool complete = false;

        if (role == AttestRole.OldKey) {
            if (signer != s.from) revert BadSigner(s.from, signer);
            if (s.oldKeyAttested) revert AlreadyAttested();
        } else if (role == AttestRole.Payer) {
            // The payer half is the business and nobody else. Checking isPayer here
            // is what the previous version did, and registration is permissionless —
            // so any stranger could countersign their own redirect. The business was
            // named at registration precisely so this check has one right answer.
            if (signer != c.business) revert NotBusiness(c.business, signer);
            if (signer == s.from) revert BadSigner(s.from, signer);
            if (s.payerAttested) revert AlreadyAttested();
        } else {
            if (!isPayer[s.counterpartyId][signer]) revert NotRegisteredPayer();
            if (signer == s.from) revert BadSigner(s.from, signer);
            for (uint256 i = 0; i < s.quorumAttestors.length; ++i) {
                if (s.quorumAttestors[i] == signer) revert AlreadyAttested();
            }
        }

        // The signature is spent only once the signer and the role both check out.
        signatureUsed[used] = true;
        signerUsed[s.id][signer] = true;

        if (role == AttestRole.OldKey) {
            s.oldKeyAttested = true;
        } else if (role == AttestRole.Payer) {
            s.payerAttested = true;
        } else {
            s.quorumAttestors.push(signer);
        }

        uint16 need = c.quorumRequired;
        if (s.oldKeyAttested && s.payerAttested && s.quorumAttestors.length >= need) {
            s.state = SuccessionState.Attested;
            complete = true;
        }

        emit SuccessionAttested(successionId, role, signer, complete);
    }

    /**
     * @notice Activate a fully attested succession.
     * @dev Reverts unless the old key AND a payer (and any required quorum) have all signed,
     *      and the window is still open. There is no other path to a new active account.
     */
    function activate(bytes32 successionId) external {
        Succession storage s = _successions[successionId];
        if (s.state == SuccessionState.Activated || s.state == SuccessionState.Expired) {
            revert AlreadyFinal();
        }
        if (s.state != SuccessionState.Attested) revert NotAttested();

        Counterparty storage c = _counterparties[s.counterpartyId];

        // Checked here as well as in attest(): a proposal can complete before a
        // break is disclosed and be activated after it, and the activation is the
        // step that actually moves the money.
        if (c.status != CounterpartyStatus.Clean) revert NotClean(s.counterpartyId);
        if (s.from != c.activeAccount) revert StaleProposal(s.from, c.activeAccount);

        if (block.timestamp > s.expiresAt) {
            s.state = SuccessionState.Expired;
            emit SuccessionExpired(successionId);
            revert ProposalExpired(s.expiresAt);
        }

        uint16 count = 2; // old key + payer
        if (c.quorumRequired > 0) count = uint16(uint16(2) + s.quorumAttestors.length);

        c.entries.push(
            LineageEntry({
                account: s.to,
                activatedAt: uint64(block.timestamp),
                attestationCount: count,
                successorOf: s.from,
                activatedBy: msg.sender
            })
        );

        c.activeAccount = s.to;
        c.version = uint16(c.entries.length);
        s.state = SuccessionState.Activated;

        emit SuccessionActivated(successionId, s.counterpartyId, s.to);
    }

    /// @notice Permissionless cleanup: a proposal past its window is dead.
    function markExpired(bytes32 successionId) external {
        Succession storage s = _successions[successionId];
        if (s.state != SuccessionState.Proposed && s.state != SuccessionState.Attested) revert NotProposed();
        if (block.timestamp <= s.expiresAt) revert NotAttested();
        s.state = SuccessionState.Expired;
        emit SuccessionExpired(successionId);
    }

    /**
     * @notice The old key is gone. Say so, in public, permanently.
     * @dev This does NOT move the active account. It marks the counterparty Broken so that every
     *      future payer sees a disclosed gap before they send anything. Irreversible by design:
     *      the only alternative to a disclosed break is a quiet one, and a quiet break is how
     *      invoice redirection fraud launders itself.
     */
    function discloseInheritance(bytes32 id, address to) external {
        Counterparty storage c = _counterparties[id];
        if (c.status == CounterpartyStatus.None) revert UnknownCounterparty(id);
        if (c.status != CounterpartyStatus.Clean) revert NotClean(id);
        // Business or the account — never just any payer. A permissionless
        // registerPayer plus this guard used to let any stranger mark any
        // counterparty Broken, permanently. Bricking the record must not be
        // cheaper than using it.
        if (msg.sender != c.activeAccount && msg.sender != c.business) revert NotProposer();

        c.status = CounterpartyStatus.Broken;
        c.brokenDisclosedAt = uint64(block.timestamp);
        c.disclosedSuccessor = to;

        emit InheritanceDisclosed(id, to, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function _requireKnown(bytes32 id) private view {
        if (_counterparties[id].status == CounterpartyStatus.None) revert UnknownCounterparty(id);
    }

    function _canonicalise(string calldata s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 start = 0;
        uint256 end = b.length;
        while (start < end && (b[start] == " " || b[start] == "\t")) {
            ++start;
        }
        while (end > start && (b[end - 1] == " " || b[end - 1] == "\t")) {
            --end;
        }
        bytes memory out = new bytes(end - start);
        for (uint256 i = 0; i < end - start; ++i) {
            bytes1 c = b[start + i];
            if (c >= "A" && c <= "Z") c = bytes1(uint8(c) + 32); // A-Z -> a-z
            out[i] = c;
        }
        return string(out);
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert BadSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (v < 27) v += 27;
        // Reject the upper half of the curve order so a signature has one valid encoding.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    /// @dev Derives the id for a name + first account. Must agree with `register`.
    function counterpartyIdFor(string calldata canonicalName, address firstAccount)
        external
        view
        returns (bytes32)
    {
        bytes32 nameHash = keccak256(bytes(_canonicalise(canonicalName)));
        return keccak256(abi.encode(nameHash, firstAccount, address(this)));
    }

    function canonicalNameHash(string calldata canonicalName) external pure returns (bytes32) {
        return keccak256(bytes(_canonicalise(canonicalName)));
    }

    function get(bytes32 id) external view returns (Counterparty memory) {
        return _counterparties[id];
    }

    function lineage(bytes32 id) external view returns (LineageEntry[] memory) {
        return _counterparties[id].entries;
    }

    function successionsOf(bytes32 id) external view returns (bytes32[] memory) {
        return _counterparties[id].successionIds;
    }

    function succession(bytes32 successionId) external view returns (Succession memory) {
        return _successions[successionId];
    }

    function activeAccount(bytes32 id) external view returns (address) {
        return _counterparties[id].activeAccount;
    }

    function status(bytes32 id) external view returns (CounterpartyStatus) {
        return _counterparties[id].status;
    }

    /**
     * @notice May money be sent to this counterparty right now?
     * @dev False while an inheritance gap is disclosed, and false while a fully attested
     *      succession is waiting to be activated (the relationship has already moved, so
     *      paying the old account would be paying a stale destination).
     */
    function isPayable(bytes32 id) public view returns (bool) {
        Counterparty storage c = _counterparties[id];
        if (c.status != CounterpartyStatus.Clean) return false;
        if (c.activeAccount == address(0)) return false;
        uint256 n = c.successionIds.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_successions[c.successionIds[i]].state == SuccessionState.Attested) return false;
        }
        return true;
    }

    /// @notice Called by the vault after a payment settles.
    function recordPayment(bytes32 id, address account, address payer, uint256 amount) external onlyVault {
        payerPaymentCount[id][payer] += 1;
        payerTotalPaid[id][payer] += amount;
        emit PaymentRecorded(id, account, payer, amount);
    }
}
