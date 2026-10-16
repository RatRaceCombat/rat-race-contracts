// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title RatRaceDistributor
 * @notice RAT won in Rat Race Combat, withdrawn by the players themselves.
 *
 * The game keeps the accounts off-chain (kills, banking, suits, withdrawal requests with their
 * fees). Every epoch (`EPOCH`, 10 minutes) it signs one checkpoint, without sending any transaction:
 *   - root:          Merkle root of (player, cumulative RAT the player may withdraw, net of fees)
 *   - withdrawTotal: the sum of those amounts
 *   - burnTotal:     cumulative RAT the game burned (suits, withdrawal fees, renames)
 *   - potTotal:      cumulative RAT the game owes the Big Cheese pot (its share of withdrawal fees and
 *                    suits, the reserve's seeds of the 9 PM Manager): sent to `pot` (RatRacePot), which
 *                    can only ever send RAT back here; 0 until `confirmPot` checked the link
 *   - bounty:        RAT paid to whoever publishes it (a small random reward for the gas)
 *
 * Anybody publishes it. After `delay` (`MIN_DELAY`, 10 minutes, at least: the window in which a bad
 * checkpoint can be vetoed) it becomes active: the new burn is sent to the dead address, the pot's
 * new share to the pot, and players claim the difference between their cumulative amount and what
 * they already received (against the active root or the one before it).
 *
 * Who decides what:
 *   - The game's signer (a key on the team's server) decides which wallets the root pays and how
 *     much: the contract does not check it. Whatever a checkpoint says, at most `outflowCap` RAT are
 *     paid to wallets in any 24 hours (claims and bounties, counted when paid), and at most
 *     `outflowCap` may be published to leave and `burnCap` to burn or send to the pot in any 24 hours.
 *     `burnCap` is fixed at deploy; the owner may change `outflowCap` in public, lowering it after
 *     `TIMELOCK` (3 days) and raising it after `TIMELOCK_RAISE` (7 days), never above `MAX_OUTFLOW_CAP`.
 *   - Nothing goes to the team: RAT leaves only to the players' wallets, to the publishers'
 *     bounties, to the dead address (the checkpoints' burns) and to `pot`, fixed at deploy and paid only once
 *     `confirmPot` saw a contract naming this distributor (RatRacePot sends RAT only back here; its
 *     source is verified next to this one), its share counted with the burns (`burnCap`). No sweep (the
 *     user, 2026-10-14: "simplify what we can"): the RAT no checkpoint owes stay for the rewards to come.
 *   - The owner (the team's multisig once the ownership is handed over) can slow the withdrawals,
 *     not below `MIN_DAILY_WITHDRAW` a day: every path keeps the steps and the delay above it. A new
 *     signer or sentinel, a new owner and any loosening wait `TIMELOCK` (3 days) in public; a new
 *     guardian waits `TIMELOCK_LONG` (14 days: the guardian is the check on the owner, and these
 *     delays are the public warning); all lapse if not executed within
 *     `EXECUTION_WINDOW` after that. A new signer is also how the owner could stop new checkpoints
 *     (one nobody uses): public 3 days ahead, like every such change. An owner offer lapses too.
 *   - The guardian (or the owner) can cancel a scheduled change (the guardian never its own
 *     replacement), pause and veto. The sentinel (optional: a watcher bot's key) can only pause and
 *     veto, at once, and the owner or the guardian can drop it at once. Pauses and vetoes draw on
 *     one freeze credit: `PAUSE_MAX` at most, refilled at `PAUSE_MAX` per `PAUSE_PERIOD` of open
 *     withdrawals. A pause ends by itself when its credit runs out, and an early unpause gives back
 *     what is left. A checkpoint past its delay can be vetoed only during a pause (an emergency).
 *   - Nobody can renounce the ownership (nobody would be left to unpause or fix anything) or
 *     publish an epoch more than `MAX_EPOCH_AHEAD` epochs (an hour) ahead of the clock (a stolen
 *     signer key could otherwise hold the honest checkpoints back for a long time).
 * A claim pays what fits under the signed total and the day's window; the same proof pays the rest
 * later.
 *
 * Its time rules are set at deploy: each one at most the real value written in the code (`realTimings()`),
 * and any shorter one makes `testMode()` true. The production contract is the one whose `testMode()`
 * is false: every delay above is then the real one.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here `claim` pays a player's withdrawal and `publish` posts a checkpoint; a change is schedule(call), then
 * execute(call) once its timelock is over (cancel drops it; veto stops a checkpoint in its window).
 */
contract RatRaceDistributor is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant CHECKPOINT_TYPEHASH = keccak256(
        "Checkpoint(uint64 epoch,bytes32 root,uint256 withdrawTotal,uint256 burnTotal,uint256 potTotal,uint256 bounty)"
    );
    uint64 public constant EPOCH = 10 minutes; // the game signs one checkpoint an epoch: epoch = timestamp / EPOCH
    uint64 public constant MIN_DELAY = EPOCH; // every checkpoint waits this long at least: the veto window
    uint256 public constant MAX_OUTFLOW_CAP = 200_000e18; // the outflow cap can never go above this
    uint64 public constant MAX_EPOCH_AHEAD = 6; // epochs: an hour (the game signs the current one)

    /// @notice The limits at deploy: the checkpoints' delay and steps, the bounty, the two daily caps.
    struct Limits {
        uint64 delay; // MIN_DELAY to MAX_DELAY
        uint256 maxStepWithdraw;
        uint256 maxStepSettle;
        uint256 maxBounty;
        uint256 outflowCap; // MIN_DAILY_WITHDRAW to MAX_OUTFLOW_CAP
        uint256 burnCap; // fixed for good
    }

    /// @notice The time rules, set at deploy: each at most its real value (realTimings()); shorter = testMode.
    struct Timings {
        uint64 timelock; // TIMELOCK, real 3 days
        uint64 timelockRaise; // TIMELOCK_RAISE, real 7 days: raising the outflow cap
        uint64 timelockLong; // TIMELOCK_LONG, real 14 days: a new guardian
        uint64 executionWindow; // EXECUTION_WINDOW, real 14 days: a scheduled change (or an owner offer) lapses this long after it is ready
        uint64 pauseMax; // PAUSE_MAX, real 4 days: the freeze credit's size, the TIMELOCK of a new signer and a day
        uint64 pausePeriod; // PAUSE_PERIOD, real 30 days: the credit refills PAUSE_MAX per PAUSE_PERIOD of open withdrawals
    }
    /// @notice The wait between scheduling a new signer, sentinel, owner or looser limit and applying it.
    /// @custom:security Who: set at deploy, never changed. Delay: TIMELOCK (3 days for real; shorter only on a testMode deploy). Limits: at most 3 days, never 0. Checks: a shorter value makes testMode() true.
    uint64 public immutable TIMELOCK;
    /// @notice The wait before a scheduled raise of the outflow cap applies.
    /// @custom:security Who: set at deploy, never changed. Delay: TIMELOCK_RAISE (7 days for real; shorter only on a testMode deploy). Limits: at least TIMELOCK. Checks: a shorter value makes testMode() true.
    uint64 public immutable TIMELOCK_RAISE;
    /// @notice The wait before a new guardian applies.
    /// @custom:security Who: set at deploy, never changed. Delay: TIMELOCK_LONG (14 days for real; shorter only on a testMode deploy). Limits: at least TIMELOCK_RAISE. Checks: a shorter value makes testMode() true.
    uint64 public immutable TIMELOCK_LONG;
    /// @notice How long a ready scheduled change (or an owner offer) can still be applied before it lapses.
    /// @custom:security Who: set at deploy, never changed. Delay: EXECUTION_WINDOW (14 days for real; shorter only on a testMode deploy). Limits: a lapsed change must be scheduled again, in public. Checks: a shorter value makes testMode() true.
    uint64 public immutable EXECUTION_WINDOW;
    /// @notice The freeze credit's size: the longest pause, and the most pause or veto time held in reserve.
    /// @custom:security Who: set at deploy, never changed. Delay: PAUSE_MAX (4 days for real: a new signer's TIMELOCK and a day; shorter only on a testMode deploy). Limits: at least TIMELOCK plus min(1 day, TIMELOCK). Checks: a shorter value makes testMode() true.
    uint64 public immutable PAUSE_MAX;
    /// @notice The freeze credit refills PAUSE_MAX per PAUSE_PERIOD of open withdrawals (never while paused).
    /// @custom:security Who: set at deploy, never changed. Delay: PAUSE_PERIOD (30 days for real; shorter only on a testMode deploy). Limits: longer than PAUSE_MAX, so pauses hold the withdrawals about an eighth of the time at most. Checks: a shorter value makes testMode() true.
    uint64 public immutable PAUSE_PERIOD;
    /// @notice A pause needs at least this much freeze credit.
    /// @custom:security Who: set at deploy, never changed. Delay: MIN_PAUSE (1 hour for real, PAUSE_MAX when that is shorter). Limits: none. Checks: none.
    uint64 public immutable MIN_PAUSE; // a pause needs at least this much credit: 1 hour (PAUSE_MAX when shorter)
    /// @notice The longest activation delay of a checkpoint.
    /// @custom:security Who: set at deploy, never changed. Delay: MAX_DELAY (1 day for real, PAUSE_MAX when that is shorter). Limits: a veto costs the delay, so it always fits the freeze credit. Checks: none.
    uint64 public immutable MAX_DELAY; // 1 day (PAUSE_MAX when shorter): a veto (it costs the delay) always fits the credit
    /// @notice True on a test deployment: a time rule shorter than the real one. The production contract says false.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: false means every time rule is the real one (realTimings()). Checks: the launcher refuses a test pot with a real distributor and the reverse.
    bool public immutable testMode; // a time rule shorter than the real one: a test deployment

    /// @notice The real time rules: the production contract has exactly these (testMode() false).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: TIMELOCK 3 days, TIMELOCK_RAISE 7 days, TIMELOCK_LONG 14 days, EXECUTION_WINDOW 14 days, PAUSE_MAX 4 days, PAUSE_PERIOD 30 days. Checks: none.
    function realTimings() public pure returns (Timings memory) {
        return Timings(3 days, 7 days, 14 days, 14 days, 4 days, 30 days);
    }

    /// @dev Each one above 0 and at most its real value (a test only shortens them), in the real ones'
    /// order: a raise and a new guardian never quicker than a plain change, a pause long enough to cover
    /// a new signer, the refill period at least the pause. True when any is shorter: a test.
    function _checkTimings(Timings memory t) internal pure returns (bool test) {
        Timings memory r = realTimings();
        uint64[6] memory got = [t.timelock, t.timelockRaise, t.timelockLong, t.executionWindow, t.pauseMax, t.pausePeriod];
        uint64[6] memory max = [r.timelock, r.timelockRaise, r.timelockLong, r.executionWindow, r.pauseMax, r.pausePeriod];
        for (uint256 i = 0; i < 6; i++) {
            if (got[i] == 0 || got[i] > max[i]) revert BadTimings();
            if (got[i] < max[i]) test = true;
        }
        // (the real margins kept in a test: the pause covers a new signer and a day, or twice a short
        // timelock; the refill period is longer than the pause)
        uint64 margin = t.timelock < 1 days ? t.timelock : 1 days;
        if (t.timelockRaise < t.timelock || t.timelockLong < t.timelockRaise || t.pauseMax < t.timelock + margin || t.pausePeriod <= t.pauseMax || t.pauseMax < MIN_DELAY) revert BadTimings();
    }
    uint256 public constant MIN_DAILY_WITHDRAW = 24_000e18; // the steps and the delay always allow this much a day
    /// @dev Any 24 hours lie within 25 consecutive clock hours: the daily caps sum the last 25.
    uint256 internal constant WINDOW_HOURS = 25;

    // the changes that wait TIMELOCK (schedule, then execute), by the call they make
    bytes4 public constant SET_SIGNER = bytes4(keccak256("setSigner(address)"));
    bytes4 public constant SET_GUARDIAN = bytes4(keccak256("setGuardian(address)"));
    bytes4 public constant SET_LIMITS = bytes4(keccak256("setLimits(uint64,uint256,uint256,uint256)"));
    bytes4 public constant SET_OUTFLOW_CAP = bytes4(keccak256("setOutflowCap(uint256)"));
    bytes4 public constant SET_OWNER = bytes4(keccak256("transferOwnership(address)"));
    bytes4 public constant SET_SENTINEL = bytes4(keccak256("setSentinel(address)"));

    struct Checkpoint {
        uint64 epoch;
        uint64 activeAt; // when it can be claimed against (0 = none)
        bytes32 root;
        uint256 withdrawTotal;
        uint256 burnTotal;
        uint256 potTotal;
    }

    struct Spent {
        uint128 out;
        uint128 burn;
    }

    /// @notice The RAT token this contract pays out.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: none. Checks: none.
    IERC20 public immutable rat;
    /// @notice RAT that may be published to leave, and RAT paid to wallets (claims and bounties), in any 24 hours.
    /// @custom:security Who: the owner, through schedule then execute. Delay: TIMELOCK (3 days for real) to lower it, TIMELOCK_RAISE (7 days for real) to raise it. Limits: MAX_OUTFLOW_CAP (200,000 RAT) at most, MIN_DAILY_WITHDRAW (24,000 RAT) at least, never under the steps. Checks: the guardian can cancel the change.
    uint256 public outflowCap; // RAT published to leave, and RAT paid to wallets, per 24 h (withdrawals + bounties)
    /// @notice RAT that may be burned or sent to the pot in any 24 hours (checkpoint burns and the pot's share).
    /// @custom:security Who: set at deploy, nobody can change it. Delay: none. Limits: fixed for good. Checks: none.
    uint256 public immutable burnCap; // RAT burned or sent to the pot per 24 h: checkpoint burns, the pot's share

    /// @notice The game's checkpoint key: it signs which wallets may withdraw how much.
    /// @custom:security Who: replaced only by the owner, through schedule then execute. Delay: TIMELOCK (3 days for real). Limits: whatever it signs, the steps and the daily caps bound what leaves. Checks: every checkpoint waits its delay, in which the guardian, the owner or the sentinel can veto it; never the sentinel's key.
    address public signer; // the game's checkpoint key
    /// @notice The guardian: it can veto a pending checkpoint, cancel a scheduled change and pause.
    /// @custom:security Who: replaced only by the owner, through schedule then execute. Delay: TIMELOCK_LONG (14 days for real). Limits: its pauses and vetoes draw on the freeze credit. Checks: it cannot cancel its own replacement.
    address public guardian; // can veto a pending checkpoint, cancel a scheduled change and pause
    /// @notice The sentinel (optional, 0 = none): a watcher bot's key that can only veto and pause.
    /// @custom:security Who: set by the owner through schedule then execute; dropped at once by the owner or the guardian. Delay: TIMELOCK (3 days for real) to set, none to drop. Limits: its pauses and vetoes draw on the freeze credit; it cannot cancel, schedule or unpause. Checks: never the signer's key.
    address public sentinel; // optional (0 = none): a watcher bot's key that can only veto and pause
    /// @notice The Big Cheese pot (RatRacePot): it only ever sends RAT back here.
    /// @custom:security Who: set at deploy, nobody can change it. Delay: none. Limits: its share counts under burnCap. Checks: no pot share before confirmPot() saw a contract naming this distributor.
    address public immutable pot; // RatRacePot: the Big Cheese pot, which only ever sends RAT back here
    /// @notice True once confirmPot() checked that the pot is a contract whose distributor() is this one.
    /// @custom:security Who: anyone can confirm it, once. Delay: none. Limits: until then checkpoints carry no pot share. Checks: a wrong pot address only ever means no pot share.
    bool public potLinked; // confirmPot: `pot` is a contract whose distributor() is this one; no pot share before

    /// @notice How long a published checkpoint waits before anyone can claim against it: the veto window.
    /// @custom:security Who: the owner. Delay: none to lengthen it; TIMELOCK (3 days for real) to shorten it. Limits: MIN_DELAY (10 minutes) to MAX_DELAY (1 day for real). Checks: the guardian can cancel a scheduled shortening.
    uint64 public delay;
    /// @notice The most the signed withdrawals may rise in one checkpoint.
    /// @custom:security Who: the owner. Delay: none to lower it; TIMELOCK (3 days for real) to raise it. Limits: at most outflowCap, and always enough for MIN_DAILY_WITHDRAW (24,000 RAT) a day. Checks: the guardian can cancel a scheduled raise.
    uint256 public maxStepWithdraw; // max rise of withdrawTotal per checkpoint
    /// @notice The most the burns and the pot's share may rise in one checkpoint.
    /// @custom:security Who: the owner. Delay: none to lower it; TIMELOCK (3 days for real) to raise it. Limits: at most burnCap. Checks: the guardian can cancel a scheduled raise.
    uint256 public maxStepSettle; // max rise of burnTotal + potTotal per checkpoint
    /// @notice The most a checkpoint may pay its publisher.
    /// @custom:security Who: the owner. Delay: none to lower it; TIMELOCK (3 days for real) to raise it. Limits: at most outflowCap; a bounty also shrinks to what the day's paid window has left. Checks: the guardian can cancel a scheduled raise.
    uint256 public maxBounty;

    Checkpoint public active; // claims are checked against this one
    Checkpoint public pending; // published, waiting for its delay (or a veto)
    bytes32 public previousRoot; // the root active before `active`: its proofs still claim (one fetched
    // just before a new checkpoint activated); claimed[] and the active withdrawTotal still bound them.
    // Kept only when the same signer signed both: a root from a replaced (maybe stolen) key never
    // outlives the first checkpoint of the new key
    uint64 internal signerGen; // +1 at each new signer
    uint64 internal pendingGen; // the signer generation of the pending checkpoint, and of the active one
    uint64 internal activeGen;
    uint64 public lastPublishedEpoch; // includes vetoed checkpoints: signatures cannot be replayed

    uint256 public burned; // settled so far
    uint256 public potPaid; // sent to the pot so far
    uint256 public totalClaimed;
    /// @notice The RAT already sent to each player (cumulative): a claim pays only the difference.
    /// @custom:security Who: grows only through claims. Delay: none. Limits: never decreases. Checks: none.
    mapping(address => uint256) public claimed; // cumulative RAT sent to each player

    mapping(uint256 => Spent) public spentInHour; // what the daily caps counted, per clock hour (timestamp / 1 hours)
    uint256 internal pendingHour; // the pending checkpoint's hour and what it counted there (a veto gives it back)
    Spent internal pendingSpent;
    mapping(uint256 => uint256) public paidInHour; // RAT actually paid to wallets (claims, bounties), per clock hour

    mapping(bytes32 => uint256) public scheduledAt; // keccak256(call) => when it may be executed
    mapping(bytes32 => bytes4) public scheduledCall; // keccak256(call) => its selector
    mapping(bytes32 => bool) public scheduledLong; // scheduled with TIMELOCK_RAISE (an outflow cap raise)

    uint64 public pausedUntil; // paused while block.timestamp < pausedUntil
    uint64 public freezeCredit; // seconds of pause or veto left at freezeCreditAt (see freezeCreditNow)
    uint64 public freezeCreditAt;

    uint64 public ownerOfferUntil; // the new owner accepts by then (0 = no offer)

    event Published(uint64 indexed epoch, bytes32 root, uint256 withdrawTotal, uint256 burnTotal, uint256 potTotal, address indexed by, uint256 bounty);
    event Activated(uint64 indexed epoch, uint256 burnedNow, uint256 potNow);
    /// @dev cost: the freeze it used (seconds); pausedUntil: the pause's new end when it came out of a pause
    event Vetoed(uint64 indexed epoch, address by, uint256 cost, uint64 pausedUntil);
    event Claimed(address indexed player, uint256 amount, uint256 cumulative, uint64 epoch);
    event SignerSet(address signer);
    event GuardianSet(address guardian);
    event SentinelSet(address sentinel);
    event OwnerOffered(address newOwner, uint64 until);
    event LimitsSet(uint64 delay, uint256 maxStepWithdraw, uint256 maxStepSettle, uint256 maxBounty);
    event Scheduled(bytes32 indexed id, bytes data, uint256 executableAt);
    event Cancelled(bytes32 indexed id, address by);
    event Executed(bytes32 indexed id);
    event Paused(address by, uint64 until);
    event PotLinked(address pot);
    event Unpaused(address by, uint256 creditBack);
    event OutflowCapSet(uint256 outflowCap);

    error BadSignature();
    error StaleEpoch();
    error TotalsDecrease();
    error StepTooBig();
    error BountyTooBig();
    error InsufficientReserve();
    error PendingNotReady();
    error NoActiveCheckpoint();
    error BadProof();
    error NothingToClaim();
    error OverWithdrawTotal();
    error NotGuardian();
    error ZeroAddress();
    error TooMuch();
    error OverDailyCap();
    error NeedsTimelock();
    error NotScheduled();
    error NotReady();
    error UnknownCall();
    error EpochTooFar();
    error Expired();
    error EnforcedPause();
    error ExpectedPause();
    error TooLittle();
    error NoFreezeCredit();
    error PotNotLinked();
    error NoRenounce();
    error NothingPending();
    error TooLate();
    error SameKey();
    error BadTimings();

    constructor(
        address owner_,
        IERC20 rat_,
        address signer_,
        address guardian_,
        address sentinel_,
        address pot_,
        Limits memory l,
        Timings memory t
    ) Ownable(owner_) EIP712("RatRaceDistributor", "1") {
        testMode = _checkTimings(t);
        TIMELOCK = t.timelock;
        TIMELOCK_RAISE = t.timelockRaise;
        TIMELOCK_LONG = t.timelockLong;
        EXECUTION_WINDOW = t.executionWindow;
        PAUSE_MAX = t.pauseMax;
        PAUSE_PERIOD = t.pausePeriod;
        MIN_PAUSE = t.pauseMax < 1 hours ? t.pauseMax : 1 hours;
        uint64 maxDelay = t.pauseMax < 1 days ? t.pauseMax : 1 days;
        MAX_DELAY = maxDelay;
        if (address(rat_) == address(0)) revert ZeroAddress();
        if (l.outflowCap == 0 || l.burnCap == 0 || l.outflowCap > type(uint128).max || l.burnCap > type(uint128).max) revert TooMuch();
        if (l.outflowCap < MIN_DAILY_WITHDRAW) revert TooLittle(); // (the daily floor must fit under the cap)
        if (l.outflowCap > MAX_OUTFLOW_CAP) revert TooMuch();
        freezeCredit = t.pauseMax;
        freezeCreditAt = uint64(block.timestamp);
        rat = rat_;
        outflowCap = l.outflowCap;
        burnCap = l.burnCap;
        _setSigner(signer_);
        _setGuardian(guardian_);
        if (sentinel_ != address(0)) _setSentinel(sentinel_);
        if (pot_ == address(0)) revert ZeroAddress();
        pot = pot_;
        _setLimits(l.delay, l.maxStepWithdraw, l.maxStepSettle, l.maxBounty, maxDelay);
    }

    // ------------------------------------------------------------------ checkpoints

    /// @notice Publish the game's signed checkpoint: it becomes claimable after `delay`. Pays its bounty to the caller.
    /// @custom:security Who: anyone, with the game signer's signature. Delay: the checkpoint waits `delay` (10 minutes at least, MAX_DELAY at most) before claims. Limits: the steps maxStepWithdraw and maxStepSettle, the bounty maxBounty, outflowCap and burnCap in any 24 hours, an epoch at most MAX_EPOCH_AHEAD (an hour) ahead, never below the totals already active, fully backed by the RAT held. Checks: one pending at a time; vetoable during its delay by the guardian, the owner or the sentinel; refused while paused; reentrancy guard.
    function publish(
        uint64 epoch,
        bytes32 root,
        uint256 withdrawTotal,
        uint256 burnTotal,
        uint256 potTotal,
        uint256 bounty,
        bytes calldata signature
    ) public nonReentrant whenNotPaused {
        _activate();
        if (pending.activeAt != 0) revert PendingNotReady(); // one at a time: wait for it to activate
        if (epoch <= lastPublishedEpoch) revert StaleEpoch();
        // the epoch is the game's clock (10 minutes): one far ahead would hold the next ones back that long
        if (epoch > block.timestamp / EPOCH + MAX_EPOCH_AHEAD) revert EpochTooFar();
        if (potTotal != 0 && !potLinked) revert PotNotLinked(); // (a wrong pot address can never receive anything)
        if (withdrawTotal < active.withdrawTotal || burnTotal < active.burnTotal || potTotal < active.potTotal) revert TotalsDecrease();
        if (withdrawTotal - active.withdrawTotal > maxStepWithdraw) revert StepTooBig();
        if ((burnTotal - active.burnTotal) + (potTotal - active.potTotal) > maxStepSettle) revert StepTooBig();
        if (bounty > maxBounty) revert BountyTooBig();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CHECKPOINT_TYPEHASH, epoch, root, withdrawTotal, burnTotal, potTotal, bounty))
        );
        if (ECDSA.recover(digest, signature) != signer) revert BadSignature();

        // the bounty shrinks to what the day's paid window has left, so a busy day never blocks a
        // checkpoint; the event carries what was really paid (the game books that one)
        uint256 paidBounty = bounty;
        uint256 room = paidRoom();
        if (paidBounty > room) paidBounty = room;
        uint256 requiredReserve = (withdrawTotal - totalClaimed)
            + (burnTotal - burned) + (potTotal - potPaid) + paidBounty;
        if (rat.balanceOf(address(this)) < requiredReserve) revert InsufficientReserve();
        // the daily caps: what this checkpoint lets leave to wallets (withdrawals, the bounty paid), and
        // what it burns or sends to the pot (RAT that never reaches a wallet from here: under the burn cap)
        uint256 out = withdrawTotal - active.withdrawTotal;
        uint256 burn = (burnTotal - active.burnTotal) + (potTotal - active.potTotal);
        _spend(out + paidBounty, burn);
        pendingHour = block.timestamp / 1 hours;
        pendingSpent = Spent(uint128(out), uint128(burn)); // (the bounty is paid now: a veto cannot give it back)

        lastPublishedEpoch = epoch;
        pending = Checkpoint(epoch, uint64(block.timestamp) + delay, root, withdrawTotal, burnTotal, potTotal);
        pendingGen = signerGen;
        emit Published(epoch, root, withdrawTotal, burnTotal, potTotal, msg.sender, paidBounty);
        if (paidBounty != 0) {
            _paid(paidBounty);
            rat.safeTransfer(msg.sender, paidBounty);
        }
    }

    /// @notice Turn the pot's share on, once: `pot` must be a contract whose distributor() is this one.
    /// Until then checkpoints carry no pot share, so a wrong pot address never receives anything.
    /// @custom:security Who: anyone. Delay: none. Limits: once. Checks: the pot must name this distributor back.
    function confirmPot() external {
        if (potLinked) return;
        if (pot.code.length == 0) revert PotNotLinked();
        (bool ok, bytes memory r) = pot.staticcall(abi.encodeWithSignature("distributor()"));
        if (!ok || r.length != 32 || abi.decode(r, (address)) != address(this)) revert PotNotLinked();
        potLinked = true;
        emit PotLinked(pot);
    }

    /// @notice Promote the pending checkpoint once its delay is over: its burn goes to the dead address, the pot's share to the pot.
    /// @custom:security Who: anyone (publish and claim also do it). Delay: only after the checkpoint's delay. Limits: what the checkpoint counted under the daily caps at its publish. Checks: refused while paused; reentrancy guard.
    function activate() external nonReentrant whenNotPaused {
        _activate();
    }

    /// @notice Drop the pending checkpoint (a bad one: the game did not sign it, or a mistake). What it counted in the daily caps comes back.
    /// @custom:security Who: the guardian, the owner or the sentinel. Delay: before the checkpoint's delay is over; after it, only during a pause (players may already claim against it). Limits: each veto costs max(delay, 10 minutes) of the freeze credit (PAUSE_MAX, 4 days for real), or of the running pause. Checks: its signature can never be published again.
    function veto() external {
        _onlyFreezer();
        if (pending.activeAt == 0) revert NothingPending();
        bool inPause = paused();
        if (block.timestamp >= pending.activeAt && !inPause) revert TooLate();
        uint256 cost = delay < EPOCH ? EPOCH : delay;
        if (inPause) {
            if (uint256(pausedUntil) - block.timestamp < cost) revert NoFreezeCredit();
            pausedUntil -= uint64(cost);
        } else {
            _useFreeze(cost);
        }
        emit Vetoed(pending.epoch, msg.sender, cost, inPause ? pausedUntil : 0);
        // what the vetoed checkpoint counted in the daily caps comes back
        Spent storage h = spentInHour[pendingHour];
        h.out -= pendingSpent.out;
        h.burn -= pendingSpent.burn;
        delete pendingSpent;
        delete pending;
    }

    /// @dev Pause and veto: the guardian, the owner or the sentinel (when set: no sender is address 0).
    function _onlyFreezer() internal view {
        if (msg.sender != guardian && msg.sender != owner() && msg.sender != sentinel) revert NotGuardian();
    }

    function _activate() internal {
        Checkpoint memory p = pending;
        if (p.activeAt == 0 || block.timestamp < p.activeAt) return;
        previousRoot = activeGen == pendingGen ? active.root : bytes32(0);
        activeGen = pendingGen;
        active = p;
        delete pending;
        delete pendingSpent;
        uint256 burnNow = p.burnTotal - burned;
        uint256 potNow = p.potTotal - potPaid;
        burned = p.burnTotal;
        potPaid = p.potTotal;
        emit Activated(p.epoch, burnNow, potNow);
        if (burnNow != 0) rat.safeTransfer(DEAD, burnNow);
        if (potNow != 0) rat.safeTransfer(pot, potNow);
    }

    // ------------------------------------------------------------------ claims

    /// @notice Send `player` what they may withdraw. It pays what fits under the signed total and the day's paid window;
    /// the same proof pays the rest later, so a big withdrawal comes out over several days and is never stuck.
    /// @custom:security Who: anyone may submit it; the RAT always go to the proof's player. Delay: against the active checkpoint, after its delay. Limits: the signed withdrawTotal, and outflowCap paid to all wallets in any 24 hours, counted when paid. Checks: a Merkle proof of the active root (or the previous one, only if the same signer key signed it); refused while paused; reentrancy guard.
    function claim(address player, uint256 cumulative, bytes32[] calldata proof) public nonReentrant whenNotPaused {
        _activate();
        Checkpoint memory a = active;
        if (a.activeAt == 0) revert NoActiveCheckpoint();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(player, cumulative))));
        // the active root, or the one before it (a proof fetched just before a new one activated: a
        // player's cumulative only grows, so it pays less now and the rest with the next proof)
        if (!MerkleProof.verifyCalldata(proof, a.root, leaf) && !MerkleProof.verifyCalldata(proof, previousRoot, leaf)) revert BadProof();
        uint256 already = claimed[player];
        if (cumulative <= already) revert NothingToClaim();
        uint256 amount = cumulative - already;
        uint256 signedLeft = a.withdrawTotal > totalClaimed ? a.withdrawTotal - totalClaimed : 0;
        if (amount > signedLeft) amount = signedLeft;
        if (amount == 0) revert OverWithdrawTotal();
        // counted when paid, whatever the root says: a bad root cannot take more than the daily cap
        uint256 room = paidRoom();
        if (amount > room) amount = room;
        if (amount == 0) revert OverDailyCap();
        _paid(amount);
        claimed[player] = already + amount;
        totalClaimed += amount;
        emit Claimed(player, amount, already + amount, a.epoch);
        rat.safeTransfer(player, amount);
    }

    /// @notice Publish the new checkpoint (and take its bounty), then claim against the one already active, in one transaction.
    /// When somebody already published this epoch, it only claims.
    /// @custom:security Who: anyone. Delay: the new checkpoint waits its delay; the claim uses the active one. Limits: those of publish and claim. Checks: those of publish and claim.
    function publishAndClaim(
        uint64 epoch,
        bytes32 root,
        uint256 withdrawTotal,
        uint256 burnTotal,
        uint256 potTotal,
        uint256 bounty,
        bytes calldata signature,
        address player,
        uint256 cumulative,
        bytes32[] calldata proof
    ) external {
        if (epoch > lastPublishedEpoch) publish(epoch, root, withdrawTotal, burnTotal, potTotal, bounty, signature);
        claim(player, cumulative, proof);
    }

    /// @notice What a claim of `player` with `cumulative` would pay now: under the signed total and the day's paid window, 0 while paused.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: none. Checks: no proof check here (the claim checks it).
    function claimable(address player, uint256 cumulative) external view returns (uint256 amount) {
        if (paused()) return 0;
        uint256 already = claimed[player];
        if (cumulative <= already) return 0;
        amount = cumulative - already;
        Checkpoint memory a = pending.activeAt != 0 && block.timestamp >= pending.activeAt ? pending : active;
        uint256 signedLeft = a.withdrawTotal > totalClaimed ? a.withdrawTotal - totalClaimed : 0;
        if (amount > signedLeft) amount = signedLeft;
        uint256 room = paidRoom();
        if (amount > room) amount = room;
    }

    /// @notice RAT the contract owes per the latest checkpoint (pending one included): players, burns and the pot.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: the RAT above it back the rewards to come; nothing can burn or take them. Checks: none.
    function owed() public view returns (uint256) {
        Checkpoint memory c = pending.activeAt != 0 ? pending : active;
        return (c.withdrawTotal - totalClaimed) + (c.burnTotal - burned) + (c.potTotal - potPaid);
    }

    // ------------------------------------------------------------------ status

    struct Status {
        uint256 balance; // RAT held
        uint256 owed; // what the latest checkpoint owes (players, burns, the pot)
        uint256 surplus; // balance beyond owed: the reserve for the rewards to come
        uint256 outflowCap;
        uint256 burnCap;
        uint256 outflowRoom; // left today to publish to wallets
        uint256 burnRoom; // left today to burn or send to the pot
        uint256 paidRoom; // left today to pay to wallets (claims, bounties)
        uint64 delay;
        uint256 maxStepWithdraw;
        uint256 maxStepSettle;
        uint256 maxBounty;
        bool paused;
        uint64 pausedUntil;
        uint256 freezeCredit; // seconds of pause or veto available now
        address owner;
        address pendingOwner;
        bool testMode; // a test deployment: a time rule shorter than the real one
        address signer;
        address guardian;
        address sentinel;
        address pot;
        bool potLinked;
        uint256 potPaid;
        uint256 burned;
        uint256 totalClaimed;
        uint64 epochNow;
        uint64 lastPublishedEpoch;
        Checkpoint active;
        Checkpoint pending;
    }

    /// @notice Everything about this contract in one call (for the explorer and the economy page), testMode included.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: none. Checks: none.
    function status() external view returns (Status memory s) {
        s.balance = rat.balanceOf(address(this));
        s.owed = owed();
        s.surplus = s.balance > s.owed ? s.balance - s.owed : 0;
        s.outflowCap = outflowCap;
        s.burnCap = burnCap;
        s.outflowRoom = outflowRoom();
        s.burnRoom = burnRoom();
        s.paidRoom = paidRoom();
        s.delay = delay;
        s.maxStepWithdraw = maxStepWithdraw;
        s.maxStepSettle = maxStepSettle;
        s.maxBounty = maxBounty;
        s.paused = paused();
        s.pausedUntil = pausedUntil;
        s.freezeCredit = freezeCreditNow();
        s.owner = owner();
        s.pendingOwner = pendingOwner();
        s.testMode = testMode;
        s.signer = signer;
        s.guardian = guardian;
        s.sentinel = sentinel;
        s.pot = pot;
        s.potLinked = potLinked;
        s.potPaid = potPaid;
        s.burned = burned;
        s.totalClaimed = totalClaimed;
        s.epochNow = uint64(block.timestamp / EPOCH);
        s.lastPublishedEpoch = lastPublishedEpoch;
        s.active = active;
        s.pending = pending;
    }

    // ------------------------------------------------------------------ daily caps

    /// @notice RAT a checkpoint published now may still let leave to wallets (withdrawals and the bounty).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: outflowCap minus what the last 25 clock hours published. Checks: none.
    function outflowRoom() public view returns (uint256) {
        (uint256 out, ) = _window();
        return out >= outflowCap ? 0 : outflowCap - out;
    }

    /// @notice RAT that may still be burned or sent to the pot now (checkpoint burns and the pot's share).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: burnCap minus what the last 25 clock hours counted. Checks: none.
    function burnRoom() public view returns (uint256) {
        (, uint256 burn) = _window();
        return burn >= burnCap ? 0 : burnCap - burn;
    }

    function _window() internal view returns (uint256 out, uint256 burn) {
        uint256 h = block.timestamp / 1 hours;
        for (uint256 i = 0; i < WINDOW_HOURS && i <= h; i++) {
            Spent memory s = spentInHour[h - i];
            out += s.out;
            burn += s.burn;
        }
    }

    function _spend(uint256 out, uint256 burn) internal {
        if (out == 0 && burn == 0) return;
        if (out > outflowRoom() || burn > burnRoom()) revert OverDailyCap();
        Spent storage s = spentInHour[block.timestamp / 1 hours];
        s.out += uint128(out);
        s.burn += uint128(burn);
    }

    /// @notice RAT that may still be paid to wallets now (claims and bounties) under the daily cap.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: outflowCap minus what the last 25 clock hours paid. Checks: none.
    function paidRoom() public view returns (uint256) {
        uint256 h = block.timestamp / 1 hours;
        uint256 paid;
        for (uint256 i = 0; i < WINDOW_HOURS && i <= h; i++) paid += paidInHour[h - i];
        return paid >= outflowCap ? 0 : outflowCap - paid;
    }

    /// @dev Count what leaves to wallets now (the callers keep it within paidRoom()).
    function _paid(uint256 amount) internal {
        paidInHour[block.timestamp / 1 hours] += amount;
    }

    // ------------------------------------------------------------------ admin

    /// @notice Announce a change on chain with its exact call: a new signer, sentinel or owner, looser limits, a new
    /// outflow cap or a new guardian. It applies only through execute, after its wait.
    /// @custom:security Who: the owner (the team Safe). Delay: TIMELOCK (3 days for real) for a signer, sentinel, owner or looser limits; TIMELOCK_RAISE (7 days for real) to raise the outflow cap; TIMELOCK_LONG (14 days for real) for a guardian. Limits: only those six calls, exactly encoded. Checks: the guardian can cancel it (never its own replacement); the Scheduled event shows the call and when it may apply.
    function schedule(bytes calldata data) external onlyOwner returns (bytes32 id) {
        bytes4 sel = _check(data);
        id = keccak256(data);
        bool long = sel == SET_OUTFLOW_CAP && abi.decode(data[4:], (uint256)) > outflowCap;
        uint256 at = block.timestamp + (sel == SET_GUARDIAN ? TIMELOCK_LONG : long ? TIMELOCK_RAISE : TIMELOCK);
        scheduledAt[id] = at;
        scheduledCall[id] = sel;
        scheduledLong[id] = long;
        emit Scheduled(id, data, at);
    }

    /// @notice Drop a scheduled change before it is executed.
    /// @custom:security Who: the owner or the guardian. Delay: none. Limits: the guardian cannot drop its own replacement, so a stolen guardian key can always be changed. Checks: none.
    function cancel(bytes32 id) external {
        address owner_ = owner();
        if (msg.sender != guardian && msg.sender != owner_) revert NotGuardian();
        if (scheduledAt[id] == 0) revert NotScheduled();
        if (msg.sender != owner_ && scheduledCall[id] == SET_GUARDIAN) revert NotGuardian();
        delete scheduledAt[id];
        delete scheduledCall[id];
        delete scheduledLong[id];
        emit Cancelled(id, msg.sender);
    }

    /// @notice Apply a scheduled change once its wait is over. A new owner then has EXECUTION_WINDOW to accept.
    /// @custom:security Who: the owner. Delay: after its wait (TIMELOCK, TIMELOCK_RAISE or TIMELOCK_LONG), within EXECUTION_WINDOW (14 days for real) after it, or it lapses. Limits: limits keep MIN_DAILY_WITHDRAW (24,000 RAT) a day possible; nothing moves RAT. Checks: a cut scheduled as such cannot become a raise; reentrancy guard.
    function execute(bytes calldata data) external onlyOwner nonReentrant {
        bytes32 id = keccak256(data);
        uint256 at = scheduledAt[id];
        if (at == 0) revert NotScheduled();
        if (block.timestamp < at) revert NotReady();
        if (block.timestamp > at + EXECUTION_WINDOW) revert Expired(); // schedule it again, in public
        bool long = scheduledLong[id];
        delete scheduledAt[id];
        delete scheduledCall[id];
        delete scheduledLong[id];
        emit Executed(id);
        bytes4 sel = _check(data);
        if (sel == SET_SIGNER) _setSigner(abi.decode(data[4:], (address)));
        else if (sel == SET_SENTINEL) _setSentinel(abi.decode(data[4:], (address)));
        else if (sel == SET_OWNER) {
            // the new owner accepts within EXECUTION_WINDOW (cancelOwnerOffer drops it sooner)
            address next = abi.decode(data[4:], (address));
            if (next == address(0)) revert ZeroAddress();
            ownerOfferUntil = uint64(block.timestamp + EXECUTION_WINDOW);
            Ownable2Step.transferOwnership(next);
            emit OwnerOffered(next, ownerOfferUntil);
        } else if (sel == SET_OUTFLOW_CAP) {
            uint256 cap = abi.decode(data[4:], (uint256));
            if (cap > outflowCap && !long) revert NeedsTimelock(); // (scheduled as a cut, the cap fell meanwhile)
            _setOutflowCap(cap);
        }
        else if (sel == SET_GUARDIAN) _setGuardian(abi.decode(data[4:], (address)));
        else {
            (uint64 d, uint256 w, uint256 s, uint256 b) = abi.decode(data[4:], (uint64, uint256, uint256, uint256));
            _setLimits(d, w, s, b, MAX_DELAY);
        }
    }

    function _check(bytes calldata data) internal pure returns (bytes4 sel) {
        if (data.length < 4) revert UnknownCall();
        sel = bytes4(data[:4]);
        bool known = sel == SET_SIGNER || sel == SET_GUARDIAN || sel == SET_LIMITS || sel == SET_OUTFLOW_CAP || sel == SET_OWNER || sel == SET_SENTINEL;
        if (!known || data.length != 4 + (sel == SET_LIMITS ? 128 : 32)) revert UnknownCall();
    }

    // ------------------------------------------------------------------ pause

    /// @notice True while paused: no publishing, activating or claiming. A pause always ends by itself.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: a pause lasts the freeze credit at most (PAUSE_MAX, 4 days for real). Checks: none.
    function paused() public view returns (bool) {
        return block.timestamp < pausedUntil;
    }

    modifier whenNotPaused() {
        if (paused()) revert EnforcedPause();
        _;
    }

    /// @notice Seconds of pause or veto available now: nobody can keep the withdrawals frozen.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: PAUSE_MAX (4 days for real) at most, refilled at PAUSE_MAX per PAUSE_PERIOD (30 days for real) of open withdrawals, never while paused. Checks: none.
    function freezeCreditNow() public view returns (uint256 credit) {
        credit = freezeCredit;
        uint256 from = freezeCreditAt;
        if (pausedUntil > from) from = pausedUntil;
        if (block.timestamp > from) credit += ((block.timestamp - from) * PAUSE_MAX) / PAUSE_PERIOD;
        if (credit > PAUSE_MAX) credit = PAUSE_MAX;
    }

    function _useFreeze(uint256 s) internal {
        uint256 credit = freezeCreditNow();
        if (credit < s) revert NoFreezeCredit();
        freezeCredit = uint64(credit - s);
        freezeCreditAt = uint64(block.timestamp);
    }

    /// @notice Stop publishing, activating and claiming for as long as the freeze credit lasts; it ends by itself.
    /// @custom:security Who: the guardian, the owner or the sentinel. Delay: none. Limits: uses the whole freeze credit (PAUSE_MAX, 4 days for real, at most); needs MIN_PAUSE (1 hour for real) of it. Checks: a running pause can never be extended; a pause never moves RAT.
    function pause() external {
        _onlyFreezer();
        if (paused()) revert EnforcedPause();
        uint256 credit = freezeCreditNow();
        if (credit < MIN_PAUSE) revert NoFreezeCredit();
        freezeCredit = 0;
        freezeCreditAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp + credit);
        emit Paused(msg.sender, pausedUntil);
    }

    /// @notice End the pause now; what it had left goes back to the freeze credit.
    /// @custom:security Who: the owner. Delay: none. Limits: none. Checks: none.
    function unpause() external onlyOwner {
        if (!paused()) revert ExpectedPause();
        uint256 back = uint256(pausedUntil) - block.timestamp;
        freezeCredit = uint64(back);
        freezeCreditAt = uint64(block.timestamp);
        pausedUntil = uint64(block.timestamp);
        emit Unpaused(msg.sender, back);
    }

    /// @notice Remove the sentinel at once: a leaked sentinel key can no longer pause or veto.
    /// @custom:security Who: the owner or the guardian. Delay: none (a new sentinel waits TIMELOCK, 3 days for real). Limits: none. Checks: none.
    function dropSentinel() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _setSentinel(address(0));
    }

    /// @notice Disabled: without an owner nobody could unpause, replace a key or fix the limits.
    /// @custom:security Who: nobody (always reverts). Delay: none. Limits: none. Checks: none.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    /// @notice Disabled as a direct call: a new owner goes through schedule(transferOwnership(newOwner)), then accepts.
    /// @custom:security Who: nobody directly (always reverts). Delay: TIMELOCK (3 days for real) through schedule then execute. Limits: none. Checks: the guardian can cancel the scheduled transfer.
    function transferOwnership(address) public pure override {
        revert NeedsTimelock();
    }

    /// @notice The new owner takes over.
    /// @custom:security Who: the offered owner only. Delay: within EXECUTION_WINDOW (14 days for real) of the executed transfer, or the offer lapses. Limits: none. Checks: the owner can withdraw the offer before (cancelOwnerOffer).
    function acceptOwnership() public override {
        if (block.timestamp > ownerOfferUntil) revert Expired();
        ownerOfferUntil = 0;
        super.acceptOwnership();
    }

    /// @notice Withdraw an owner offer not accepted yet, at once.
    /// @custom:security Who: the owner. Delay: none. Limits: none. Checks: none.
    function cancelOwnerOffer() external onlyOwner {
        ownerOfferUntil = 0;
        Ownable2Step.transferOwnership(address(0));
    }

    /// @dev The outflow cap: under MAX_OUTFLOW_CAP, at least the daily floor, never under the steps.
    function _setOutflowCap(uint256 cap) internal {
        if (cap > MAX_OUTFLOW_CAP || cap < maxStepWithdraw || cap < maxBounty) revert TooMuch();
        if (cap < MIN_DAILY_WITHDRAW) revert TooLittle();
        outflowCap = cap;
        emit OutflowCapSet(cap);
    }

    /// @notice Tighten the limits at once: a longer delay, lower steps or a lower bounty. Loosening any goes through schedule.
    /// @custom:security Who: the owner. Delay: none (tightening only; loosening waits TIMELOCK, 3 days for real). Limits: the delay MIN_DELAY (10 minutes) to MAX_DELAY (1 day for real); steps under the daily caps; MIN_DAILY_WITHDRAW (24,000 RAT) a day always possible. Checks: none.
    function setLimits(uint64 delay_, uint256 maxStepWithdraw_, uint256 maxStepSettle_, uint256 maxBounty_) external onlyOwner {
        if (delay_ < delay || maxStepWithdraw_ > maxStepWithdraw || maxStepSettle_ > maxStepSettle || maxBounty_ > maxBounty) revert NeedsTimelock();
        _setLimits(delay_, maxStepWithdraw_, maxStepSettle_, maxBounty_, MAX_DELAY);
    }

    function _setSigner(address s) internal {
        if (s == address(0)) revert ZeroAddress();
        if (s == sentinel) revert SameKey();
        signer = s;
        signerGen++;
        emit SignerSet(s);
    }

    function _setGuardian(address g) internal {
        if (g == address(0)) revert ZeroAddress();
        guardian = g;
        emit GuardianSet(g);
    }

    /// @dev The sentinel may be address 0 (none); never the signer (a leaked signer could then veto
    /// the honest checkpoints and pause).
    function _setSentinel(address s) internal {
        if (s != address(0) && s == signer) revert SameKey();
        sentinel = s;
        emit SentinelSet(s);
    }

    /// @dev maxDelay: MAX_DELAY (passed in: the constructor cannot read an immutable from a function).
    function _setLimits(uint64 delay_, uint256 maxStepWithdraw_, uint256 maxStepSettle_, uint256 maxBounty_, uint64 maxDelay) internal {
        if (delay_ > maxDelay) revert TooMuch();
        if (delay_ < MIN_DELAY) revert TooLittle(); // no delay, no veto window

        // the steps stay under the daily caps fixed at deploy
        if (maxStepWithdraw_ > outflowCap || maxBounty_ > outflowCap || maxStepSettle_ > burnCap) revert TooMuch();
        // one checkpoint at a time, one an epoch at most: a step every max(delay, EPOCH) must allow
        // MIN_DAILY_WITHDRAW a day, so nobody can slow the withdrawals to a trickle
        uint256 period = delay_ < EPOCH ? EPOCH : delay_;
        if (maxStepWithdraw_ * 1 days < MIN_DAILY_WITHDRAW * period) revert TooLittle();
        delay = delay_;
        maxStepWithdraw = maxStepWithdraw_;
        maxStepSettle = maxStepSettle_;
        maxBounty = maxBounty_;
        emit LimitsSet(delay_, maxStepWithdraw_, maxStepSettle_, maxBounty_);
    }
}
