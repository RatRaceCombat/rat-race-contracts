// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title FoundersVesting
 * @notice A founder's vesting: OpenZeppelin's VestingWallet, as is for the schedule and the payouts
 * (nothing before the start, then linear; anyone may call release(token) and the RAT go to the
 * beneficiary). No admin: nobody but the beneficiary has any power over it. Two changes from
 * VestingWallet, from the security review of 2026-10-13: the beneficiary cannot renounce (that would pay address 0), and hands
 * the vesting to another wallet only in two steps (the new wallet accepts: a typo never loses it).
 * No revoke, no upgrade, no other way out for the RAT than to the beneficiary. A lost beneficiary key
 * loses its RAT: the beneficiary should be a Safe or a hardware wallet with its seed kept safe.
 *
 * The schedule: REAL_DURATION (365 days, 12 months) from the start. The deploy may fix the start (never backdated by more than MAX_BACKDATE: a start in the past would hand out at
 * once what must vest over months), or leave it to the beneficiary (start 0): the RAT are then locked from the
 * deploy and nothing vests until the beneficiary calls begin() once, at the launch, at least MIN_NOTICE (30 days)
 * ahead so every holder sees the date a month before, and nobody else can start it.
 * Another duration makes `testMode()` true for good.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here release(token) (OpenZeppelin's VestingWallet) sends the vested RAT to the beneficiary.
 * @custom:security Who: anyone calls release (the RAT always go to the beneficiary); only the beneficiary
 * offers its role (two steps) and, when the deploy left it, sets the start once (begin). Delay: nothing before
 * start() (the launch: set at deploy, never backdated by over a day, or by the beneficiary's begin, at least
 * MIN_NOTICE ahead), then linear over REAL_DURATION (365 days). Limits: no admin, no revoke, no upgrade. Checks: testMode()
 * when the duration is not the founders'.
 */
contract FoundersVesting is VestingWallet, Ownable2Step {
    /// @notice 365 days (12 months): the founders' RAT vest linearly from start(), the launch.
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: none. Checks: testMode when the duration differs.
    uint64 public constant REAL_DURATION = 31536000;
    /// @notice begin() sets the start this far ahead at least (30 days): every holder sees it a month before (none in TEST).
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: none. Checks: none.
    uint64 public constant MIN_NOTICE = 30 days;
    /// @notice The real schedule starts no earlier than one day before its deploy (a deploy's clock slack, never more).
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: 1 day. Checks: the constructor refuses an older start.
    uint64 public constant MAX_BACKDATE = 1 days;

    /// @notice When the beneficiary started the schedule (begin), if the deploy left the start to it (0: not started:
    /// nothing vests yet).
    /// @custom:security Who: set once by begin(). Delay: none. Limits: MIN_NOTICE ahead at least, never changed. Checks: public event.
    uint64 public begunAt;

    event Begun(uint64 at);

    error NoRenounce();
    error BackdatedStart();
    error StartFixed();
    error AlreadyBegun();
    error StartTooSoon();

    /// @notice The founders' schedule (REAL_DURATION) from `startTimestamp`, never backdated by more than MAX_BACKDATE;
    /// 0: the beneficiary sets the start later (begin), the RAT locked meanwhile.
    constructor(address beneficiary, uint64 startTimestamp, uint64 durationSeconds) VestingWallet(beneficiary, startTimestamp, durationSeconds) {
        if (startTimestamp != 0 && durationSeconds == REAL_DURATION && uint256(startTimestamp) + MAX_BACKDATE < block.timestamp) revert BackdatedStart();
    }

    /// @notice The start the deploy gave (0: the beneficiary sets it with begin).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function startAtDeploy() public view returns (uint256) {
        return super.start();
    }

    /// @notice When the schedule starts: the deploy's start, or the beneficiary's begin; before either, a time that
    /// never comes (type(uint64).max), so nothing vests.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function start() public view override returns (uint256) {
        uint256 fixedStart = super.start();
        if (fixedStart != 0) return fixedStart;
        return begunAt == 0 ? type(uint64).max : begunAt;
    }

    /// @notice Start the schedule (the launch), once: `at` (unix seconds), MIN_NOTICE (30 days) from now at the earliest;
    /// 0: the earliest. A TEST vesting has no notice.
    /// @custom:security Who: the beneficiary only (onlyOwner: nobody can start it in its place). Delay: the start comes
    /// MIN_NOTICE after the call at the earliest, in public. Limits: once, only when the deploy left the start
    /// (startAtDeploy() 0). Checks: public event.
    function begin(uint64 at) external onlyOwner {
        if (super.start() != 0) revert StartFixed();
        if (begunAt != 0) revert AlreadyBegun();
        uint256 earliest = block.timestamp + (duration() == REAL_DURATION ? MIN_NOTICE : 0);
        if (at == 0) at = uint64(earliest);
        else if (at < earliest) revert StartTooSoon();
        begunAt = at;
        emit Begun(at);
    }

    /// @notice A TEST deployment: another duration than the founders' (fixed at deploy, for good).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: true when the
    /// duration is not the founders' REAL_DURATION.
    function testMode() external view returns (bool) {
        return duration() != REAL_DURATION;
    }

    /// @notice The beneficiary offers the vesting to another wallet, which must accept (acceptOwnership).
    /// @custom:security Who: the beneficiary only. Delay: none; the new wallet accepts. Limits: the schedule and the RAT
    /// never change, only who receives. Checks: two steps, so a typo never loses the vesting.
    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    /// @dev Ownable2Step's: a transfer clears any pending offer.
    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }

    /// @notice Disabled: renouncing would send the RAT to address 0.
    /// @custom:security Who: nobody: it always reverts (renouncing would send the RAT to address 0). Delay: none.
    /// Limits: none. Checks: none.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }
}
