// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title RatRacePot
 * @notice The Big Cheese pot of Rat Race Combat, on chain so that anyone can see it.
 *
 * In: anybody may send RAT (plain transfers, or `fund` to label them): the team's top-ups, the
 * buybacks' pot share, and the game's returns (the pot share of every withdrawal fee, paid by
 * RatRaceDistributor when a checkpoint activates).
 *
 * Out: only to `distributor`, fixed at deploy (its `pot()` must name this contract). This contract
 * never sends RAT to a wallet; what the distributor then pays is its own checkpoints' business, signed
 * by another key. The game pays its pot prizes in the game's ledger; their RAT come here from the pot
 * to back them. Two draws, each signed by the game's pot key (`signer`) and sent by anybody, each
 * naming the period it pays, at most one period of each open at a time:
 *   - the 9 PM Manager's bonus (NIGHT): at most `nightBps` of the pot for a UTC day, sent from 18:00
 *     UTC that day (9 PM in Paris is 19:00 or 20:00 UTC) until 12:00 UTC the next day;
 *   - the month's top 10 bonus (MONTH): at most `monthBps` of the pot for a UTC calendar month, sent
 *     in the first 7 days of the month after it.
 * Each period pays once; a period missed is not paid later (the game carries it to the next draw).
 * Each draw's cap counts against the pot as it was before the draws of the last 24 hours (the pot now
 * plus what they took), so the order the two kinds are sent in never matters; and all draws of any 24
 * hours together never take more than `nightBps` + `monthBps` of that pot.
 *
 * Who decides what:
 *   - The game's pot key decides how much, within the caps above. Stolen, it can move at most
 *     `nightBps` + `monthBps` of the pot in any 24 hours (20% at 10% + 10%), and only to the
 *     distributor, whose own checkpoints (another key) decide what leaves it, under its daily caps. In
 *     production that key signs on a host of its own, not in the game server (server/scripts/pot-signer.mjs).
 *   - The owner (the team's multisig) can lower the rates at once, never below `MIN_BPS`; raising
 *     them (never above `NIGHT_MAX_BPS` / `MONTH_MAX_BPS`), a new signer or a new owner waits
 *     `TIMELOCK` and a new guardian `TIMELOCK_LONG` (14
 *     days: the guardian is the check on the owner) in public; each lapses if not executed within
 *     `EXECUTION_WINDOW` after that. These delays are the public warning: anybody watching the
 *     `Scheduled` events sees a change coming days before it can apply. A new signer nobody uses
 *     would stop the draws: public 3 days ahead, like every such change.
 *     Nothing sends the pot to the team: there is no sweep and no rescue of other tokens.
 *   - The guardian (or the owner) can cancel a scheduled raise of the rates (only the owner cancels a
 *     key change) and pause the draws for as long as it chooses within a freeze credit of
 *     `PAUSE_MAX` at most, refilled at `PAUSE_MAX` per `PAUSE_PERIOD` of open draws; a pause ends by
 *     itself, and an early unpause gives back what it had left.
 *   - The ownership moves only through the timelock, then in two steps (the new owner accepts within
 *     `EXECUTION_WINDOW`, or the offer lapses). Nobody can renounce it (nobody would be left to
 *     replace a key).
 *   - Everything is readable in one call: `status()`.
 *
 * The delays are set at deploy and never change: the real ones are 3 days, 14 days, 14 days,
 * 4 days and 30 days; a deploy may only shorten them, and then `testMode()` says so for good. A
 * holder checks one flag: `testMode() == false` is the real pot.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here `draw` sends RAT to the distributor only, and a change is schedule(call), then execute(call) once its
 * timelock is over (cancel drops it).
 */
contract RatRacePot is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant DRAW_TYPEHASH = keccak256("Draw(uint8 kind,uint64 period,uint256 amount)");
    uint8 public constant NIGHT = 1; // the 9 PM Manager's bonus, once per UTC day
    uint8 public constant MONTH = 2; // the month's top 10 bonus, once per UTC calendar month
    uint256 public constant NIGHT_FROM = 18 hours; // a day's NIGHT draw opens at 18:00 UTC that day...
    uint256 public constant NIGHT_UNTIL = 12 hours; // ...and closes at 12:00 UTC the next day
    uint256 public constant MONTH_DAYS = 7; // a month's MONTH draw is open in the first 7 days of the month after it

    uint256 public constant BPS = 10_000;
    uint256 public constant NIGHT_MAX_BPS = 3_000; // 30% of the pot at most
    uint256 public constant MONTH_MAX_BPS = 3_000;
    uint256 public constant MIN_BPS = 100; // 1%: the rates can be lowered, never to a pot nobody can win
    // the delays, fixed at deploy (Timings): never above the real ones, in brackets
    uint64 public immutable TIMELOCK; // (3 days)
    uint64 public immutable TIMELOCK_LONG; // (14 days) a new guardian (the same as the distributor's: the guardian is shared)
    uint64 public immutable EXECUTION_WINDOW; // (14 days) a scheduled change (or an owner offer) lapses this long after it is ready
    uint64 public immutable PAUSE_MAX; // (4 days) the TIMELOCK of a new signer, and a day
    uint64 public immutable PAUSE_PERIOD; // (30 days)
    uint64 public immutable MIN_PAUSE; // 1 hour (or PAUSE_MAX, if shorter)

    /// @notice The delays a deploy sets (seconds). The real pot: 3 days, 14 days, 14 days, 4 days, 30 days.
    struct Timings {
        uint64 timelock;
        uint64 timelockLong;
        uint64 executionWindow;
        uint64 pauseMax;
        uint64 pausePeriod;
    }
    /// @dev Any 24 hours lie within 25 consecutive clock hours: the daily cap sums the last 25.
    uint256 internal constant WINDOW_HOURS = 25;

    // the changes that wait TIMELOCK (schedule, then execute), by the call they make
    bytes4 public constant SET_SIGNER = bytes4(keccak256("setSigner(address)"));
    bytes4 public constant SET_GUARDIAN = bytes4(keccak256("setGuardian(address)"));
    bytes4 public constant SET_RATES = bytes4(keccak256("setRates(uint256,uint256)"));
    bytes4 public constant TRANSFER_OWNERSHIP = bytes4(keccak256("transferOwnership(address)"));

    /// @notice Everything about the pot in one read (`status()`).
    struct Status {
        uint256 pot; // RAT the pot holds
        uint256 nightBps;
        uint256 monthBps;
        uint256 minBps; // the rates' bounds, fixed for good
        uint256 nightMaxBps;
        uint256 monthMaxBps;
        bool nightOpen; // a 9 PM draw can be sent now, for nightPeriod (a UTC day)
        uint64 nightPeriod;
        uint256 nightRoom; // the most it can take now (0: drawn, paused or none open)
        uint256 nightDrawn; // what was drawn for nightPeriod
        bool monthOpen; // a month's draw can be sent now, for monthPeriod (year * 12 + month - 1)
        uint64 monthPeriod;
        uint256 monthRoom;
        uint256 monthDrawn;
        uint256 drawn24h; // RAT drawn in the last 24 hours (25 clock hours), all kinds
        bool paused;
        uint64 pausedUntil;
        uint256 freezeCredit; // seconds of pause available now
        address owner;
        address pendingOwner;
        address signer;
        address guardian;
        address distributor;
        address rat;
        uint256 timelock; // seconds a scheduled change waits
        uint256 timelockLong; // seconds a new guardian waits
        uint256 executionWindow; // seconds it may then be executed in
        uint64 ownerOfferUntil; // an executed ownership transfer must be accepted before this (0: none)
        uint256 pauseMax; // the freeze credit's ceiling (seconds)
        uint256 pausePeriod; // ...refilled over this many seconds of open draws
        bool testMode; // a delay is shorter than the real one: a TEST deployment
    }

    IERC20 public immutable rat;
    address public immutable distributor; // the only place the pot's RAT can go

    address public signer; // the game's key: signs the draws
    address public guardian; // cancels a scheduled raise of the rates, pauses the draws
    uint256 public nightBps;
    uint256 public monthBps;

    mapping(uint8 => mapping(uint64 => uint256)) public drawn; // kind => day or month => RAT drawn (0 = not yet)
    mapping(uint256 => uint256) public drawnInHour; // RAT drawn per clock hour, all kinds (the 24-hour cap)
    uint64 public ownerOfferUntil; // an executed transfer of the ownership lapses after this

    mapping(bytes32 => uint256) public scheduledAt; // keccak256(call) => when it may be executed
    mapping(bytes32 => bytes4) public scheduledCall;

    uint64 public pausedUntil;
    uint64 public freezeCredit;
    uint64 public freezeCreditAt;

    event Funded(address indexed from, uint256 amount, bytes32 tag);
    event Drawn(uint8 indexed kind, uint64 indexed period, uint256 amount, uint256 potBefore, address by);
    event SignerSet(address signer);
    event GuardianSet(address guardian);
    event RatesSet(uint256 nightBps, uint256 monthBps);
    event Scheduled(bytes32 indexed id, bytes data, uint256 executableAt);
    event Cancelled(bytes32 indexed id, address by);
    event Executed(bytes32 indexed id);
    event Paused(address by, uint64 until);
    event Unpaused(address by, uint256 creditBack);
    event OwnerOfferCancelled(address by);

    error ZeroAddress();
    error BadKind();
    error BadPeriod();
    error AlreadyDrawn();
    error NothingToDraw();
    error OverCap();
    error BadSignature();
    error BadRates();
    error NeedsTimelock();
    error NotGuardian();
    error NotScheduled();
    error NotReady();
    error Expired();
    error UnknownCall();
    error EnforcedPause();
    error ExpectedPause();
    error NoFreezeCredit();
    error NoRenounce();
    error BadDistributor();
    error BadTimings();

    constructor(
        address owner_,
        IERC20 rat_,
        address distributor_,
        address signer_,
        address guardian_,
        uint256 nightBps_,
        uint256 monthBps_,
        Timings memory t
    ) Ownable(owner_) EIP712("RatRacePot", "1") {
        if (address(rat_) == address(0) || distributor_ == address(0)) revert ZeroAddress();
        // every delay over 0 and never above the real one; the long one never under the short one, a
        // pause that outlasts a new signer's wait by a day (or by the wait itself, when it is shorter:
        // a test keeps the real margins), its refill slower than itself
        if (t.timelock == 0 || t.timelockLong == 0 || t.executionWindow == 0 || t.pauseMax == 0 || t.pausePeriod == 0) revert BadTimings();
        if (t.timelock > 3 days || t.timelockLong > 14 days || t.executionWindow > 14 days || t.pauseMax > 4 days || t.pausePeriod > 30 days) revert BadTimings();
        if (t.timelockLong < t.timelock || t.pausePeriod <= t.pauseMax) revert BadTimings();
        if (t.pauseMax < t.timelock + (t.timelock < 1 days ? t.timelock : 1 days)) revert BadTimings();
        TIMELOCK = t.timelock;
        TIMELOCK_LONG = t.timelockLong;
        EXECUTION_WINDOW = t.executionWindow;
        PAUSE_MAX = t.pauseMax;
        PAUSE_PERIOD = t.pausePeriod;
        MIN_PAUSE = t.pauseMax < 1 hours ? t.pauseMax : 1 hours;
        // the distributor is deployed first, for this contract's address: a wrong one would freeze the pot
        (bool ok, bytes memory r) = distributor_.staticcall(abi.encodeWithSignature("pot()"));
        if (!ok || r.length != 32 || abi.decode(r, (address)) != address(this)) revert BadDistributor();
        // ...of the same kind: a real pot only draws to a real distributor, a TEST pot to a TEST one (the
        // review of 46fc023: not only through the Launch)
        (ok, r) = distributor_.staticcall(abi.encodeWithSignature("testMode()"));
        bool test = t.timelock < 3 days || t.timelockLong < 14 days || t.executionWindow < 14 days || t.pauseMax < 4 days || t.pausePeriod < 30 days;
        if (!ok || r.length != 32 || abi.decode(r, (bool)) != test) revert BadDistributor();
        rat = rat_;
        distributor = distributor_;
        freezeCredit = t.pauseMax;
        freezeCreditAt = uint64(block.timestamp);
        _setSigner(signer_);
        _setGuardian(guardian_);
        _setRates(nightBps_, monthBps_);
    }

    // ------------------------------------------------------------------ in

    /// @notice Send RAT to the pot with a public label (a plain transfer works too).
    /// @custom:security Who: anyone. Delay: none. Limits: RAT only come in; nothing in this contract can send
    ///     them anywhere but the distributor.
    function fund(uint256 amount, bytes32 tag) external nonReentrant {
        uint256 before = rat.balanceOf(address(this));
        rat.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, rat.balanceOf(address(this)) - before, tag);
    }

    /// @notice The pot: every RAT this contract holds.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function pot() public view returns (uint256) {
        return rat.balanceOf(address(this));
    }

    // ------------------------------------------------------------------ out

    /// @notice The UTC day (NIGHT) or UTC calendar month (MONTH, year * 12 + month - 1) of `t`.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function periodOf(uint8 kind, uint256 t) public pure returns (uint64) {
        if (kind == NIGHT) return uint64(t / 1 days);
        if (kind == MONTH) return _monthOf(t / 1 days);
        revert BadKind();
    }

    /// @notice Whether a draw of `kind` for `period` may be sent at `t` (one period of each kind at a time).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function isOpen(uint8 kind, uint64 period, uint256 t) public pure returns (bool) {
        uint256 p = period;
        if (kind == NIGHT) {
            uint256 day = t / 1 days;
            uint256 tod = t % 1 days;
            return (p == day && tod >= NIGHT_FROM) || (p + 1 == day && tod < NIGHT_UNTIL);
        }
        if (kind == MONTH) return p + 1 == _monthOf(t / 1 days) && t >= MONTH_DAYS * 1 days && p == _monthOf(t / 1 days - MONTH_DAYS);
        revert BadKind();
    }

    /// @notice The period of `kind` open now (ok false: none; a NIGHT draw between 12:00 and 18:00 UTC,
    /// a MONTH draw after a month's first 7 days).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function openPeriod(uint8 kind) public view returns (bool ok, uint64 period) {
        if (kind == NIGHT) {
            uint256 day = block.timestamp / 1 days;
            uint256 tod = block.timestamp % 1 days;
            if (tod >= NIGHT_FROM) return (true, uint64(day));
            if (tod < NIGHT_UNTIL && day > 0) return (true, uint64(day - 1));
            return (false, 0);
        }
        if (kind == MONTH) {
            uint64 last = periodOf(MONTH, block.timestamp) - 1;
            return (isOpen(MONTH, last, block.timestamp), last);
        }
        revert BadKind();
    }

    /// @notice Everything about the pot in one read: balance, rates and bounds, the draws open now and
    /// what they may take, pause and freeze credit, every key, the timelock.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function status() external view returns (Status memory s) {
        s.pot = pot();
        s.nightBps = nightBps;
        s.monthBps = monthBps;
        s.minBps = MIN_BPS;
        s.nightMaxBps = NIGHT_MAX_BPS;
        s.monthMaxBps = MONTH_MAX_BPS;
        (s.nightOpen, s.nightPeriod) = openPeriod(NIGHT);
        s.nightRoom = room(NIGHT);
        s.nightDrawn = drawn[NIGHT][s.nightPeriod];
        (s.monthOpen, s.monthPeriod) = openPeriod(MONTH);
        s.monthRoom = room(MONTH);
        s.monthDrawn = drawn[MONTH][s.monthPeriod];
        s.drawn24h = drawnLast24h();
        s.paused = paused();
        s.pausedUntil = pausedUntil;
        s.freezeCredit = freezeCreditNow();
        s.owner = owner();
        s.pendingOwner = pendingOwner();
        s.signer = signer;
        s.guardian = guardian;
        s.distributor = distributor;
        s.rat = address(rat);
        s.timelock = TIMELOCK;
        s.timelockLong = TIMELOCK_LONG;
        s.executionWindow = EXECUTION_WINDOW;
        s.ownerOfferUntil = ownerOfferUntil;
        s.pauseMax = PAUSE_MAX;
        s.pausePeriod = PAUSE_PERIOD;
        s.testMode = testMode();
    }

    /// @notice A TEST deployment: a delay shorter than the real one (fixed at deploy, for good).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. A holder checks
    ///     testMode() == false: the real pot, with the real delays.
    function testMode() public view returns (bool) {
        return TIMELOCK < 3 days || TIMELOCK_LONG < 14 days || EXECUTION_WINDOW < 14 days || PAUSE_MAX < 4 days || PAUSE_PERIOD < 30 days;
    }

    /// @notice RAT drawn in the last 24 hours (the last 25 clock hours), all kinds together.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function drawnLast24h() public view returns (uint256 d) {
        uint256 h = block.timestamp / 1 hours;
        for (uint256 i = 0; i < WINDOW_HOURS && i <= h; i++) d += drawnInHour[h - i];
    }

    /// @dev The most a draw of `kind` may take now: its rate of the pot before the day's draws, and what
    /// the day's cap (both rates together) leaves of it.
    function _cap(uint8 kind) internal view returns (uint256) {
        uint256 d = drawnLast24h();
        uint256 base = pot() + d;
        uint256 one = (base * (kind == NIGHT ? nightBps : monthBps)) / BPS;
        uint256 day = (base * (nightBps + monthBps)) / BPS;
        uint256 left = day > d ? day - d : 0;
        return one < left ? one : left;
    }

    /// @notice The most a draw of `kind` may take now, for its open period: 0 when none is open, it was drawn, or paused.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function room(uint8 kind) public view returns (uint256) {
        (bool ok, uint64 period) = openPeriod(kind);
        if (!ok || paused() || drawn[kind][period] != 0) return 0;
        return _cap(kind);
    }

    /**
     * @notice Move `amount` RAT of the pot to the distributor for the game's draw `kind` of `period`
     * (the UTC day or month it pays, while it is open: isOpen), signed by the game's pot key; anybody
     * sends it. At most the kind's rate of the pot before the day's draws, and all draws of any 24 hours
     * together at most both rates of it; once per period.
     * @custom:security Who: anyone sends it, but only a draw signed by the pot signer key (EIP-712, for this
     *     contract and chain) passes. Delay: only while its period is open (NIGHT: from 18:00 UTC that day to
     *     12:00 UTC the next; MONTH: the first 7 days of the month after), once per period. Limits: at most
     *     nightBps / monthBps of the pot as it was before the last 24 hours of draws, and both rates together
     *     over any 24 hours; the RAT only ever go to the distributor. Checks: refused while paused (the
     *     guardian or the owner).
     */
    function draw(uint8 kind, uint64 period, uint256 amount, bytes calldata signature) external nonReentrant {
        if (paused()) revert EnforcedPause();
        if (!isOpen(kind, period, block.timestamp)) revert BadPeriod();
        if (drawn[kind][period] != 0) revert AlreadyDrawn();
        if (amount == 0) revert NothingToDraw();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(DRAW_TYPEHASH, kind, period, amount)));
        if (ECDSA.recover(digest, signature) != signer) revert BadSignature();
        uint256 potBefore = pot();
        if (amount > _cap(kind)) revert OverCap();
        drawn[kind][period] = amount;
        drawnInHour[block.timestamp / 1 hours] += amount;
        emit Drawn(kind, period, amount, potBefore, msg.sender);
        rat.safeTransfer(distributor, amount);
    }

    /// @dev days since 1970-01-01 -> year * 12 + month - 1 (H. Hinnant's civil_from_days, proleptic Gregorian).
    function _monthOf(uint256 z) internal pure returns (uint64) {
        z += 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
        return uint64(y * 12 + m - 1);
    }

    // ------------------------------------------------------------------ admin

    /// @notice Lower the rates at once (never below MIN_BPS); raising any is scheduled.
    /// @custom:security Who: the owner (the team Safe). Delay: none to lower them; a raise goes through
    ///     schedule / execute and waits TIMELOCK (3 days) in public. Limits: never under MIN_BPS (1%), never
    ///     above NIGHT_MAX_BPS / MONTH_MAX_BPS (30%). Checks: the guardian can cancel a scheduled raise.
    function setRates(uint256 nightBps_, uint256 monthBps_) external onlyOwner {
        if (nightBps_ > nightBps || monthBps_ > monthBps) revert NeedsTimelock();
        _setRates(nightBps_, monthBps_);
    }

    /**
     * @notice Schedule a change that waits in public: `data` is the call, one of setSigner(address),
     * setRates(uint256,uint256), transferOwnership(address) (TIMELOCK) or setGuardian(address)
     * (TIMELOCK_LONG), applied by `execute`; a new owner then accepts. The event's executableAt says when.
     * @custom:security Who: the owner (the team Safe). Delay: the change can only be executed after TIMELOCK (3
     *     days), or TIMELOCK_LONG (14 days) for a new guardian, and it lapses EXECUTION_WINDOW (14 days) after
     *     it is ready. Limits: only setSigner, setGuardian, setRates and transferOwnership. Checks: public (the
     *     Scheduled event carries the exact call); the owner can cancel it, the guardian a raise of the rates.
     */
    function schedule(bytes calldata data) external onlyOwner returns (bytes32 id) {
        bytes4 sel = _check(data);
        id = keccak256(data);
        uint256 at = block.timestamp + (sel == SET_GUARDIAN ? TIMELOCK_LONG : TIMELOCK);
        scheduledAt[id] = at;
        scheduledCall[id] = sel;
        emit Scheduled(id, data, at);
    }

    /// @notice Drop a scheduled change: the owner any, the guardian a raise of the rates only (it can
    /// never hold up the replacement of a key, its own or the signer's).
    /// @custom:security Who: the owner (any scheduled change) or the guardian (a raise of the rates only).
    ///     Delay: none. Limits: it only cancels; nothing moves.
    function cancel(bytes32 id) external {
        address owner_ = owner();
        if (msg.sender != guardian && msg.sender != owner_) revert NotGuardian();
        if (scheduledAt[id] == 0) revert NotScheduled();
        if (msg.sender != owner_ && scheduledCall[id] != SET_RATES) revert NotGuardian();
        delete scheduledAt[id];
        delete scheduledCall[id];
        emit Cancelled(id, msg.sender);
    }

    /// @notice Apply a scheduled change once its TIMELOCK is over, within EXECUTION_WINDOW (the owner).
    /// @custom:security Who: the owner (the team Safe). Delay: only once its wait is over (TIMELOCK, 3 days;
    ///     TIMELOCK_LONG, 14 days, for a new guardian) and within EXECUTION_WINDOW (14 days) after, or it
    ///     lapses. Limits: exactly the call that was scheduled. Checks: a new owner must still accept within
    ///     EXECUTION_WINDOW.
    function execute(bytes calldata data) external onlyOwner {
        bytes32 id = keccak256(data);
        uint256 at = scheduledAt[id];
        if (at == 0) revert NotScheduled();
        if (block.timestamp < at) revert NotReady();
        if (block.timestamp > at + EXECUTION_WINDOW) revert Expired();
        delete scheduledAt[id];
        delete scheduledCall[id];
        emit Executed(id);
        bytes4 sel = _check(data);
        if (sel == SET_SIGNER) _setSigner(abi.decode(data[4:], (address)));
        else if (sel == SET_GUARDIAN) _setGuardian(abi.decode(data[4:], (address)));
        else if (sel == TRANSFER_OWNERSHIP) {
            ownerOfferUntil = uint64(block.timestamp + EXECUTION_WINDOW);
            super.transferOwnership(abi.decode(data[4:], (address)));
        }
        else {
            (uint256 n, uint256 m) = abi.decode(data[4:], (uint256, uint256));
            _setRates(n, m);
        }
    }

    function _check(bytes calldata data) internal pure returns (bytes4 sel) {
        if (data.length < 4) revert UnknownCall();
        sel = bytes4(data[:4]);
        bool known = sel == SET_SIGNER || sel == SET_GUARDIAN || sel == SET_RATES || sel == TRANSFER_OWNERSHIP;
        if (!known || data.length != 4 + (sel == SET_RATES ? 64 : 32)) revert UnknownCall();
    }

    function _setSigner(address s) internal {
        if (s == address(0)) revert ZeroAddress();
        signer = s;
        emit SignerSet(s);
    }

    function _setGuardian(address g) internal {
        if (g == address(0)) revert ZeroAddress();
        guardian = g;
        emit GuardianSet(g);
    }

    function _setRates(uint256 nightBps_, uint256 monthBps_) internal {
        if (nightBps_ < MIN_BPS || monthBps_ < MIN_BPS || nightBps_ > NIGHT_MAX_BPS || monthBps_ > MONTH_MAX_BPS) revert BadRates();
        nightBps = nightBps_;
        monthBps = monthBps_;
        emit RatesSet(nightBps_, monthBps_);
    }

    /// @notice Disabled: without an owner nobody could replace a key or change the rates.
    /// @custom:security Who: nobody: it always reverts (without an owner nobody could replace a key).
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    /// @notice Only through the timelock: schedule(transferOwnership(newOwner)), then execute it.
    /// @custom:security Who: nobody directly: it reverts. The ownership only moves through schedule / execute
    ///     (TIMELOCK, 3 days, in public), then the new owner accepts.
    function transferOwnership(address) public view override onlyOwner {
        revert NeedsTimelock();
    }

    /// @notice The new owner takes over, within EXECUTION_WINDOW of the executed transfer.
    /// @custom:security Who: the pending owner. Delay: within EXECUTION_WINDOW (14 days) of the executed
    ///     transfer, or the offer lapses.
    function acceptOwnership() public override {
        if (block.timestamp > ownerOfferUntil) revert Expired();
        ownerOfferUntil = 0;
        super.acceptOwnership();
    }

    /// @notice Withdraw an owner offer not accepted yet, at once (the owner).
    /// @custom:security Who: the owner. Delay: none. Limits: it only withdraws a pending ownership offer.
    function cancelOwnerOffer() external onlyOwner {
        ownerOfferUntil = 0;
        Ownable2Step.transferOwnership(address(0));
        emit OwnerOfferCancelled(msg.sender);
    }

    // ------------------------------------------------------------------ pause

    /// @notice Paused: no draws. A pause always ends by itself.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    /// @notice Seconds of pause available now: PAUSE_MAX at most, refilled at PAUSE_MAX per
    /// PAUSE_PERIOD of open draws (never while paused).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    function freezeCreditNow() public view returns (uint256 credit) {
        credit = freezeCredit;
        uint256 from = freezeCreditAt;
        if (pausedUntil > from) from = pausedUntil;
        if (block.timestamp > from) credit += ((block.timestamp - from) * PAUSE_MAX) / PAUSE_PERIOD;
        if (credit > PAUSE_MAX) credit = PAUSE_MAX;
    }

    /// @notice Stop the draws (guardian or owner) for as long as the freeze credit lasts; it ends by itself.
    /// @custom:security Who: the guardian or the owner. Delay: none. Limits: at most the freeze credit,
    ///     PAUSE_MAX (4 days), refilled at PAUSE_MAX per PAUSE_PERIOD (30 days) of open draws; a pause always
    ///     ends by itself. Checks: it stops the draws only; no RAT moves.
    function pause() external {
        _pause(0);
    }

    /// @notice Stop the draws for `seconds_` only (MIN_PAUSE at least), keeping the rest of the freeze
    /// credit for a later incident.
    /// @custom:security Who: the guardian or the owner. Delay: none. Limits: MIN_PAUSE (1 hour) at least, the
    ///     freeze credit at most (PAUSE_MAX, 4 days); the rest of the credit stays for later. Checks: it stops
    ///     the draws only; no RAT moves.
    function pauseFor(uint64 seconds_) external {
        if (seconds_ < MIN_PAUSE) revert NoFreezeCredit();
        _pause(seconds_);
    }

    function _pause(uint256 want) internal {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        if (paused()) revert EnforcedPause();
        uint256 credit = freezeCreditNow();
        if (credit < MIN_PAUSE) revert NoFreezeCredit();
        uint256 len = want == 0 || want > credit ? credit : want;
        freezeCredit = uint64(credit - len);
        freezeCreditAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp + len);
        emit Paused(msg.sender, pausedUntil);
    }

    /// @notice End the pause now (the owner); what it had left goes back to the freeze credit.
    /// @custom:security Who: the owner. Delay: none. Limits: what the pause had left goes back to the freeze
    ///     credit (never above PAUSE_MAX).
    function unpause() external onlyOwner {
        if (!paused()) revert ExpectedPause();
        uint256 back = uint256(pausedUntil) - block.timestamp;
        uint256 credit = freezeCredit + back;
        freezeCredit = uint64(credit > PAUSE_MAX ? PAUSE_MAX : credit);
        freezeCreditAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp);
        emit Unpaused(msg.sender, back);
    }
}
