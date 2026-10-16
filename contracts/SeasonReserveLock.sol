// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SeasonReserveLock
 * @notice The RAT kept for the seasons after the first, locked until
 * the next season. They can only ever go to the distributor (RatRaceDistributor), fixed at
 * deploy: `release()`, sent by anybody, moves everything this contract holds there, once either is true:
 *   - the countdown is over: `COUNTDOWN` (182 days, season 1) after the admin started it (`init()`,
 *     the admin Safe, at the launch of season 1; once);
 *   - `BACKSTOP` (365 days) after the deploy, whatever happened (even without init): the RAT never stay
 *     locked for good.
 * Once open it stays open (RAT sent later go the same way). No other way out: no function moves RAT
 * anywhere else, no sweep, no rescue, no upgrade. The admin can only start the countdown (and hand its
 * role to another wallet in two steps); nobody can renounce it. (The early
 * "distributor ran dry" path and its keeper are gone.)
 *
 * The two durations are set at deploy and never change: the real values are 182 days and 365 days; any duration over 0,
 * the backstop never before the countdown; shorter ones make `testMode()` true.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here release() sends the RAT to the distributor once due, and init() starts the countdown.
 * @custom:security Who: anybody releases, the RAT always go to the distributor; the admin (the admin Safe) only
 * starts the countdown, once. Delay: COUNTDOWN (182 days for real) after init, or BACKSTOP (365 days for real)
 * after the deploy. Limits: every RAT only to the distributor. Checks: the distributor pays this RAT and is of the
 * same kind (a real lock pays the real one, a TEST lock a TEST one).
 */
contract SeasonReserveLock is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice How long after init() the lock opens (182 days for real: season 1).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 182 days. Checks: testMode when shorter.
    uint64 public immutable COUNTDOWN;
    /// @notice How long after the deploy the lock opens whatever happened, even without init (365 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 365 days, never before COUNTDOWN. Checks: testMode when shorter.
    uint64 public immutable BACKSTOP;

    /// @notice RAT on HyperEVM, the token this lock holds.
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: none. Checks: the distributor's rat().
    IERC20 public immutable rat;
    /// @notice The only place the RAT can go: the withdrawal contract (RatRaceDistributor).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: the only destination. Checks: its rat() and testMode() at deploy.
    address public immutable distributor;
    /// @notice When this lock was deployed (the backstop counts from it).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: none. Checks: none.
    uint64 public immutable deployedAt;

    /// @notice init(): the countdown's start (0: not started).
    /// @custom:security Who: the admin, once. Delay: none. Limits: never moves the RAT. Checks: once only.
    uint64 public startedAt;
    /// @notice Once true, release() sends whatever this holds.
    /// @custom:security Who: release() sets it. Delay: none. Limits: never goes back. Checks: none.
    bool public opened;

    struct Status {
        uint256 balance; // RAT locked here
        uint64 startedAt;
        uint64 unlockAt; // startedAt + COUNTDOWN (0: not started)
        uint64 backstopAt; // deployedAt + BACKSTOP
        bool openNow; // release() would send now
        bool opened;
        address admin;
        address pendingAdmin;
        address distributor;
        address rat;
        uint64 countdown; // the settings, fixed at deploy
        uint64 backstop;
        bool testMode; // a setting under the real one: a TEST lock
    }

    event Started(uint64 at, uint64 unlockAt);
    event Released(uint256 amount, uint8 reason); // 1 countdown, 3 backstop, 4 already open

    error ZeroAddress();
    error BadDistributor();
    error AlreadyStarted();
    error NotOpen();
    error NothingToRelease();
    error NoRenounce();
    error BadSettings();

    constructor(IERC20 rat_, address distributor_, address admin_, uint64 countdown_, uint64 backstop_) Ownable(admin_) {
        if (address(rat_) == address(0) || distributor_ == address(0)) revert ZeroAddress();
        if (countdown_ == 0 || backstop_ < countdown_) revert BadSettings();
        // never above the real lock (a deploy may only shorten it, for a TEST: testMode)
        if (countdown_ > 182 days || backstop_ > 365 days) revert BadSettings();
        COUNTDOWN = countdown_;
        BACKSTOP = backstop_;
        // the distributor of this RAT, or the RAT would land where nothing pays it out
        (bool ok, bytes memory r) = distributor_.staticcall(abi.encodeWithSignature("rat()"));
        if (!ok || r.length != 32 || abi.decode(r, (address)) != address(rat_)) revert BadDistributor();
        // ...of the same kind: a real lock only ever pays a real distributor, a TEST lock a TEST one
        (ok, r) = distributor_.staticcall(abi.encodeWithSignature("testMode()"));
        bool test = countdown_ < 182 days || backstop_ < 365 days;
        if (!ok || r.length != 32 || abi.decode(r, (bool)) != test) revert BadDistributor();
        rat = rat_;
        distributor = distributor_;
        deployedAt = uint64(block.timestamp);
    }

    /// @notice Start the countdown (the admin, once, at the launch of season 1).
    /// @custom:security Who: the admin (the admin Safe), once. Delay: it starts COUNTDOWN (182 days for real). Limits:
    /// it never moves the RAT. Checks: once only.
    function init() external onlyOwner {
        if (startedAt != 0) revert AlreadyStarted();
        startedAt = uint64(block.timestamp);
        emit Started(startedAt, startedAt + COUNTDOWN);
    }

    /// @dev Why it may open now (0: it may not).
    function _reason() internal view returns (uint8) {
        if (opened) return 4;
        if (startedAt != 0 && block.timestamp >= uint256(startedAt) + COUNTDOWN) return 1;
        if (block.timestamp >= uint256(deployedAt) + BACKSTOP) return 3;
        return 0;
    }

    /// @notice Send everything this holds to the distributor (anybody), once it may open.
    /// @custom:security Who: anyone. Delay: once COUNTDOWN (182 days for real) after init is over, or BACKSTOP (365
    /// days for real) after the deploy whatever happens. Limits: every RAT goes to the distributor, nowhere else,
    /// ever. Checks: reentrancy guard.
    function release() external nonReentrant {
        uint8 why = _reason();
        if (why == 0) revert NotOpen();
        uint256 amount = rat.balanceOf(address(this));
        if (amount == 0) revert NothingToRelease();
        opened = true;
        emit Released(amount, why);
        rat.safeTransfer(distributor, amount);
    }

    /// @notice Everything in one read (for the explorer and the economy page).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function status() external view returns (Status memory s) {
        s.balance = rat.balanceOf(address(this));
        s.startedAt = startedAt;
        s.unlockAt = startedAt == 0 ? 0 : startedAt + COUNTDOWN;
        s.backstopAt = deployedAt + BACKSTOP;
        s.openNow = _reason() != 0;
        s.opened = opened;
        s.admin = owner();
        s.pendingAdmin = pendingOwner();
        s.distributor = distributor;
        s.rat = address(rat);
        s.countdown = COUNTDOWN;
        s.backstop = BACKSTOP;
        s.testMode = testMode();
    }

    /// @notice A TEST lock: a setting under the real one (182 days, 365 days), for good.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: true when a setting is
    /// under the real one (182 days, 365 days).
    function testMode() public view returns (bool) {
        return COUNTDOWN < 182 days || BACKSTOP < 365 days;
    }

    /// @notice Disabled: without an admin nobody could start the countdown (the backstop still opens it).
    /// @custom:security Who: nobody: it always reverts (without an admin nobody could start the countdown; the
    /// backstop still opens it). Delay: none. Limits: none. Checks: none.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }
}
