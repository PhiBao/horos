// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {CounterpartyRegistry} from "./CounterpartyRegistry.sol";

/**
 * @title CustodyVault
 * @notice The money a business is spending, held onchain, payable only to
 *         counterparties whose payment address the registry has already proven.
 *
 * @dev The interface is the security model.
 *
 *      `pay()` takes a counterparty id. It does not take an address.
 *
 *      The caller - which is an agent - is not able to name a destination. The
 *      destination is read from the registry, and the only way an address becomes
 *      a counterparty's active account is a succession ceremony that the receiving
 *      party cannot complete on its own.
 *
 *      So there is no code path, prompt, or signature an attacker can reach that
 *      results in this vault sending USDC to an account that has not been proven
 *      to be the same counterparty the payer already had.
 *
 *      The owner may move the whole balance out, and may stop payments. The owner
 *      cannot make a payment happen, and cannot make it go somewhere new.
 */
contract CustodyVault {
    CounterpartyRegistry public immutable registry;
    IERC20 public immutable usdc;

    address public owner;
    bool public paused;

    /// @notice Largest single payment the vault will make, to anyone.
    uint256 public globalCap;
    /// @notice Largest single payment the vault will make to a given counterparty.
    mapping(bytes32 => uint256) public counterpartyCap;

    /// @notice Ref -> paid. One reference pays once, ever. This is the "retry paid it twice" guard.
    mapping(bytes32 => bool) public referenceUsed;
    mapping(bytes32 => uint256) public referenceAmount;

    event Paid(
        bytes32 indexed counterpartyId, address indexed account, address indexed by, uint256 amount, bytes32 ref
    );
    event PausedSet(bool paused);
    event GlobalCapSet(uint256 cap);
    event CounterpartyCapSet(bytes32 indexed counterpartyId, uint256 cap);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error ZeroAddress();
    error VaultPaused();
    error BadCap();
    error NotPayable(bytes32 counterpartyId);
    error OverGlobalCap(uint256 amount, uint256 cap);
    error OverCounterpartyCap(bytes32 counterpartyId, uint256 amount, uint256 cap);
    error DuplicateReference(bytes32 ref);
    error ZeroAmount();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address registry_, address usdc_, address owner_, uint256 globalCap_) {
        if (registry_ == address(0) || usdc_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        registry = CounterpartyRegistry(registry_);
        usdc = IERC20(usdc_);
        owner = owner_;
        globalCap = globalCap_;
    }

    // ---------------------------------------------------------------------
    // The only payment path
    // ---------------------------------------------------------------------

    /**
     * @notice Pay a counterparty. The destination is not a parameter.
     * @param counterpartyId who to pay
     * @param amount        how much, in USDC base units
     * @param ref           a unique reference for this payment; replaying it reverts
     * @return account the address the money actually went to, resolved from the registry
     */
    function pay(bytes32 counterpartyId, uint256 amount, bytes32 ref)
        external
        returns (address account)
    {
        if (paused) revert VaultPaused();
        if (amount == 0) revert ZeroAmount();
        if (referenceUsed[ref]) revert DuplicateReference(ref);

        if (!registry.isPayable(counterpartyId)) revert NotPayable(counterpartyId);

        account = registry.activeAccount(counterpartyId);
        if (account == address(0)) revert NotPayable(counterpartyId);

        if (amount > globalCap) revert OverGlobalCap(amount, globalCap);
        uint256 cc = counterpartyCap[counterpartyId];
        if (amount > cc) revert OverCounterpartyCap(counterpartyId, amount, cc);

        // Effects before interaction.
        referenceUsed[ref] = true;
        referenceAmount[ref] = amount;

        if (!usdc.transfer(account, amount)) revert TransferFailed();

        registry.recordPayment(counterpartyId, account, msg.sender, amount);

        emit Paid(counterpartyId, account, msg.sender, amount, ref);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    function deposit(uint256 amount) external {
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// @notice Owner emergency exit. Moves the balance out; cannot route a payment anywhere new.
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (!usdc.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    // ---------------------------------------------------------------------
    // Owner configuration. None of this can make a payment happen or redirect one.
    // ---------------------------------------------------------------------

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit PausedSet(p);
    }

    function setGlobalCap(uint256 cap) external onlyOwner {
        if (cap == 0) revert BadCap();
        globalCap = cap;
        emit GlobalCapSet(cap);
    }

    function setCounterpartyCap(bytes32 counterpartyId, uint256 cap) external onlyOwner {
        counterpartyCap[counterpartyId] = cap;
        emit CounterpartyCapSet(counterpartyId, cap);
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
