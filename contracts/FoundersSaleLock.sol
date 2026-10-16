// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FoundersSaleLock
 * @notice The founders' 400,000 RAT for public sale. They wait here and only ever go to the founders' ladder account, the account that sells them
 * as public post-only orders on HyperCore, and only as the market reaches them. One rule: the grid has 695
 * levels, the first at $0.025, each 0.5% above the last (up to about $0.80); 67% of the RAT spread evenly over the
 * levels and 33% in proportion to their prices: about 407 RAT on the first level, about 1,064 on the last, about
 * $114,000 if every level sells;
 * a level opens
 * once HyperCore's best bid for RAT is within 10% under it, at most 2,000 RAT an hour (RATE_CAP, refilled
 * evenly over RATE_WINDOW) and 10,000 RAT a UTC day (DAY_CAP; so up to about 20,000 in the 24 hours around a
 * UTC midnight). A spike of one block opens 2,000 RAT at most.
 * The price is HyperCore's own book, read through its precompile: no team oracle, no price kept by anyone.
 * (It replaces a two-tier version with a 30-minute held price.)
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here release() sends the open levels' RAT to the ladder account; a new ladder is proposeLadder, then
 * applyLadder after CHANGE_DELAY, a recovery proposeRecovery, then executeRecovery after RECOVERY_DELAY.
 * Every level can be read: levels(from, count) gives each one's price, size, what was released of it and whether
 * the bid now opens it.
 * @custom:security Who: anybody releases, the RAT always go to `ladder`; the admin (the team Safe) can move
 * `ladder` or hand the admin role on, each only CHANGE_DELAY (3 days for real) after a public announcement, and
 * announce an emergency recovery of what the lock holds back to itself, only RECOVERY_DELAY (30 days for real)
 * after a public announcement; each then within EXECUTION_WINDOW (7 days for real) or it lapses. Delay: none (a level opens on the bid now). Limits: the grid, RATE_CAP (2,000 RAT an
 * hour for real) and DAY_CAP (10,000 RAT a UTC day for real); no other way out for the RAT, no upgrade, the admin can
 * never be renounced. Checks: `testMode()` is true when any value differs from the real ones (the grid, the
 * time rules, the RAT token, HyperCore's asset and its price decimals): the production lock is the one whose
 * `testMode()` is false.
 */
contract FoundersSaleLock is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice HyperCore's best-bid-offer precompile: abi.encode(uint32 asset) -> (uint64 bid, uint64 ask).
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: none.
    address public constant BBO_PRECOMPILE = 0x000000000000000000000000000000000000080e;
    /// @notice The real RAT on HyperEVM, HyperCore's RAT/USDC spot asset (10000 + 157) and its price decimals (8 - 2).
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: testMode() when the lock holds another token.
    address public constant REAL_RAT = 0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA;
    uint32 public constant REAL_CORE_ASSET = 10157;
    uint8 public constant REAL_CORE_PX_DECIMALS = 6;

    /// @notice The grid and its time rules, set at deploy; the production lock has exactly `realGrid()`.
    struct Grid {
        uint64 floorUsd8; // the first level's price, USD with 8 decimals (2,500,000 = $0.025)
        uint16 stepBps; // each level this much above the last (50 = 0.5%)
        uint16 levels; // how many levels (695: $0.025 to about $0.80)
        uint16 windowBps; // a level opens once the bid is within this under it (1,000 = 10%)
        uint256 total; // RAT for sale (400,000)
        uint256 dayCap; // RAT released in a UTC day at most (10,000)
        uint64 changeDelay; // a new ladder account or admin waits this long in public (3 days)
        uint64 recoveryDelay; // an emergency recovery waits this long in public (30 days)
        uint64 executionWindow; // then applies within this, or lapses (7 days)
        uint256 rateCap; // RAT released per rateWindow at most (2,000)
        uint64 rateWindow; // the rate cap refills evenly over this (1 hour)
    }

    /// @notice The real grid: the production lock has exactly this one (testMode() false).
    /// @custom:security Who: anyone (a pure view). Delay: none. Limits: none. Checks: compare it with the live values.
    function realGrid() public pure returns (Grid memory) {
        return Grid(2_500_000, 50, 695, 1000, 400_000e18, 10_000e18, 3 days, 30 days, 7 days, 2_000e18, 1 hours);
    }

    /// @notice RAT on HyperEVM, the token this lock holds.
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: the only token released. Checks: testMode when not REAL_RAT.
    IERC20 public immutable rat;
    /// @notice HyperCore's spot asset read for the price: 10000 + the RAT/USDC pair's index (10157 for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: none. Checks: testMode when not REAL_CORE_ASSET.
    uint32 public immutable coreAsset;
    /// @notice Decimals of HyperCore spot prices for that pair (8 - RAT's size decimals: 6 for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 8. Checks: testMode when not REAL_CORE_PX_DECIMALS.
    uint8 public immutable corePxDecimals;
    /// @notice The first level's price in USD with 8 decimals (2,500,000 = $0.025 for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: the grid starts here. Checks: testMode when not the real one.
    uint64 public immutable FLOOR_USD8;
    /// @notice Each level is this much above the last, in basis points (50 = 0.5% for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 to 1,000. Checks: testMode when not the real one.
    uint16 public immutable STEP_BPS;
    /// @notice How many levels the grid has (695 for real: $0.025 to about $0.80).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 to 1,000. Checks: testMode when not the real one.
    uint16 public immutable LEVELS;
    /// @notice A level opens once the bid is within this much under it, in basis points (1,000 = 10% for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 5,000. Checks: testMode when not the real one.
    uint16 public immutable WINDOW_BPS;
    /// @notice RAT for sale through the grid (400,000 for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: what the grid can ever release. Checks: testMode when not the real one.
    uint256 public immutable TOTAL;
    /// @notice Of the RAT, the share spread evenly over the levels, in basis points; the rest goes in proportion to the
    /// levels' prices (6,700: 67% even, 33% by price).
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: none.
    uint256 public constant EVEN_BPS = 6_700;
    /// @notice The sum of every level's price (USD, 8 decimals): the price-weighted part of level k is its price over it.
    /// @custom:security Who: computed at deploy from the grid. Delay: never changes. Limits: none. Checks: none.
    uint256 public immutable SUM_PX;
    /// @notice RAT released in a UTC day at most (10,000 for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most TOTAL. Checks: testMode when not the real one.
    uint256 public immutable DAY_CAP;
    /// @notice RAT released per RATE_WINDOW at most (2,000 an hour for real): a spike opens this much at most, then its refill.
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 wei to DAY_CAP. Checks: testMode when not the real one.
    uint256 public immutable RATE_CAP;
    /// @notice The rate cap refills evenly over this (1 hour for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: 1 minute to 1 day. Checks: testMode when not the real one.
    uint64 public immutable RATE_WINDOW;
    /// @notice How long a new ladder account or a new admin waits in public (3 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 3 days. Checks: testMode when shorter.
    uint64 public immutable CHANGE_DELAY;
    /// @notice How long an emergency recovery (the RAT back to the admin) waits in public (30 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 30 days. Checks: testMode when shorter.
    uint64 public immutable RECOVERY_DELAY;
    /// @notice How long a ready announcement may still be applied before it lapses (7 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: at most 7 days. Checks: testMode when shorter.
    uint64 public immutable EXECUTION_WINDOW;
    /// @notice True when any value differs from the real ones: a test deployment, never the founders' real lock.
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: none. Checks: read it before trusting the lock.
    bool public immutable testMode;

    /// @notice The founders' ladder account: the only place released RAT go (it sells them as public post-only orders).
    /// @custom:security Who: set at deploy; moved only by the admin through proposeLadder then applyLadder. Delay: CHANGE_DELAY (3 days for real) in public, then EXECUTION_WINDOW (7 days) or it lapses. Limits: one address. Checks: never address 0.
    address public ladder;
    /// @notice A proposed new ladder account (address 0: none).
    /// @custom:security Who: the admin proposes or cancels. Delay: CHANGE_DELAY (3 days for real). Limits: one at a time. Checks: public, cancellable, lapses.
    address public pendingLadder;
    /// @notice When the proposed ladder account may apply (0: none).
    /// @custom:security Who: set by proposeLadder. Delay: CHANGE_DELAY after the proposal. Limits: lapses EXECUTION_WINDOW after it. Checks: none.
    uint64 public ladderReadyAt;
    /// @notice When an announced emergency recovery may apply (0: none announced).
    /// @custom:security Who: set by proposeRecovery. Delay: RECOVERY_DELAY after the announcement. Limits: lapses EXECUTION_WINDOW after it. Checks: none.
    uint64 public recoveryReadyAt;
    /// @notice When a proposed new admin may accept (0: none).
    /// @custom:security Who: set by transferOwnership. Delay: CHANGE_DELAY after the proposal. Limits: lapses EXECUTION_WINDOW after it. Checks: none.
    uint64 public adminReadyAt;
    /// @notice Left of the rate cap at rateLeftAt (see rateRoom: it refills from there).
    /// @custom:security Who: only release() spends it. Delay: refills over RATE_WINDOW. Limits: RATE_CAP at most. Checks: none.
    uint256 public rateLeft;
    uint64 public rateLeftAt;
    /// @notice RAT released to the ladder so far.
    /// @custom:security Who: only release() raises it. Delay: none. Limits: at most TOTAL and the RAT held. Checks: never decreases.
    uint256 public released;
    /// @notice RAT released per UTC day (block.timestamp / 1 day).
    /// @custom:security Who: only release() raises it. Delay: none. Limits: DAY_CAP a day (10,000 for real). Checks: none.
    mapping(uint256 => uint256) public releasedOnDay;

    event Released(uint256 amount, uint256 bidUsd8, uint256 levelsOpen, uint256 releasedTotal, address to);
    event LadderProposed(address indexed to, uint64 readyAt);
    event LadderChangeCancelled(address indexed to);
    event LadderChanged(address indexed from, address indexed to);
    event RecoveryProposed(uint64 readyAt, uint256 heldNow);
    event RecoveryCancelled();
    event Recovered(address indexed to, uint256 amount);
    event AdminProposed(address indexed to, uint64 readyAt);

    error ZeroAddress();
    error BadGrid();
    error NoCorePrice();
    error NothingToRelease();
    error DayCapReached();
    error RateCapReached();
    error NothingHeld();
    error NothingPending();
    error NotReady();
    error Expired();
    error NoRenounce();

    constructor(IERC20 rat_, address ladder_, address admin_, uint32 coreAsset_, uint8 corePxDecimals_, Grid memory g) Ownable(admin_) {
        if (address(rat_) == address(0) || ladder_ == address(0)) revert ZeroAddress();
        if (coreAsset_ < 10000 || corePxDecimals_ > 8) revert BadGrid();
        bool gridTest = _checkGrid(g);
        testMode = gridTest || address(rat_) != REAL_RAT || coreAsset_ != REAL_CORE_ASSET || corePxDecimals_ != REAL_CORE_PX_DECIMALS;
        rat = rat_;
        ladder = ladder_;
        coreAsset = coreAsset_;
        corePxDecimals = corePxDecimals_;
        FLOOR_USD8 = g.floorUsd8;
        STEP_BPS = g.stepBps;
        LEVELS = g.levels;
        WINDOW_BPS = g.windowBps;
        TOTAL = g.total;
        uint256 px = g.floorUsd8;
        uint256 sumPx;
        for (uint256 k = 0; k < g.levels; k++) {
            sumPx += px;
            px = (px * (10_000 + g.stepBps) + 9_999) / 10_000;
        }
        // (checked math: a grid whose sizes could overflow later is refused here, at deploy)
        if (g.total * 10_000 * sumPx == 0) revert BadGrid();
        SUM_PX = sumPx;
        DAY_CAP = g.dayCap;
        RATE_CAP = g.rateCap;
        RATE_WINDOW = g.rateWindow;
        CHANGE_DELAY = g.changeDelay;
        RECOVERY_DELAY = g.recoveryDelay;
        EXECUTION_WINDOW = g.executionWindow;
        rateLeft = g.rateCap;
        rateLeftAt = uint64(block.timestamp);
    }

    /// @dev Sane values in any deployment; true when any differs from the real grid (a test).
    function _checkGrid(Grid memory g) internal pure returns (bool test) {
        if (g.floorUsd8 == 0 || g.stepBps == 0 || g.stepBps > 1000 || g.levels == 0 || g.levels > 1000 || g.windowBps > 5000) revert BadGrid();
        if (g.total == 0 || g.dayCap == 0 || g.dayCap > g.total) revert BadGrid();
        if (g.rateCap == 0 || g.rateCap > g.dayCap || g.rateWindow < 1 minutes || g.rateWindow > 1 days) revert BadGrid();
        Grid memory r = realGrid();
        // (a test only shortens the time rules)
        if (g.changeDelay == 0 || g.changeDelay > r.changeDelay || g.recoveryDelay == 0 || g.recoveryDelay > r.recoveryDelay) revert BadGrid();
        if (g.executionWindow == 0 || g.executionWindow > r.executionWindow) revert BadGrid();
        test = g.floorUsd8 != r.floorUsd8 || g.stepBps != r.stepBps || g.levels != r.levels || g.windowBps != r.windowBps
            || g.total != r.total || g.dayCap != r.dayCap || g.changeDelay != r.changeDelay || g.recoveryDelay != r.recoveryDelay
            || g.executionWindow != r.executionWindow
            || g.rateCap != r.rateCap || g.rateWindow != r.rateWindow;
    }

    // ------------------------------------------------------------------ release

    /// @notice What the rate cap still lets out now: RATE_CAP at most, refilled evenly over RATE_WINDOW.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: RATE_CAP (2,000 for real). Checks: none.
    function rateRoom() public view returns (uint256 room) {
        room = rateLeft + ((block.timestamp - rateLeftAt) * RATE_CAP) / RATE_WINDOW;
        if (room > RATE_CAP) room = RATE_CAP;
    }

    /// @dev The RAT of the first n levels, given the sum of their prices: EVEN_BPS of TOTAL spread evenly, the rest in
    /// proportion to the prices (the last level takes the rounding).
    function _ratOf(uint256 n, uint256 sumPx) internal view returns (uint256) {
        if (n >= LEVELS) return TOTAL;
        return (TOTAL * EVEN_BPS * n) / (10_000 * uint256(LEVELS)) + (TOTAL * (10_000 - EVEN_BPS) * sumPx) / (10_000 * SUM_PX); // (LEVELS is a uint16)
    }

    /// @dev How many levels a bid opens (those within WINDOW_BPS above it) and the sum of their prices.
    function _openAt(uint256 bid) internal view returns (uint256 open, uint256 sumPx) {
        uint256 reach = (bid * (10_000 + WINDOW_BPS)) / 10_000;
        uint256 px = FLOOR_USD8;
        while (open < LEVELS && px <= reach) {
            open++;
            sumPx += px;
            px = (px * (10_000 + STEP_BPS) + 9_999) / 10_000;
        }
    }

    /// @dev RAT of the levels open at `bid` not yet released (before the caps and the RAT held).
    function _openLeft(uint256 bid) internal view returns (uint256 left, uint256 open) {
        uint256 sumPx;
        (open, sumPx) = _openAt(bid);
        uint256 target = _ratOf(open, sumPx);
        if (target > released) left = target - released;
    }

    /// @notice Send the ladder account the RAT of the levels HyperCore's best bid now reaches (those within WINDOW_BPS,
    /// 10% for real, above it), not yet released: at most RATE_CAP an hour (2,000 RAT for real) and DAY_CAP a UTC day
    /// (10,000 RAT for real).
    /// @custom:security Who: anyone; the RAT always go to `ladder`, never to the caller. Delay: none. Limits: the levels
    /// reached, RATE_CAP over RATE_WINDOW, DAY_CAP a UTC day, the RAT held; nothing below FLOOR_USD8 / (1 + WINDOW_BPS).
    /// Checks: HyperCore's best bid through its precompile, no team oracle; a one-block spike opens RATE_CAP at most;
    /// reentrancy guard.
    function release() external nonReentrant returns (uint256 amount) {
        uint256 bid = bidUsd8();
        (uint256 left, uint256 open) = _openLeft(bid);
        if (left == 0) revert NothingToRelease();
        uint256 day = block.timestamp / 1 days;
        uint256 dayLeft = DAY_CAP - releasedOnDay[day];
        if (dayLeft == 0) revert DayCapReached();
        uint256 held = rat.balanceOf(address(this));
        if (held == 0) revert NothingHeld();
        uint256 rate = rateRoom();
        amount = left;
        if (amount > dayLeft) amount = dayLeft;
        if (amount > held) amount = held;
        if (amount > rate) amount = rate;
        if (amount == 0) revert RateCapReached();
        rateLeft = rate - amount;
        rateLeftAt = uint64(block.timestamp);
        released += amount;
        releasedOnDay[day] += amount;
        address to = ladder;
        emit Released(amount, bid, open, released, to);
        rat.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice HyperCore's best bid for RAT now, in USD with 8 decimals (reverts without a book).
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: the precompile's answer must hold a bid, and an
    /// ask at or above it when the book has asks (a book without asks, a squeeze, still reads).
    function bidUsd8() public view returns (uint256) {
        (bool ok, bytes memory out) = BBO_PRECOMPILE.staticcall(abi.encode(coreAsset));
        if (!ok || out.length != 64) revert NoCorePrice();
        (uint64 bid, uint64 ask) = abi.decode(out, (uint64, uint64));
        if (bid == 0 || (ask != 0 && ask < bid)) revert NoCorePrice();
        return uint256(bid) * 10 ** (8 - corePxDecimals);
    }

    /// @notice The price of level `k` (0 is the first) in USD with 8 decimals, rounded up.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: k under LEVELS. Checks: none.
    function levelPrice(uint256 k) public view returns (uint256 px) {
        if (k >= LEVELS) revert BadGrid();
        px = FLOOR_USD8;
        for (uint256 i = 0; i < k; i++) px = (px * (10_000 + STEP_BPS) + 9_999) / 10_000;
    }

    /// @notice How many levels a bid of `bid` (USD, 8 decimals) opens: those within WINDOW_BPS above it.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: at most LEVELS. Checks: none.
    function levelsOpenAt(uint256 bid) public view returns (uint256 open) {
        (open, ) = _openAt(bid);
    }

    /// @notice RAT on level `k` (0 is the first): its even part plus its price-weighted part, the last level taking the rounding.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: k under LEVELS. Checks: none.
    function levelSize(uint256 k) public view returns (uint256) {
        if (k >= LEVELS) revert BadGrid();
        uint256 px = FLOOR_USD8;
        uint256 sumPx;
        for (uint256 i = 0; i < k; i++) {
            sumPx += px;
            px = (px * (10_000 + STEP_BPS) + 9_999) / 10_000;
        }
        return _ratOf(k + 1, sumPx + px) - _ratOf(k, sumPx);
    }

    struct Level {
        uint256 index; // 0 is the first level
        uint256 priceUsd8; // its price, USD with 8 decimals (the ladder sells its RAT there, never below)
        uint256 size; // its RAT
        uint256 releasedRat; // what was released of it (levels are released in order, from the first)
        bool open; // the bid now reaches it (within WINDOW_BPS under its price): release() may send what is left of it
    }

    /// @notice `count` levels from level `from` (0 is the first): each one's price, its RAT, what was released of it and
    /// whether HyperCore's best bid now opens it. levels(0, LEVELS) reads the whole grid in one call.
    /// @custom:security Who: anyone (a view). Delay: none. Limits: cut at LEVELS. Checks: `open` is false for every level
    /// when HyperCore's book cannot be read.
    function levels(uint256 from, uint256 count) external view returns (Level[] memory out) {
        if (from >= LEVELS) return new Level[](0);
        if (count > LEVELS - from) count = LEVELS - from;
        uint256 open;
        try this.bidUsd8() returns (uint256 bid) {
            open = levelsOpenAt(bid);
        } catch {}
        out = new Level[](count);
        uint256 px = FLOOR_USD8;
        uint256 sumPx;
        for (uint256 i = 0; i < from; i++) {
            sumPx += px;
            px = (px * (10_000 + STEP_BPS) + 9_999) / 10_000;
        }
        for (uint256 j = 0; j < count; j++) {
            uint256 k = from + j;
            uint256 before = _ratOf(k, sumPx);
            sumPx += px;
            uint256 size = _ratOf(k + 1, sumPx) - before;
            uint256 done = released > before ? released - before : 0;
            out[j] = Level(k, px, size, done > size ? size : done, k < open);
            px = (px * (10_000 + STEP_BPS) + 9_999) / 10_000;
        }
    }

    struct Status {
        uint256 held; // RAT in the lock
        uint256 released; // RAT sent to the ladder so far
        uint256 bidUsd8; // HyperCore's best bid now (0: no book)
        uint256 levelsOpen; // levels the bid now reaches
        uint256 openLeft; // RAT of those levels not yet released (before the caps)
        uint256 releasableNow; // what release() would send now (within the rate, the day and the RAT held)
        uint256 nextLevelUsd8; // the next level's price (0: all open)
        uint256 dayRoom; // left of today's DAY_CAP
        uint256 rateRoom; // left of the rate cap now (RATE_CAP an hour)
        address ladder;
        address pendingLadder;
        uint64 ladderReadyAt; // a new ladder account may apply from then (0: none)
        uint64 recoveryReadyAt; // an emergency recovery announced: may apply from then (0: none)
        uint64 adminReadyAt; // a new admin may accept from then (0: none)
        address pendingAdmin;
        uint64 executionWindow; // each announcement lapses this long after its ready time
        address admin;
        bool testMode;
    }

    /// @notice Everything about the lock in one call (for the explorer and the economy page).
    /// @custom:security Who: anyone (a view). Delay: none. Limits: none. Checks: none.
    function status() external view returns (Status memory s) {
        s.held = rat.balanceOf(address(this));
        s.released = released;
        s.dayRoom = DAY_CAP - releasedOnDay[block.timestamp / 1 days];
        s.rateRoom = rateRoom();
        s.ladder = ladder;
        s.pendingLadder = pendingLadder;
        s.ladderReadyAt = ladderReadyAt;
        s.recoveryReadyAt = recoveryReadyAt;
        s.adminReadyAt = adminReadyAt;
        s.pendingAdmin = pendingOwner();
        s.executionWindow = EXECUTION_WINDOW;
        s.admin = owner();
        s.testMode = testMode;
        try this.bidUsd8() returns (uint256 bid) {
            s.bidUsd8 = bid;
            (s.openLeft, s.levelsOpen) = _openLeft(bid);
            uint256 r = s.openLeft;
            if (r > s.dayRoom) r = s.dayRoom;
            if (r > s.held) r = s.held;
            if (r > s.rateRoom) r = s.rateRoom;
            s.releasableNow = r;
            s.nextLevelUsd8 = s.levelsOpen < LEVELS ? levelPrice(s.levelsOpen) : 0;
        } catch {}
    }

    /// @dev An announcement's ready time: reverts when there is none, before it, or after its EXECUTION_WINDOW.
    function _ready(uint64 at) internal view {
        if (at == 0) revert NothingPending();
        if (block.timestamp < at) revert NotReady();
        if (block.timestamp > uint256(at) + EXECUTION_WINDOW) revert Expired();
    }

    // ------------------------------------------------------------------ the ladder account

    /// @notice Propose a new ladder account (a lost or moved key): it applies after CHANGE_DELAY, in public.
    /// @custom:security Who: the admin (the team Safe). Delay: CHANGE_DELAY (3 days for real) before applyLadder, which must
    /// follow within EXECUTION_WINDOW (7 days for real). Limits: the RAT still only go to the ladder account and only as the
    /// grid allows. Checks: public event; the admin can cancel; never address 0.
    function proposeLadder(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        pendingLadder = to;
        ladderReadyAt = uint64(block.timestamp + CHANGE_DELAY);
        emit LadderProposed(to, ladderReadyAt);
    }

    /// @notice Drop a proposed ladder account before it applies.
    /// @custom:security Who: the admin (the team Safe). Delay: none. Limits: only a pending proposal. Checks: public event.
    function cancelLadder() external onlyOwner {
        if (ladderReadyAt == 0) revert NothingPending();
        emit LadderChangeCancelled(pendingLadder);
        pendingLadder = address(0);
        ladderReadyAt = 0;
    }

    /// @notice Apply the proposed ladder account once its CHANGE_DELAY is over (within EXECUTION_WINDOW).
    /// @custom:security Who: the admin (the team Safe). Delay: after CHANGE_DELAY (3 days for real), before it lapses
    /// (EXECUTION_WINDOW, 7 days for real). Limits: the grid and the caps unchanged. Checks: public event.
    function applyLadder() external onlyOwner {
        _ready(ladderReadyAt);
        emit LadderChanged(ladder, pendingLadder);
        ladder = pendingLadder;
        pendingLadder = address(0);
        ladderReadyAt = 0;
    }

    // ------------------------------------------------------------------ the admin's way back

    /// @notice Announce an emergency recovery: what the lock then holds goes back to the admin (the team Safe) itself,
    /// never elsewhere, RECOVERY_DELAY after this, in public, so every holder sees it a month ahead. Only for a real
    /// problem (e.g. a Hyperliquid upgrade breaking the price read) or to move to a better lock.
    /// @custom:security Who: the admin (the team Safe). Delay: RECOVERY_DELAY (30 days for real) before executeRecovery,
    /// which must follow within EXECUTION_WINDOW (7 days for real). Limits: only what the lock holds, only to the admin of
    /// the day it applies (a new admin waits CHANGE_DELAY in public); releases go on meanwhile. Checks: public event; the
    /// admin can cancel.
    function proposeRecovery() external onlyOwner {
        recoveryReadyAt = uint64(block.timestamp + RECOVERY_DELAY);
        emit RecoveryProposed(recoveryReadyAt, rat.balanceOf(address(this)));
    }

    /// @notice Drop an announced recovery before it applies.
    /// @custom:security Who: the admin (the team Safe). Delay: none. Limits: only a pending one. Checks: public event.
    function cancelRecovery() external onlyOwner {
        if (recoveryReadyAt == 0) revert NothingPending();
        emit RecoveryCancelled();
        recoveryReadyAt = 0;
    }

    /// @notice Send what the lock holds back to the admin (the team Safe), once the announced recovery's RECOVERY_DELAY is
    /// over and before it lapses.
    /// @custom:security Who: the admin (the team Safe). Delay: after RECOVERY_DELAY (30 days for real), within
    /// EXECUTION_WINDOW (7 days for real). Limits: what the lock holds, only to the admin. Checks: public event; reentrancy guard.
    function executeRecovery() external onlyOwner nonReentrant returns (uint256 amount) {
        _ready(recoveryReadyAt);
        address to = owner();
        recoveryReadyAt = 0;
        amount = rat.balanceOf(address(this));
        emit Recovered(to, amount);
        if (amount != 0) rat.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ the admin

    /// @notice Propose a new admin: it may accept CHANGE_DELAY after this, in public (address 0 cancels a proposal).
    /// @custom:security Who: the admin (the team Safe). Delay: CHANGE_DELAY (3 days for real) before acceptOwnership, which
    /// must follow within EXECUTION_WINDOW (7 days for real). Limits: one at a time. Checks: public event (and OwnershipTransferStarted).
    function transferOwnership(address newOwner) public override onlyOwner {
        super.transferOwnership(newOwner);
        adminReadyAt = newOwner == address(0) ? 0 : uint64(block.timestamp + CHANGE_DELAY);
        emit AdminProposed(newOwner, adminReadyAt);
    }

    /// @notice The proposed admin takes over, once its CHANGE_DELAY is over and before it lapses.
    /// @custom:security Who: the proposed admin only. Delay: after CHANGE_DELAY (3 days for real), within EXECUTION_WINDOW
    /// (7 days for real). Limits: none. Checks: public event (OwnershipTransferred).
    function acceptOwnership() public override {
        _ready(adminReadyAt);
        adminReadyAt = 0;
        super.acceptOwnership();
    }

    /// @notice Disabled: without an admin a lost ladder key could never be replaced.
    /// @custom:security Who: nobody. Delay: none. Limits: always reverts. Checks: none.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }
}
