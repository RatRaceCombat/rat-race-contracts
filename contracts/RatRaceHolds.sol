// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RatRaceHolds
 * @notice RAT staked by the month for the Vault suits of Rat Race Combat.
 *
 * Staking months: periods of MONTH_SEC (30 days) shared by everyone from `opens`. Month n starts at
 * opens + (n - 1) * MONTH_SEC; before `opens` (or while it is not set) the current month is 0. The
 * admin (the Safe) sets `opens` once, at least OPENS_NOTICE (3 days) ahead, and it never moves.
 *
 * A stake: one per wallet at a time, MIN_STAKE (5,000 RAT) at least. It waits for the next month
 * (month 1 before the opening) and may be taken back whole while it waits. From its first month on it
 * is locked month by month and renews by itself. stake() again while it exists is a top-up of any
 * amount: it joins with the next month (waiting top-ups may be taken back alone, the stake running
 * on). Its owner may leave: the stake runs to the end of the current month and its RAT come back once
 * the next month has started, never in the middle of one (release(), sent by anybody, always to the
 * staker). Or leave now: its RAT come back at once, and it gives up the
 * current month's suits not due yet and a bonus block not over. Nothing due ever expires. A stake's record stays readable once it ends (a later stake of
 * the same wallet is a new record), so the Vault suits stay provable for past months.
 *
 * Suits: the RAT a stake has at a month's start earn 1 to 4 of that month's suits (TIERS: 5,000 /
 * 25,000 / 50,000 / 100,000 RAT), each on its day of the month for that count (one suit: day 30; two:
 * days 14 and 30; three: 14, 21 and 30; four: 7, 14, 21 and 30), kept for good. The lineup stays off
 * chain; the Vault suits contract reads `suitEarned`.
 *
 * The bonus: blocks of BONUS_MONTHS (3) months in a row from a stake's first month, each worth
 * BONUS_BPS (10%) of the RAT the stake has at the block's start (its target), paid to the staker once
 * the block is over, the stake's own RAT staying in. A block pays exactly what the pool reserved for it,
 * never more than its target. No keeper: a block is reserved during it, never
 * before: by anybody's reserveBonus (the game asks the staker from
 * the stake's first month), by the stake's top-up, or by the previous block's payBonus; each goes as far
 * as the pool allows then. A block nothing was reserved for pays nothing (an event says so, and
 * blockOf). Leaving before a block's last month gives its reservation back to the pool; leaving in its
 * last month still gets it.
 *
 * The pool: the RAT here beyond the stakes and the reserved bonuses (fund(), or plain transfers).
 * Nobody can take it out: it only pays stakers' bonuses. No sweep, no rescue, no admin withdrawal, no
 * pause, no upgrade. The admin can only set `opens` once (and hand its role on in two steps); nobody
 * can renounce it. RAT only ever go to the staker they belong to.
 *
 * Every rule is a deploy value (Params), never above the real ones (realParams()): a TEST deploy
 * (short months, amounts at 0.1%) says so for good with testMode().
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here release(staker) ends a stake that left, once its last month is over: its RAT (and a bonus owed) to the
 * staker; `leave` asks for it, `leaveNow` ends it at once (giving up what is not due yet), `takeBack` is for a
 * stake still waiting.
 * @custom:security Who: each staker for its own stake; anybody releases, pays or reserves a bonus, the
 * RAT always to the staker; the admin (the Safe) only sets `opens`, once. Delay: `opens` at least
 * OPENS_NOTICE (3 days for real) ahead; a stake's RAT back at the start of the month after it leaves, or at
 * once with leaveNow (what is not due yet given up).
 * Limits: no function moves the pool but a reserved bonus to its staker. Checks: fee-on-transfer
 * tokens refused, 18 decimals, every rule checked at deploy.
 */
contract RatRaceHolds is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The rules a deploy sets, in seconds and 18-decimal RAT (the real ones in brackets: realParams()).
    struct Params {
        uint64 monthSec; // (30 days) a staking month
        uint256[4] tiers; // (5,000 / 25,000 / 50,000 / 100,000 RAT) at a month's start for 1, 2, 3, 4 suits
        uint64[4][4] unlockByCount; // row c - 1: when each of a month's c suits comes, in seconds after the month's start (unused cells 0)
        uint16 bonusMonths; // (3) months in a bonus block
        uint16 bonusBps; // (1,000: 10%) of the RAT at the block's start
        uint64 opensNotice; // (3 days) the least notice of the opening
    }

    /// @notice `amount` RAT added to a stake, joining with month `from`.
    struct TopUp {
        uint128 amount;
        uint32 from;
    }

    struct Stake {
        uint128 base; // the RAT of the stake() that made it
        uint32 from; // its first month
        uint32 leaveAfter; // its last month, once its owner leaves (0: it renews)
        uint32 pendingBlock; // 1 + the block reserved and not paid yet (0: none); one at most
        bool ended; // released, or taken back while it waited (then leaveAfter stays 0)
        TopUp[] topUps; // oldest first, `from` never decreasing, MAX_TOP_UPS at most
        uint64 leftAt; // when it left at once (leaveNow): its last month's suits due after it are lost (0: never)
    }

    enum BonusState {
        Open, // reservable during the block (or owed once over, when reserved)
        Paid,
        GivenBack // the stake left before the block's end: its reservation went back to the pool
    }

    struct Bonus {
        uint128 reserved; // never above the block's target
        BonusState state;
    }

    /// @notice A bonus block as blockOf() reads it.
    enum BlockStatus {
        Running, // not over: its reservation can still be topped up (reserveBonus, from the stake's first month)
        Owed, // over, with RAT reserved: payBonus (or the release) pays them
        Paid,
        Lost, // the stake left before its last month (or was taken back): pays nothing
        Unreserved // over with nothing reserved: pays nothing
    }

    /// @notice A stake as stakeOf() reads it.
    struct StakeView {
        uint256 from; // its first month
        uint256 leaveAfter; // its last month (0: it renews)
        uint256 base;
        TopUp[] topUps;
        uint256 total; // what comes back when it ends, waiting top-ups included
        bool waiting; // before its first month: takeBack() gives it all back
        bool ended;
        bool takenBack; // ended while it waited: it never ran
        uint256 releaseAt; // when its RAT may come back (0 while it renews; the moment it left for leaveNow)
        uint256 leftAt; // when it left at once (leaveNow), 0 otherwise
    }

    /// @notice A bonus block as blockOf() reads it.
    struct BlockView {
        uint256 first; // its first month
        uint256 last; // its last month
        uint256 target; // BONUS_BPS of the RAT the stake has in `first`
        uint256 reserved; // what the pool reserved for it (never above `target`)
        uint256 pays; // what it pays or paid: `reserved`, 0 when Lost or Unreserved
        BlockStatus status;
        uint256 endsAt; // the start of the month after `last` (0 while `opens` is not set)
    }

    /// @notice Everything about the staking in one read (`status()`).
    struct Status {
        uint256 opens; // month 1's start (0: not set yet)
        uint256 currentMonth;
        uint256 monthStart; // the current month's start (0 before the opening)
        uint256 nextMonthStart; // (0 while `opens` is not set)
        uint256 totalStaked; // RAT in stakes, waiting ones and waiting top-ups included
        uint256 bonusReserved; // bonuses reserved and not paid yet
        uint256 pool; // free for new reservations
        uint256 activeStakes;
        address admin;
        address pendingAdmin;
        address rat;
        bool testMode;
        Params params;
    }

    /// @notice 100% in basis points.
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: none.
    uint256 public constant BPS = 10_000;
    /// @notice The most top-ups a stake keeps (top-ups joining with the same month count as one), so reads stay cheap.
    /// @custom:security Who: a constant. Delay: never changes. Limits: 24 per stake. Checks: stake() refuses the 25th.
    uint256 public constant MAX_TOP_UPS = 24;
    /// @notice `opens` is never set further ahead than this (a typo would close the staking for good).
    /// @custom:security Who: a constant. Delay: never changes. Limits: 365 days ahead at most. Checks: setOpens().
    uint256 public constant OPENS_MAX_AHEAD = 365 days;

    /// @notice RAT on HyperEVM, the only token staked and paid.
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: none. Checks: 18 decimals, never address 0.
    IERC20 public immutable rat;
    /// @notice A staking month, in seconds (30 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 second to 30 days. Checks: testMode when not 30 days.
    uint256 public immutable MONTH_SEC;
    /// @notice The least notice of the opening, in seconds (3 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 second to 3 days. Checks: testMode when not 3 days.
    uint256 public immutable OPENS_NOTICE;
    /// @notice Months in a bonus block (3 for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: over 0. Checks: testMode when not 3.
    uint256 public immutable BONUS_MONTHS;
    /// @notice A block's bonus, in basis points of the RAT at its start (1,000: 10% for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 to 10,000. Checks: testMode when not 1,000.
    uint256 public immutable BONUS_BPS;
    /// @notice The least RAT a new stake takes: the first tier (5,000 RAT for real); a top-up takes any amount.
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: over 0. Checks: testMode when not 5,000 RAT.
    uint256 public immutable MIN_STAKE;
    uint256 internal immutable _tier2; // (25,000 RAT)
    uint256 internal immutable _tier3; // (50,000 RAT)
    uint256 internal immutable _tier4; // (100,000 RAT)
    // the rows of unlockByCount, 4 x 64 bits each, slot 0 lowest
    uint256 internal immutable _row1;
    uint256 internal immutable _row2;
    uint256 internal immutable _row3;
    uint256 internal immutable _row4;

    /// @notice Month 1's start (unix seconds; 0: not set yet). Set once by the admin, never moved.
    /// @custom:security Who: the admin, once. Delay: at least OPENS_NOTICE (3 days for real) ahead. Limits: 365 days ahead
    /// at most. Checks: once only.
    uint64 public opens;
    /// @notice RAT in stakes not ended, waiting ones and waiting top-ups included.
    /// @custom:security Who: the stakes. Delay: none. Limits: never part of the pool. Checks: none.
    uint256 public totalStaked;
    /// @notice Bonuses reserved and not paid yet.
    /// @custom:security Who: the reservations. Delay: none. Limits: never part of the pool. Checks: none.
    uint256 public bonusReserved;
    /// @notice Stakes not ended.
    /// @custom:security Who: the stakes. Delay: none. Limits: none. Checks: none.
    uint256 public activeStakes;

    mapping(address => Stake[]) internal _stakes; // every stake of a wallet, oldest first; the last one may run
    mapping(address => mapping(uint256 => mapping(uint256 => Bonus))) internal _bonus; // wallet => stake => block

    event OpensSet(uint256 opens);
    event Staked(address indexed staker, uint256 indexed index, uint256 amount, uint256 from);
    event ToppedUp(address indexed staker, uint256 indexed index, uint256 amount, uint256 from);
    event TakenBack(address indexed staker, uint256 indexed index, uint256 amount);
    event TopUpsTakenBack(address indexed staker, uint256 indexed index, uint256 amount);
    event LeaveAsked(address indexed staker, uint256 indexed index, uint256 leaveAfter, uint256 releaseAt);
    event LeftNow(address indexed staker, uint256 indexed index, uint256 month, uint256 amount, uint256 bonus);
    event Released(address indexed staker, uint256 indexed index, uint256 amount, uint256 bonus, address by);
    event BonusReserved(address indexed staker, uint256 indexed index, uint256 blockIndex, uint256 added, uint256 reserved, uint256 target);
    event BonusShort(address indexed staker, uint256 indexed index, uint256 blockIndex, uint256 reserved, uint256 target);
    event BonusGivenBack(address indexed staker, uint256 indexed index, uint256 blockIndex, uint256 amount);
    event BonusPaid(address indexed staker, uint256 indexed index, uint256 blockIndex, uint256 amount, address by);
    event Funded(address indexed from, uint256 amount);

    error ZeroAddress();
    error BadToken();
    error BadParams();
    error NoRenounce();
    error OpensAlreadySet();
    error TooSoon();
    error TooFar();
    error ZeroAmount();
    error TooMuch();
    error BelowMinimum();
    error NotReceived();
    error TooManyTopUps();
    error NoStake();
    error UnknownStake();
    error NotWaiting();
    error NothingWaiting();
    error AlreadyLeaving();
    error NotDue();
    error NotReservable();
    error AlreadyReserved();
    error NothingToPay();

    constructor(IERC20 rat_, address admin_, Params memory p) Ownable(admin_) {
        if (address(rat_) == address(0)) revert ZeroAddress();
        if (IERC20Metadata(address(rat_)).decimals() != 18) revert BadToken(); // (the tiers are 18-decimal RAT)
        _checkParams(p);
        rat = rat_;
        MONTH_SEC = p.monthSec;
        OPENS_NOTICE = p.opensNotice;
        BONUS_MONTHS = p.bonusMonths;
        BONUS_BPS = p.bonusBps;
        MIN_STAKE = p.tiers[0];
        _tier2 = p.tiers[1];
        _tier3 = p.tiers[2];
        _tier4 = p.tiers[3];
        _row1 = _pack(p.unlockByCount[0]);
        _row2 = _pack(p.unlockByCount[1]);
        _row3 = _pack(p.unlockByCount[2]);
        _row4 = _pack(p.unlockByCount[3]);
    }

    // ------------------------------------------------------------------ the rules

    /// @notice The real rules: 30-day months, 5,000 / 25,000 / 50,000 / 100,000 RAT, the suits on days 30; 14, 30;
    /// 14, 21, 30; 7, 14, 21, 30; blocks of 3 months paying 10%; 3 days of notice.
    /// @custom:security Who: anyone (a pure view). Delay: none. Limits: none. Checks: compare it with params().
    function realParams() public pure returns (Params memory p) {
        p.monthSec = 30 days;
        p.tiers = [uint256(5_000e18), 25_000e18, 50_000e18, 100_000e18];
        p.unlockByCount = [
            [uint64(30 days), 0, 0, 0],
            [uint64(14 days), 30 days, 0, 0],
            [uint64(14 days), 21 days, 30 days, 0],
            [uint64(7 days), 14 days, 21 days, 30 days]
        ];
        p.bonusMonths = 3;
        p.bonusBps = 1_000;
        p.opensNotice = 3 days;
    }

    /// @notice The rules this deploy runs on.
    /// @custom:security Who: anyone (a view). Delay: fixed at deploy. Limits: none. Checks: testMode() when not realParams().
    function params() public view returns (Params memory p) {
        p.monthSec = uint64(MONTH_SEC);
        p.tiers = tiers();
        p.unlockByCount = unlockByCount();
        p.bonusMonths = uint16(BONUS_MONTHS);
        p.bonusBps = uint16(BONUS_BPS);
        p.opensNotice = uint64(OPENS_NOTICE);
    }

    /// @notice A TEST deploy: any rule differs from the real ones (realParams()), for good.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: changes nothing. Checks: true when params() is not realParams().
    function testMode() public view returns (bool) {
        return keccak256(abi.encode(params())) != keccak256(abi.encode(realParams()));
    }

    /// @notice The RAT (18 decimals) a stake needs at a month's start for 1, 2, 3, 4 of its suits (5,000 / 25,000 /
    /// 50,000 / 100,000 for real).
    /// @custom:security Who: anyone (a view). Delay: fixed at deploy. Limits: ascending. Checks: none.
    function tiers() public view returns (uint256[4] memory t) {
        t = [MIN_STAKE, _tier2, _tier3, _tier4];
    }

    /// @notice When a month's suits come, in seconds after its start: row c - 1 for a month that earns c suits,
    /// slot 1 first (unused cells 0).
    /// @custom:security Who: anyone (a view). Delay: fixed at deploy. Limits: each row ascending, within the month. Checks: none.
    function unlockByCount() public view returns (uint64[4][4] memory u) {
        for (uint256 c = 1; c <= 4; c++) u[c - 1] = _unpack(_rowOf(c));
    }

    /// @notice When the suit of `slot` (0 first) comes in a month that earns `count` suits, in seconds after the
    /// month's start (0 when the month earns no such suit).
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function unlockAfter(uint256 count, uint256 slot) public view returns (uint256) {
        if (count == 0 || count > 4 || slot >= count) return 0;
        return uint64(_rowOf(count) >> (64 * slot));
    }

    /// @notice How many of a month's suits `amount` RAT staked at its start earn (0 to 4).
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function suitCount(uint256 amount) public view returns (uint256 n) {
        uint256[4] memory t = tiers();
        for (uint256 i = 0; i < 4; i++) if (amount >= t[i]) n++;
    }

    // ------------------------------------------------------------------ the months

    /// @notice The staking month running now (1 for the first), 0 before the opening or while it is not set.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function currentMonth() public view returns (uint256) {
        uint256 o = opens;
        if (o == 0 || block.timestamp < o) return 0;
        return (block.timestamp - o) / MONTH_SEC + 1;
    }

    /// @notice When month `n` starts (it ends when n + 1 starts); 0 for month 0 or while `opens` is not set.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function monthStart(uint256 n) public view returns (uint256) {
        if (opens == 0 || n == 0) return 0;
        return uint256(opens) + (n - 1) * MONTH_SEC;
    }

    /// @notice Set month 1's start, once: at least OPENS_NOTICE (3 days for real) ahead, then it never moves.
    /// @custom:security Who: the admin (the Safe), once. Delay: `at` is OPENS_NOTICE (3 days for real) or more ahead.
    /// Limits: 365 days ahead at most; moves no RAT. Checks: once only, in public (OpensSet).
    function setOpens(uint64 at) external onlyOwner {
        if (opens != 0) revert OpensAlreadySet();
        if (at < block.timestamp + OPENS_NOTICE) revert TooSoon();
        if (at > block.timestamp + OPENS_MAX_AHEAD) revert TooFar();
        opens = at;
        emit OpensSet(at);
    }

    // ------------------------------------------------------------------ stakes

    /**
     * @notice Stake `amount` RAT of the caller (an allowance first). Without a running stake: a new stake of
     * MIN_STAKE (5,000 RAT for real) at least, starting with the next month (month 1 before the opening); it
     * reserves nothing while it waits. With one: a top-up of any amount that joins with the next month (on a
     * running stake it also pays a block owed and reserves the current one as far as the pool allows). A stake
     * whose owner left is ended first once its last month is over (its RAT and bonus back), then the new one starts.
     * @custom:security Who: the staker, for itself. Delay: the RAT join with the next month. Limits: one stake per
     * wallet; MAX_TOP_UPS (24) top-ups; none while leaving. Checks: every RAT must arrive (fee-on-transfer refused).
     */
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint96).max) revert TooMuch();
        Stake[] storage list = _stakes[msg.sender];
        uint256 m = currentMonth();
        uint256 out; // RAT due to the caller on the way
        uint256 n = list.length;
        bool topUp = n != 0 && !list[n - 1].ended;
        if (topUp && list[n - 1].leaveAfter != 0) {
            if (m <= list[n - 1].leaveAfter) revert AlreadyLeaving();
            out = _end(msg.sender, n - 1); // over, not released yet: it ends first
            topUp = false;
        }
        if (!topUp && amount < MIN_STAKE) revert BelowMinimum();
        // the RAT really arrive, all of them (a token taking a fee on transfer is refused)
        uint256 before = rat.balanceOf(address(this));
        rat.safeTransferFrom(msg.sender, address(this), amount);
        if (rat.balanceOf(address(this)) - before != amount) revert NotReceived();
        totalStaked += amount;
        uint256 idx;
        if (topUp) {
            idx = n - 1;
            _addTopUp(list[idx], amount, m + 1);
            emit ToppedUp(msg.sender, idx, amount, m + 1);
        } else {
            idx = list.length;
            Stake storage s = list.push();
            s.base = uint128(amount);
            s.from = uint32(m + 1);
            activeStakes += 1;
            emit Staked(msg.sender, idx, amount, m + 1);
        }
        out += _settle(msg.sender, idx, m, out);
        if (out != 0) rat.safeTransfer(msg.sender, out);
    }

    /// @notice Take the caller's stake back, all of it (top-ups included), while it still waits for its first month.
    /// @custom:security Who: the staker. Delay: none. Limits: only before its first month. Checks: a waiting stake holds
    /// no reservation: the pool is untouched.
    function takeBack() external nonReentrant {
        (Stake storage s, uint256 idx) = _active(msg.sender);
        if (currentMonth() >= s.from) revert NotWaiting();
        _takeBack(msg.sender, s, idx);
    }

    /// @notice Take back the caller's top-ups that have not joined yet (they would join with the next month); the
    /// stake runs on.
    /// @custom:security Who: the staker. Delay: none. Limits: only top-ups not joined yet. Checks: they never counted in a
    /// reservation (a block's target is the RAT at its start); a running stake's owed block is paid on the way.
    function takeBackWaitingTopUps() external nonReentrant {
        (Stake storage s, uint256 idx) = _active(msg.sender);
        uint256 m = currentMonth();
        uint256 amount;
        uint256 n = s.topUps.length;
        while (n != 0 && s.topUps[n - 1].from > m) {
            amount += s.topUps[n - 1].amount;
            s.topUps.pop();
            n--;
        }
        if (amount == 0) revert NothingWaiting();
        totalStaked -= amount;
        emit TopUpsTakenBack(msg.sender, idx, amount);
        uint256 paid = _settle(msg.sender, idx, m, amount);
        rat.safeTransfer(msg.sender, amount + paid);
    }

    /**
     * @notice Leave: the caller's stake runs to the end of the current month and stops there; its RAT come back
     * once the next month has started (release()). A stake that still waits is taken back at once instead. A
     * block that would end after this month gives its reservation back to the pool; one ending this month pays.
     * @custom:security Who: the staker. Delay: its RAT at the start of the next month, never mid-month. Limits: once.
     * Checks: none.
     */
    function leave() external nonReentrant {
        (Stake storage s, uint256 idx) = _active(msg.sender);
        uint256 m = currentMonth();
        if (m < s.from) {
            _takeBack(msg.sender, s, idx);
            return;
        }
        if (s.leaveAfter != 0) revert AlreadyLeaving();
        s.leaveAfter = uint32(m);
        if (s.pendingBlock != 0 && _lastOf(s, s.pendingBlock - 1) > m) _giveBack(msg.sender, idx, s);
        emit LeaveAsked(msg.sender, idx, m, monthStart(m + 1));
    }

    /**
     * @notice Leave now: the caller's stake ends in this call and all its RAT (waiting top-ups included) come back at
     * once, with a bonus block that is over and owed. What it gives up: the current month's suits whose day has not
     * come yet (those earned stay for good: suitEarned), and a bonus block not over (its reservation goes back to the
     * pool). A stake that still waits is taken back instead; one whose last month is over is simply ended (release).
     * (A stake may leave whenever its owner wants, warned of what it loses.)
     * @custom:security Who: the staker, for its own stake. Delay: none. Limits: its own RAT and an owed bonus only; the
     * pool never pays a block that is not over. Checks: reentrancy guard.
     */
    function leaveNow() external nonReentrant {
        (Stake storage s, uint256 idx) = _active(msg.sender);
        uint256 m = currentMonth();
        if (m < s.from) {
            _takeBack(msg.sender, s, idx);
            return;
        }
        uint256 pay;
        if (s.leaveAfter != 0 && m > s.leaveAfter) {
            pay = _end(msg.sender, idx); // it left before and its last month is over: a plain release
            rat.safeTransfer(msg.sender, pay);
            return;
        }
        uint256 bonus;
        if (s.pendingBlock != 0) {
            if (m > _lastOf(s, s.pendingBlock - 1)) bonus = _payBlock(msg.sender, idx, s.pendingBlock - 1);
            else _giveBack(msg.sender, idx, s);
        }
        s.leaveAfter = uint32(m);
        s.leftAt = uint64(block.timestamp);
        uint256 amount = _total(s);
        s.ended = true;
        activeStakes -= 1;
        totalStaked -= amount;
        emit LeftNow(msg.sender, idx, m, amount, bonus);
        rat.safeTransfer(msg.sender, amount + bonus);
    }

    /// @notice End `staker`'s stake once the month after its last one has started: all its RAT, and a bonus owed, go
    /// to the staker. Anybody may send it; nothing expires.
    /// @custom:security Who: anyone; the RAT always go to the staker. Delay: from the start of the month after the one
    /// it left in. Limits: once. Checks: reentrancy guard.
    function release(address staker) external nonReentrant {
        (Stake storage s, uint256 idx) = _active(staker);
        if (s.leaveAfter == 0 || currentMonth() <= s.leaveAfter) revert NotDue();
        uint256 pay = _end(staker, idx);
        rat.safeTransfer(staker, pay);
    }

    // ------------------------------------------------------------------ the bonus

    /// @notice Top the reservation of `staker`'s current block up toward its target, as far as the pool allows now; a
    /// block over and owed is paid on the way. Anybody may send it (the game asks the staker from its first month).
    /// @custom:security Who: anyone; a bonus paid on the way always goes to the staker. Delay: any time during the block,
    /// never while the stake waits. Limits: never above the target; not for a block the stake leaves before its end.
    /// Checks: reentrancy guard.
    function reserveBonus(address staker) external nonReentrant {
        (Stake storage s, uint256 idx) = _active(staker);
        uint256 m = currentMonth();
        (bool ok, uint256 k) = _reservable(s, m);
        if (!ok) revert NotReservable();
        if (_bonus[staker][idx][k].reserved >= _target(s, k)) revert AlreadyReserved();
        uint256 paid = _settle(staker, idx, m, 0);
        if (paid != 0) rat.safeTransfer(staker, paid);
    }

    /// @notice Pay `staker` the bonus of its block that is over, then reserve its current block as far as the pool
    /// allows (the staker's own claim keeps the chain going). Anybody may send it; nothing expires.
    /// @custom:security Who: anyone; the RAT always go to the staker. Delay: once the block's last month is over.
    /// Limits: what was reserved for the block, never more. Checks: reentrancy guard.
    function payBonus(address staker) external nonReentrant {
        (Stake storage s, uint256 idx) = _active(staker);
        uint256 m = currentMonth();
        if (s.pendingBlock == 0 || m <= _lastOf(s, s.pendingBlock - 1)) revert NothingToPay();
        uint256 paid = _settle(staker, idx, m, 0);
        rat.safeTransfer(staker, paid);
    }

    /// @notice Add RAT to the bonus pool with a public record (a plain transfer works too). Nobody can take it out:
    /// it only pays stakers' bonuses.
    /// @custom:security Who: anyone. Delay: none. Limits: none. Checks: records what really arrived.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 before = rat.balanceOf(address(this));
        rat.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, rat.balanceOf(address(this)) - before);
    }

    /// @notice The bonus pool: RAT here beyond the stakes and the reserved bonuses, free for new reservations.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: changes nothing. Checks: none.
    function pool() public view returns (uint256) {
        return _free(0);
    }

    // ------------------------------------------------------------------ reading

    /// @notice How many stakes `wallet` ever made (indexes 0 .. count - 1; only the last may still run).
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function stakeCount(address wallet) external view returns (uint256) {
        return _stakes[wallet].length;
    }

    /// @notice Whether `wallet` has a stake not ended, and its index.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function activeStakeOf(address wallet) external view returns (bool has, uint256 index) {
        uint256 n = _stakes[wallet].length;
        if (n != 0 && !_stakes[wallet][n - 1].ended) return (true, n - 1);
    }

    /// @notice Stake `index` of `wallet`, ended ones included.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: reverts for an unknown stake.
    function stakeOf(address wallet, uint256 index) external view returns (StakeView memory v) {
        Stake storage s = _get(wallet, index);
        v.from = s.from;
        v.leaveAfter = s.leaveAfter;
        v.base = s.base;
        v.topUps = s.topUps;
        v.total = _total(s);
        v.ended = s.ended;
        v.takenBack = s.ended && s.leaveAfter == 0;
        v.waiting = !s.ended && currentMonth() < s.from;
        v.releaseAt = s.leftAt != 0 ? s.leftAt : s.leaveAfter == 0 ? 0 : monthStart(uint256(s.leaveAfter) + 1);
        v.leftAt = s.leftAt;
    }

    /// @notice The RAT stake `index` of `wallet` has in month `month`: its base and every top-up joined by then
    /// (whether it ran that month: ranIn).
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: reverts for an unknown stake.
    function amountIn(address wallet, uint256 index, uint256 month) external view returns (uint256) {
        return _amountIn(_get(wallet, index), month);
    }

    /// @notice Whether stake `index` of `wallet` ran (or runs) in month `month`: from its first month to the current
    /// one, or its last one once it left; never for a stake taken back.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: false for an unknown stake.
    function ranIn(address wallet, uint256 index, uint256 month) public view returns (bool) {
        if (index >= _stakes[wallet].length) return false;
        return _ranIn(_stakes[wallet][index], month, currentMonth());
    }

    /// @notice How many of month `month`'s suits stake `index` of `wallet` has earned by now (slots 0 .. n - 1),
    /// kept for good.
    /// @custom:security Who: anyone (a view). Delay: each suit from its day of the month. Limits: 4 at most. Checks: 0
    /// for an unknown stake or a month it did not run.
    function suitsEarnedIn(address wallet, uint256 index, uint256 month) public view returns (uint256 n) {
        if (index >= _stakes[wallet].length) return 0;
        Stake storage s = _stakes[wallet][index];
        if (!_ranIn(s, month, currentMonth())) return 0;
        uint256 c = suitCount(_amountIn(s, month));
        if (c == 0) return 0;
        uint256 start = monthStart(month);
        uint256 row = _rowOf(c);
        // a stake that left at once (leaveNow) keeps its last month's suits due by then, never the later ones
        uint256 until = s.leftAt != 0 && month == s.leaveAfter ? s.leftAt : block.timestamp;
        while (n < c && until >= start + uint64(row >> (64 * n))) n++;
    }

    /// @notice Whether stake `index` of `wallet` has earned the suit of `slot` (0 first) of month `month`: it ran
    /// that month, its RAT at the month's start reach TIERS[slot], and that suit's day of the month (for the
    /// count its RAT earn) has come. Kept for good, after the stake ended too.
    /// @custom:security Who: anyone (a view; the Vault suits contract). Delay: the suit's day of the month. Limits: slots
    /// 0 to 3. Checks: false for an unknown stake, a month it did not run, or a slot its RAT do not reach.
    function suitEarned(address wallet, uint256 index, uint256 month, uint8 slot) external view returns (bool) {
        return slot < suitsEarnedIn(wallet, index, month);
    }

    /// @notice Bonus block `k` (0 first) of stake `index` of `wallet`: its months, target, reservation and status.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: reverts for an unknown stake.
    function blockOf(address wallet, uint256 index, uint256 k) public view returns (BlockView memory v) {
        Stake storage s = _get(wallet, index);
        Bonus storage b = _bonus[wallet][index][k];
        v.first = _firstOf(s, k);
        v.last = _lastOf(s, k);
        v.target = _target(s, k);
        v.reserved = b.reserved;
        v.endsAt = monthStart(v.last + 1);
        if (b.state == BonusState.Paid) v.status = BlockStatus.Paid;
        else if (b.state == BonusState.GivenBack || (s.leaveAfter != 0 && s.leaveAfter < v.last) || (s.ended && s.leaveAfter == 0)
            || (s.leftAt != 0 && s.leaveAfter <= v.last)) v.status = BlockStatus.Lost; // (leaveNow: a block not over is lost)
        else if (currentMonth() > v.last) v.status = v.reserved != 0 ? BlockStatus.Owed : BlockStatus.Unreserved;
        else v.status = BlockStatus.Running;
        v.pays = v.status == BlockStatus.Lost || v.status == BlockStatus.Unreserved ? 0 : v.reserved;
    }

    /// @notice Every bonus block of stake `index` of `wallet` so far: from its first to the current one (its first
    /// while it waits), up to its last month once it left; none for a stake taken back.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: one per BONUS_MONTHS (3) months run. Checks: reverts
    /// for an unknown stake.
    function blocksOf(address wallet, uint256 index) external view returns (BlockView[] memory out) {
        Stake storage s = _get(wallet, index);
        if (s.ended && s.leaveAfter == 0) return out;
        uint256 m = currentMonth();
        uint256 upTo = m < s.from ? s.from : m;
        if (s.leaveAfter != 0 && s.leaveAfter < upTo) upTo = s.leaveAfter;
        out = new BlockView[]((upTo - s.from) / BONUS_MONTHS + 1);
        for (uint256 k = 0; k < out.length; k++) out[k] = blockOf(wallet, index, k);
    }

    /// @notice Everything about the staking in one read.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: changes nothing. Checks: none.
    function status() external view returns (Status memory st) {
        uint256 m = currentMonth();
        st.opens = opens;
        st.currentMonth = m;
        st.monthStart = monthStart(m);
        st.nextMonthStart = monthStart(m + 1);
        st.totalStaked = totalStaked;
        st.bonusReserved = bonusReserved;
        st.pool = pool();
        st.activeStakes = activeStakes;
        st.admin = owner();
        st.pendingAdmin = pendingOwner();
        st.rat = address(rat);
        st.testMode = testMode();
        st.params = params();
    }

    /// @notice Disabled: without an admin nobody could ever set the opening.
    /// @custom:security Who: nobody: it always reverts. Delay: none. Limits: none. Checks: none.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    // ------------------------------------------------------------------ internals

    /// @dev Pay the block over and owed, then top the current block's reservation up (nothing while the stake waits).
    /// `out`: RAT already counted out of the stakes and bonuses but still here. Returns the bonus paid.
    function _settle(address staker, uint256 idx, uint256 m, uint256 out) internal returns (uint256 paid) {
        Stake storage s = _stakes[staker][idx];
        if (s.pendingBlock != 0 && m > _lastOf(s, s.pendingBlock - 1)) paid = _payBlock(staker, idx, s.pendingBlock - 1);
        (bool ok, uint256 k) = _reservable(s, m);
        if (ok) _sync(staker, idx, s, k, out + paid);
    }

    /// @dev Move the current block k's reservation up toward its target, as far as the pool allows. Its target never
    /// moves during it (top-ups join it only at its start), and every other reserved block was paid before (_settle).
    function _sync(address staker, uint256 idx, Stake storage s, uint256 k, uint256 out) internal {
        Bonus storage b = _bonus[staker][idx][k];
        uint256 target = _target(s, k);
        uint256 r = b.reserved;
        if (r >= target) return;
        uint256 add = target - r;
        uint256 free = _free(out);
        if (add > free) add = free;
        if (add != 0) {
            b.reserved = uint128(r + add);
            bonusReserved += add;
            s.pendingBlock = uint32(k + 1);
            emit BonusReserved(staker, idx, k, add, r + add, target);
        }
        if (r + add < target) emit BonusShort(staker, idx, k, r + add, target);
    }

    /// @dev The block whose reservation can move now: the current one, never while the stake waits, nor when the stake leaves before its last month (or ended).
    function _reservable(Stake storage s, uint256 m) internal view returns (bool, uint256) {
        if (s.ended || m < s.from) return (false, 0);
        uint256 k = (m - s.from) / BONUS_MONTHS;
        if (s.leaveAfter != 0 && s.leaveAfter < _lastOf(s, k)) return (false, k);
        return (true, k);
    }

    /// @dev Mark block k paid and count it out of the reservations (the caller sends the RAT). Returns its amount.
    function _payBlock(address staker, uint256 idx, uint256 k) internal returns (uint256 amount) {
        Bonus storage b = _bonus[staker][idx][k];
        amount = b.reserved;
        b.state = BonusState.Paid;
        bonusReserved -= amount;
        _stakes[staker][idx].pendingBlock = 0;
        emit BonusPaid(staker, idx, k, amount, msg.sender);
    }

    /// @dev The reserved block goes back to the pool (the stake leaves before its end, or is taken back).
    function _giveBack(address staker, uint256 idx, Stake storage s) internal {
        uint256 k = s.pendingBlock - 1;
        Bonus storage b = _bonus[staker][idx][k];
        bonusReserved -= b.reserved;
        b.state = BonusState.GivenBack;
        s.pendingBlock = 0;
        emit BonusGivenBack(staker, idx, k, b.reserved);
    }

    /// @dev A waiting stake comes back whole (it holds no reservation: _reservable).
    function _takeBack(address staker, Stake storage s, uint256 idx) internal {
        uint256 amount = _total(s);
        s.ended = true;
        activeStakes -= 1;
        totalStaked -= amount;
        emit TakenBack(staker, idx, amount);
        rat.safeTransfer(staker, amount);
    }

    /// @dev End a stake whose last month is over: counts out its RAT and its owed bonus (the caller sends them).
    function _end(address staker, uint256 idx) internal returns (uint256) {
        Stake storage s = _stakes[staker][idx];
        uint256 bonus = s.pendingBlock != 0 ? _payBlock(staker, idx, s.pendingBlock - 1) : 0;
        uint256 amount = _total(s);
        s.ended = true;
        activeStakes -= 1;
        totalStaked -= amount;
        emit Released(staker, idx, amount, bonus, msg.sender);
        return amount + bonus;
    }

    function _addTopUp(Stake storage s, uint256 amount, uint256 from) internal {
        uint256 n = s.topUps.length;
        if (n != 0 && s.topUps[n - 1].from == from) {
            s.topUps[n - 1].amount += uint128(amount);
        } else {
            if (n >= MAX_TOP_UPS) revert TooManyTopUps();
            s.topUps.push(TopUp({amount: uint128(amount), from: uint32(from)}));
        }
    }

    function _active(address staker) internal view returns (Stake storage s, uint256 idx) {
        uint256 n = _stakes[staker].length;
        if (n == 0 || _stakes[staker][n - 1].ended) revert NoStake();
        idx = n - 1;
        s = _stakes[staker][idx];
    }

    function _get(address wallet, uint256 index) internal view returns (Stake storage) {
        if (index >= _stakes[wallet].length) revert UnknownStake();
        return _stakes[wallet][index];
    }

    function _ranIn(Stake storage s, uint256 month, uint256 m) internal view returns (bool) {
        if (s.ended && s.leaveAfter == 0) return false; // taken back while it waited: it never ran
        if (month < s.from || month > m) return false;
        return s.leaveAfter == 0 || month <= s.leaveAfter;
    }

    function _amountIn(Stake storage s, uint256 month) internal view returns (uint256 a) {
        a = s.base;
        uint256 n = s.topUps.length;
        for (uint256 i = 0; i < n; i++) if (s.topUps[i].from <= month) a += s.topUps[i].amount;
    }

    function _total(Stake storage s) internal view returns (uint256 a) {
        a = s.base;
        uint256 n = s.topUps.length;
        for (uint256 i = 0; i < n; i++) a += s.topUps[i].amount;
    }

    function _firstOf(Stake storage s, uint256 k) internal view returns (uint256) {
        return uint256(s.from) + k * BONUS_MONTHS;
    }

    function _lastOf(Stake storage s, uint256 k) internal view returns (uint256) {
        return uint256(s.from) + (k + 1) * BONUS_MONTHS - 1;
    }

    function _target(Stake storage s, uint256 k) internal view returns (uint256) {
        return (_amountIn(s, _firstOf(s, k)) * BONUS_BPS) / BPS;
    }

    /// @dev The RAT here beyond the stakes, the reservations and `out` (counted out, still here).
    function _free(uint256 out) internal view returns (uint256) {
        uint256 bal = rat.balanceOf(address(this));
        uint256 held = totalStaked + bonusReserved + out;
        return bal > held ? bal - held : 0;
    }

    function _rowOf(uint256 c) internal view returns (uint256) {
        return c == 1 ? _row1 : c == 2 ? _row2 : c == 3 ? _row3 : _row4;
    }

    function _pack(uint64[4] memory r) internal pure returns (uint256) {
        return uint256(r[0]) | (uint256(r[1]) << 64) | (uint256(r[2]) << 128) | (uint256(r[3]) << 192);
    }

    function _unpack(uint256 w) internal pure returns (uint64[4] memory) {
        return [uint64(w), uint64(w >> 64), uint64(w >> 128), uint64(w >> 192)];
    }

    /// @dev Every rule over 0 and never above the real ones where it is a delay: months of 30 days at most, a notice of
    /// 3 days at most; the tiers ascending; each row of unlockByCount ascending within the month, unused cells 0.
    function _checkParams(Params memory p) internal pure {
        if (p.monthSec == 0 || p.monthSec > 30 days) revert BadParams();
        if (p.opensNotice == 0 || p.opensNotice > 3 days) revert BadParams();
        if (p.bonusMonths == 0 || p.bonusBps == 0 || p.bonusBps > BPS) revert BadParams();
        for (uint256 i = 0; i < 4; i++) {
            if (p.tiers[i] == 0 || p.tiers[i] > type(uint96).max || (i > 0 && p.tiers[i] <= p.tiers[i - 1])) revert BadParams();
            for (uint256 j = 0; j < 4; j++) {
                uint64 d = p.unlockByCount[i][j];
                if (j > i) {
                    if (d != 0) revert BadParams();
                } else if (d == 0 || d > p.monthSec || (j > 0 && d <= p.unlockByCount[i][j - 1])) {
                    revert BadParams();
                }
            }
        }
    }
}
