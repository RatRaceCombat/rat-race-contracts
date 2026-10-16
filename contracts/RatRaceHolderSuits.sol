// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @dev The staking contract (RatRaceHolds): who earned which suit of which month.
interface IRatRaceHoldsSuits {
    function suitEarned(address wallet, uint256 index, uint256 month, uint8 slot) external view returns (bool);
    function testMode() external view returns (bool);
}

/// @dev The permanent collection (RatRaceSuits).
interface IRatRaceSuitsVault {
    function editions(uint256 id) external view returns (uint64 cap, uint64 minted, uint64 reserved, bool vault);
    function testMode() external view returns (bool);
    function setCap(uint256 id, uint64 cap) external;
    function mint(address to, uint256 id, uint256 amount) external;
}

/**
 * @title RatRaceHolderSuits
 * @notice The Vault minter: the suits earned by staking RAT (RatRaceHolds), minted as Vault copies in the
 * permanent collection (RatRaceSuits), one of its minters. A Vault copy is an edition of its own,
 * VAULT_ID_BASE + the suit's id, apart from the edition sold (so "1 of N" stays true), and it cannot move
 * from wallet to wallet until the collection opens Vault transfers (once, announced 3 days ahead).
 *
 * Anybody may claim a copy for a staker (the staker usually does, from the game: no team keeper): it is
 * minted only when the staking contract says that stake earned that suit of that month, only to the
 * staker, and once. Nothing is lost by claiming late. The owner (the team Safe) only sets which suits a
 * staking month gives (its lineup), once per month, and only Vault editions; it can never mint, take or
 * move a copy, and the ownership can never be renounced.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here `claim` mints a Vault copy a stake earned, to its staker.
 */
contract RatRaceHolderSuits is Ownable2Step {
    /// @notice A Vault copy's id: VAULT_ID_BASE + the suit's id.
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: none.
    uint256 public constant VAULT_ID_BASE = 1_000_000;
    /// @notice The staking contract that says who earned which suit.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: none. Checks: its testMode() is the minter's.
    IRatRaceHoldsSuits public immutable holds;
    /// @notice The permanent collection the Vault copies are minted in.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: none. Checks: its testMode() is the minter's.
    IRatRaceSuitsVault public immutable suits;
    /// @notice A TEST minter: its staking contract and its collection are TEST ones (they must agree).
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: none. Checks: a TEST minter
    ///     never mints in the real collection, nor the reverse.
    bool public immutable testMode;

    mapping(uint256 => uint256[4]) private _lineup;
    /// @notice Whether a staking month's lineup is set (then it never changes).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    mapping(uint256 => bool) public lineupSet;
    /// @notice A copy already claimed: keccak256(wallet, stake index, month, slot).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    mapping(bytes32 => bool) public claimed;

    event LineupSet(uint256 indexed month, uint256[4] suits);
    event VaultClaimed(address indexed wallet, uint256 indexed index, uint256 indexed month, uint8 slot, uint256 id, address by);

    error ZeroAddress();
    error BadCollection();
    error AlreadySet();
    error NotVault();
    error NoLineup();
    error NotEarned();
    error AlreadyClaimed();
    error BadSlot();
    error LengthMismatch();
    error NoRenounce();

    constructor(address owner_, IRatRaceHoldsSuits holds_, IRatRaceSuitsVault suits_) Ownable(owner_) {
        if (address(holds_) == address(0) || address(suits_) == address(0)) revert ZeroAddress();
        bool test = holds_.testMode();
        if (suits_.testMode() != test) revert BadCollection();
        holds = holds_;
        suits = suits_;
        testMode = test;
    }

    /// @notice Which 4 suits staking month `month` gives (slot 0 to 3), as suit ids.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function lineupOf(uint256 month) external view returns (uint256[4] memory) {
        return _lineup[month];
    }

    /// @notice Set the 4 suits a staking month gives, once (it never changes after). Each must be a Vault
    ///     edition of the collection (marked before it existed); the first time, its cap opens here.
    /// @custom:security Who: the owner (the team Safe). Delay: none: before the month (months 1 to 4 at the
    ///     deploy), or after it started for a month forgotten, so that its stakers still get their suits. Limits: once per month,
    ///     Vault editions only; it mints nothing and never decides who earned a suit. Checks: public (LineupSet).
    function setLineup(uint256 month, uint256[4] calldata skinIds) external onlyOwner {
        if (lineupSet[month]) revert AlreadySet();
        for (uint256 i; i < 4; ++i) {
            uint256 id = VAULT_ID_BASE + skinIds[i];
            (uint64 cap,,, bool vault) = suits.editions(id);
            if (!vault) revert NotVault();
            if (cap == 0) suits.setCap(id, type(uint64).max);
        }
        _lineup[month] = skinIds;
        lineupSet[month] = true;
        emit LineupSet(month, skinIds);
    }

    /// @notice Whether this stake's suit of that month and slot can be claimed now.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function claimable(address wallet, uint256 index, uint256 month, uint8 slot) public view returns (bool) {
        return slot < 4 && lineupSet[month] && !claimed[_key(wallet, index, month, slot)] && holds.suitEarned(wallet, index, month, slot);
    }

    /// @notice Mint the Vault copy a stake earned (its month's suit in `slot`) to the staker.
    /// @custom:security Who: anyone (the staker from the game, usually). Delay: none: once the staking
    ///     contract says it is earned, any time after (nothing lapses). Limits: only to the staker, once per
    ///     stake, month and slot; only the month's lineup suit. Checks: public (VaultClaimed).
    function claim(address wallet, uint256 index, uint256 month, uint8 slot) public {
        if (slot >= 4) revert BadSlot();
        if (!lineupSet[month]) revert NoLineup();
        bytes32 key = _key(wallet, index, month, slot);
        if (claimed[key]) revert AlreadyClaimed();
        if (!holds.suitEarned(wallet, index, month, slot)) revert NotEarned();
        claimed[key] = true;
        uint256 id = VAULT_ID_BASE + _lineup[month][slot];
        suits.mint(wallet, id, 1);
        emit VaultClaimed(wallet, index, month, slot, id, msg.sender);
    }

    /// @notice Claim several earned copies of one stake at once (each as claim()).
    /// @custom:security Who: anyone. Delay: none. Limits: as claim(), each once, only to the staker.
    function claimMany(address wallet, uint256 index, uint256[] calldata months, uint8[] calldata slots) external {
        if (months.length != slots.length) revert LengthMismatch();
        for (uint256 i; i < months.length; ++i) claim(wallet, index, months[i], slots[i]);
    }

    /// @notice Disabled: without an owner, no later month could get its lineup.
    /// @custom:security Who: nobody: it always reverts.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    function _key(address wallet, uint256 index, uint256 month, uint8 slot) private pure returns (bytes32) {
        return keccak256(abi.encode(wallet, index, month, slot));
    }
}
