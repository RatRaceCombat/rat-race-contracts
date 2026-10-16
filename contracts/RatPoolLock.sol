// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The part of HyperSwap's V3 positions contract (a Uniswap V3 NonfungiblePositionManager) this lock uses.
interface IPositions {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

/**
 * @title RatPoolLock
 * @notice Locks liquidity of the RAT/WHYPE pool on HyperSwap, while its fees stay with whoever locked it. A
 * position comes in through the positions contract's safeTransferFrom with its mode in the data, and whoever sends it
 * becomes its holder:
 *   - PERMANENT (abi.encode(uint8(1))): it never leaves (the project's liquidity);
 *   - NOTICE (abi.encode(uint8(2))): its holder may take it back, but only after announcing it on chain
 *     (`announceUnlock`, public) and waiting `UNLOCK_DELAY` (14 days for real), then within `UNLOCK_WINDOW` (7 days
 *     for real) or the announcement lapses. Its holder may also make it permanent, for good.
 * A position sent without a mode is refused: nobody locks a position for good by mistake. A plain transferFrom
 * (not safeTransferFrom) bypasses this contract: such a position stays here for good with no holder and no fees.
 * The holder should be a Safe (a lost key strands the fees, and the liquidity of a NOTICE position) or a wallet that
 * can receive NFTs: unlock sends the position back with safeTransferFrom. Fees arrive as WHYPE and RAT.
 * The holder alone collects the position's fees (`collectFees`, always to itself) and may hand the position's rights
 * to another wallet in two steps (the new wallet accepts: a typo never loses it). Nothing else can take a position
 * out: no function removes liquidity, approves or burns a position, no admin, no upgrade. Anybody may still add
 * liquidity to a locked position through the positions contract: it is locked with the rest.
 *
 * The two durations are set at deploy and never change: the real values are 14 days and 7 days; other ones make
 * `testMode()` true (a TEST deployment first, then the real one, like the other Rat Race contracts).
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here a position is locked by sending it, announceUnlock/unlock take a NOTICE position back after the public
 * wait, and offerHolder/acceptHolder hand a position's rights over.
 * @custom:security Who: anybody locks a position of the RAT pool and becomes its holder; only a position's holder
 * collects its fees (to itself) or, for a NOTICE position, announces and executes its unlock. Delay: an unlock waits
 * UNLOCK_DELAY (14 days for real) after its public announcement, then lapses after UNLOCK_WINDOW (7 days for real); a
 * PERMANENT position never leaves. Limits: no admin, no upgrade, no other way out. Checks: the position comes from the
 * positions contract, is in the RAT pool (its two tokens and fee) and has liquidity; its mode is given.
 */
contract RatPoolLock is IERC721Receiver, ReentrancyGuard {
    /// @notice A position's mode: never leaves.
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: none. Checks: none.
    uint8 public constant PERMANENT = 1;
    /// @notice A position's mode: leaves only after a public announcement and UNLOCK_DELAY.
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: none. Checks: none.
    uint8 public constant NOTICE = 2;
    /// @notice The real wait between an unlock's announcement and the unlock (14 days).
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: none. Checks: testMode when the deploy's differs.
    uint64 public constant REAL_UNLOCK_DELAY = 14 days;
    /// @notice The real window to execute a ready unlock before it lapses (7 days).
    /// @custom:security Who: fixed in the code. Delay: never changes. Limits: none. Checks: testMode when the deploy's differs.
    uint64 public constant REAL_UNLOCK_WINDOW = 7 days;

    /// @notice HyperSwap's V3 positions contract (the position NFTs).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: the only NFT accepted. Checks: none.
    IPositions public immutable positionManager;
    /// @notice The pool's first token (WHYPE on HyperEVM).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: a position must hold it. Checks: none.
    address public immutable token0;
    /// @notice The pool's second token (RAT on HyperEVM).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: a position must hold it. Checks: none.
    address public immutable token1;
    /// @notice The pool's fee tier (3000: 0.30%).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: a position must be in it. Checks: none.
    uint24 public immutable fee;
    /// @notice The wait between an unlock's announcement and the unlock (14 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: over 0. Checks: testMode when not 14 days.
    uint64 public immutable UNLOCK_DELAY;
    /// @notice How long a ready unlock can be executed before its announcement lapses (7 days for real).
    /// @custom:security Who: fixed at deploy. Delay: never changes. Limits: over 0. Checks: testMode when not 7 days.
    uint64 public immutable UNLOCK_WINDOW;

    /// @notice A locked position's holder: who sent it here (or whoever accepted its rights since); 0 once unlocked.
    /// @custom:security Who: set when the position arrives, then only by acceptHolder. Delay: none. Limits: its fees,
    /// and the unlock of a NOTICE position after the public wait. Checks: none.
    mapping(uint256 => address) public holder;
    /// @notice The wallet a holder offered the position's rights to (address 0: no offer).
    /// @custom:security Who: the position's holder. Delay: none; the new wallet accepts. Limits: none. Checks: none.
    mapping(uint256 => address) public pendingHolder;
    /// @notice A locked position's mode: PERMANENT (1) or NOTICE (2); 0 when not locked here.
    /// @custom:security Who: set when the position arrives; a NOTICE one may become PERMANENT, never back. Delay:
    /// none. Limits: none. Checks: none.
    mapping(uint256 => uint8) public mode;
    /// @notice When an announced unlock can be executed (0: none announced).
    /// @custom:security Who: the holder announces or cancels it. Delay: UNLOCK_DELAY after the announcement. Limits:
    /// lapses UNLOCK_WINDOW after it. Checks: NOTICE positions only.
    mapping(uint256 => uint64) public unlockReadyAt;
    /// @notice Every position ever locked here, in the order they came (see `mode` for those still here).
    /// @custom:security Who: anybody reads it. Delay: none. Limits: changes nothing. Checks: none.
    uint256[] public lockedIds;

    /// @dev A position locked: its id, its holder, its liquidity when it came, and its mode.
    event Locked(uint256 indexed tokenId, address indexed holder, uint128 liquidity, uint8 mode);
    /// @dev Fees collected to the holder.
    event FeesCollected(uint256 indexed tokenId, address indexed to, uint256 amount0, uint256 amount1);
    /// @dev An unlock announced in public: it can be executed from readyAt, until readyAt + UNLOCK_WINDOW.
    event UnlockAnnounced(uint256 indexed tokenId, address indexed holder, uint64 readyAt);
    /// @dev An announced unlock withdrawn by the holder.
    event UnlockCancelled(uint256 indexed tokenId);
    /// @dev The position went back to its holder.
    event Unlocked(uint256 indexed tokenId, address indexed to);
    /// @dev A NOTICE position became PERMANENT, for good.
    event MadePermanent(uint256 indexed tokenId);
    /// @dev A holder offered the position's rights to another wallet (to = 0: the offer is withdrawn).
    event HolderOffered(uint256 indexed tokenId, address indexed from, address indexed to);
    /// @dev The offered wallet accepted: it is the holder now.
    event HolderChanged(uint256 indexed tokenId, address indexed from, address indexed to);

    error NotPositionManager();
    error WrongPool();
    error NoLiquidity();
    error NoMode();
    error NotHolder();
    error NotOffered();
    error Permanent();
    error NotAnnounced();
    error TooSoon();
    error Lapsed();
    error ZeroAddress();
    error BadDurations();

    /// @notice The positions contract, the pool (its two tokens and fee tier) and the unlock's two durations, fixed for good.
    constructor(address positionManager_, address token0_, address token1_, uint24 fee_, uint64 unlockDelay_, uint64 unlockWindow_) {
        if (positionManager_ == address(0) || token0_ == address(0) || token1_ == address(0)) revert ZeroAddress();
        if (unlockDelay_ == 0 || unlockWindow_ == 0) revert BadDurations();
        positionManager = IPositions(positionManager_);
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        UNLOCK_DELAY = unlockDelay_;
        UNLOCK_WINDOW = unlockWindow_;
    }

    /// @notice A TEST deployment: other durations than the real 14 days and 7 days (fixed at deploy, for good).
    /// @custom:security Who: anybody reads it. Delay: none. Limits: changes nothing. Checks: the deploy's durations.
    function testMode() external view returns (bool) {
        return UNLOCK_DELAY != REAL_UNLOCK_DELAY || UNLOCK_WINDOW != REAL_UNLOCK_WINDOW;
    }

    /// @notice Locks a position sent here with safeTransferFrom and its mode in the data (abi.encode(uint8)): its
    /// sender becomes its holder.
    /// @custom:security Who: the positions contract calls it when a position is sent here, by anybody. Delay: none.
    /// Limits: a PERMANENT position never leaves; a NOTICE one only after the public wait. Checks: only the positions
    /// contract; only a position of the RAT pool (its two tokens and fee) with liquidity; a mode, PERMANENT or NOTICE.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata data) external returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        if (data.length != 32) revert NoMode();
        uint256 m = abi.decode(data, (uint256));
        if (m != PERMANENT && m != NOTICE) revert NoMode();
        if (from == address(0)) revert ZeroAddress(); // (a mint straight here carries no mode anyway)
        (, , address t0, address t1, uint24 f, , , uint128 liquidity, , , , ) = positionManager.positions(tokenId);
        if (t0 != token0 || t1 != token1 || f != fee) revert WrongPool();
        if (liquidity == 0) revert NoLiquidity();
        holder[tokenId] = from;
        mode[tokenId] = uint8(m);
        delete pendingHolder[tokenId];
        delete unlockReadyAt[tokenId];
        lockedIds.push(tokenId);
        emit Locked(tokenId, from, liquidity, uint8(m));
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Collects a locked position's fees (both tokens, all of them) to its holder.
    /// @custom:security Who: the position's holder only, and the fees go to it. Delay: none. Limits: the fees only,
    /// never the liquidity. Checks: the caller is the holder.
    function collectFees(uint256 tokenId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (msg.sender != holder[tokenId]) revert NotHolder();
        (amount0, amount1) = positionManager.collect(
            IPositions.CollectParams({tokenId: tokenId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max})
        );
        emit FeesCollected(tokenId, msg.sender, amount0, amount1);
    }

    /// @notice Announces in public that a NOTICE position will go back to its holder: from UNLOCK_DELAY (14 days for
    /// real) from now, within UNLOCK_WINDOW (7 days for real) after that, else it lapses. Announcing again restarts it.
    /// @custom:security Who: the position's holder only. Delay: the unlock waits UNLOCK_DELAY. Limits: never a
    /// PERMANENT position. Checks: the caller is the holder; the position is NOTICE.
    function announceUnlock(uint256 tokenId) external {
        if (msg.sender != holder[tokenId]) revert NotHolder();
        if (mode[tokenId] != NOTICE) revert Permanent();
        uint64 readyAt = uint64(block.timestamp) + UNLOCK_DELAY;
        unlockReadyAt[tokenId] = readyAt;
        emit UnlockAnnounced(tokenId, msg.sender, readyAt);
    }

    /// @notice Withdraws an announced unlock: the position stays locked.
    /// @custom:security Who: the position's holder only. Delay: none. Limits: none. Checks: an unlock is announced.
    function cancelUnlock(uint256 tokenId) external {
        if (msg.sender != holder[tokenId]) revert NotHolder();
        if (unlockReadyAt[tokenId] == 0) revert NotAnnounced();
        delete unlockReadyAt[tokenId];
        emit UnlockCancelled(tokenId);
    }

    /// @notice Sends a NOTICE position back to its holder, once its announced wait is over and before it lapses.
    /// @custom:security Who: the position's holder only, and the position goes to it. Delay: UNLOCK_DELAY after the
    /// public announcement. Limits: within UNLOCK_WINDOW after that, never a PERMANENT position. Checks: the caller is
    /// the holder; the unlock is announced, ready and not lapsed.
    function unlock(uint256 tokenId) external nonReentrant {
        if (msg.sender != holder[tokenId]) revert NotHolder();
        if (mode[tokenId] != NOTICE) revert Permanent();
        uint64 readyAt = unlockReadyAt[tokenId];
        if (readyAt == 0) revert NotAnnounced();
        if (block.timestamp < readyAt) revert TooSoon();
        if (block.timestamp >= uint256(readyAt) + UNLOCK_WINDOW) revert Lapsed();
        delete holder[tokenId];
        delete pendingHolder[tokenId];
        delete mode[tokenId];
        delete unlockReadyAt[tokenId];
        emit Unlocked(tokenId, msg.sender);
        positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    /// @notice Makes a NOTICE position PERMANENT, for good (an announced unlock is dropped).
    /// @custom:security Who: the position's holder only. Delay: none. Limits: one way, never back. Checks: the caller
    /// is the holder; the position is NOTICE.
    function makePermanent(uint256 tokenId) external {
        if (msg.sender != holder[tokenId]) revert NotHolder();
        if (mode[tokenId] != NOTICE) revert Permanent();
        mode[tokenId] = PERMANENT;
        delete unlockReadyAt[tokenId];
        emit MadePermanent(tokenId);
    }

    /// @notice Offers a position's rights (its fees, and the unlock of a NOTICE one) to another wallet, which must
    /// accept (address 0 withdraws the offer).
    /// @custom:security Who: the position's holder only. Delay: none; the new wallet accepts. Limits: never moves the
    /// position. Checks: the caller is the holder.
    function offerHolder(uint256 tokenId, address to) external {
        if (msg.sender != holder[tokenId]) revert NotHolder();
        pendingHolder[tokenId] = to;
        emit HolderOffered(tokenId, msg.sender, to);
    }

    /// @notice Accepts the rights of a position offered to the caller.
    /// @custom:security Who: the offered wallet only. Delay: none. Limits: never moves the position. Checks: an offer
    /// to the caller.
    function acceptHolder(uint256 tokenId) external {
        if (msg.sender != pendingHolder[tokenId]) revert NotOffered();
        address from = holder[tokenId];
        holder[tokenId] = msg.sender;
        delete pendingHolder[tokenId];
        emit HolderChanged(tokenId, from, msg.sender);
    }

    /// @notice How many positions were ever locked here (see `mode` for those still here).
    /// @custom:security Who: anybody reads it. Delay: none. Limits: changes nothing. Checks: none.
    function lockedCount() external view returns (uint256) {
        return lockedIds.length;
    }
}
