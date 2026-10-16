// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RatRaceVault
 * @notice Token custody for Rat Race Combat on HyperEVM. One code, two deployments:
 *         - USDC vault: players deposit USDC and get rGems in the game, withdraw rGems as USDC
 *         - RAT vault: RAT rewards are claimed here, RAT is deposited to buy suits and the RAT
 *           spent on suits is burned (burnTreasury)
 *
 * Flow
 *  - deposit / depositWithPermit: permissionless; the game server watches `Deposited`.
 *  - withdraw: the server debits the in-game balance and signs an EIP-712 voucher bound to the
 *    player, amount, nonce, deadline, chain id and this contract; the player submits it.
 *
 * Security model ("no single key can empty the vault")
 *  - owner: a Safe multisig behind a TimelockController (admin changes are delayed and public)
 *  - signer: backend hot key (HSM/KMS) signing vouchers — single-use, expiring
 *  - cosigner: independent risk service/manual approval; required above coSignThresholdGems
 *  - guardian: can pause instantly (circuit breaker) but never unpause nor move funds
 *  - per-player and global daily withdrawal caps bound the loss if the signer is compromised
 *  - tokens with transfer fees/rebasing are rejected (the vault must receive exact amounts)
 *  - no upgradeability, no delegatecall, no arbitrary external calls; CEI + ReentrancyGuard
 */
contract RatRaceVault is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address player,uint256 gems,uint256 nonce,uint256 deadline)");
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint16 public constant MAX_FEE_BPS = 1_000; // 10%
    uint256 public constant MAX_GEMS_PER_TX = 1_000_000;

    struct Config {
        address owner;
        IERC20 token;
        address signer;
        address cosigner; // 0 = co-signing disabled
        address guardian;
        address feeWallet;
        uint256 gemPrice; // token units per in-game unit
        uint16 depositFeeBps;
        uint256 dailyLimitGems; // per player per UTC day (0 = unlimited)
        uint256 globalDailyLimitGems; // all players per UTC day (0 = unlimited)
        uint256 coSignThresholdGems; // withdrawals >= this need the cosigner (0 = never)
    }

    /// @notice Payment token (USDC or RAT).
    IERC20 public immutable token;
    /// @notice Price of one in-game unit (rGem, or 1 RAT) in token units.
    uint256 public immutable gemPrice;

    address public signer;
    address public cosigner;
    address public guardian;
    address public feeWallet;
    uint16 public depositFeeBps;
    uint256 public dailyLimitGems;
    uint256 public globalDailyLimitGems;
    uint256 public coSignThresholdGems;

    mapping(uint256 => bool) public usedNonces;
    mapping(address => uint256) public withdrawnGemsInDay;
    mapping(address => uint256) public lastWithdrawDay;
    uint256 public globalWithdrawnInDay;
    uint256 public globalWithdrawDay;

    event Deposited(address indexed player, uint256 gems, uint256 paid, uint256 fee);
    event Withdrawn(address indexed player, uint256 gems, uint256 amount, uint256 indexed nonce);
    event Funded(address indexed from, uint256 amount);
    event NonceCancelled(uint256 indexed nonce);
    event SignerUpdated(address signer);
    event CosignerUpdated(address cosigner, uint256 thresholdGems);
    event GuardianUpdated(address guardian);
    event FeeUpdated(address feeWallet, uint16 feeBps);
    event DailyLimitUpdated(uint256 perPlayerGems, uint256 globalGems);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event Burned(uint256 amount);

    error ZeroAddress();
    error InvalidGemCount();
    error FeeTooHigh();
    error VoucherExpired();
    error NonceUsed();
    error InvalidSignature();
    error CosignatureRequired();
    error DailyLimitExceeded(uint256 remainingGems);
    error GlobalLimitExceeded(uint256 remainingGems);
    error InsufficientLiquidity();
    error UnsupportedToken();
    error Unauthorized();
    error SameKey();

    constructor(Config memory c) EIP712("RatRaceVault", "1") Ownable(c.owner) {
        if (address(c.token) == address(0) || c.signer == address(0) || c.feeWallet == address(0)) revert ZeroAddress();
        if (c.gemPrice == 0) revert InvalidGemCount();
        if (c.depositFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (c.cosigner != address(0) && c.cosigner == c.signer) revert SameKey();
        token = c.token;
        gemPrice = c.gemPrice;
        signer = c.signer;
        cosigner = c.cosigner;
        guardian = c.guardian;
        feeWallet = c.feeWallet;
        depositFeeBps = c.depositFeeBps;
        dailyLimitGems = c.dailyLimitGems;
        globalDailyLimitGems = c.globalDailyLimitGems;
        coSignThresholdGems = c.coSignThresholdGems;
    }

    // ---------------------------------------------------------------- player

    /// @notice Total token amount pulled for `gems`, and the fee part of it.
    function quoteDeposit(uint256 gems) public view returns (uint256 total, uint256 fee) {
        uint256 base = gems * gemPrice;
        fee = (base * depositFeeBps) / 10_000;
        total = base + fee;
    }

    function deposit(uint256 gems) external whenNotPaused nonReentrant {
        _deposit(msg.sender, gems);
    }

    /// @notice One-transaction deposit with an EIP-2612 permit (USDC supports it).
    ///         A front-run permit is tolerated as long as the allowance is in place.
    function depositWithPermit(uint256 gems, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
    {
        (uint256 total,) = quoteDeposit(gems);
        try IERC20Permit(address(token)).permit(msg.sender, address(this), total, deadline, v, r, s) {} catch {}
        _deposit(msg.sender, gems);
    }

    /**
     * @notice Gasless deposit: anyone (the game's relayer) submits the player's EIP-2612 permit
     *         and the vault pulls exactly quoteDeposit(gems) from the player, crediting the player.
     *         The permit must succeed here: it is the player's fresh authorization for this exact
     *         amount, so a relayer can neither change the amount nor spend an older allowance.
     */
    function depositWithPermitFor(address player, uint256 gems, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        whenNotPaused
        nonReentrant
    {
        (uint256 total,) = quoteDeposit(gems);
        IERC20Permit(address(token)).permit(player, address(this), total, deadline, v, r, s);
        _deposit(player, gems);
    }

    /**
     * @notice Redeem a server voucher. `cosignature` is only checked (and required) for
     *         withdrawals at or above coSignThresholdGems; pass empty bytes otherwise.
     */
    function withdraw(uint256 gems, uint256 nonce, uint256 deadline, bytes calldata signature, bytes calldata cosignature)
        external
        whenNotPaused
        nonReentrant
    {
        _withdraw(msg.sender, gems, nonce, deadline, signature, cosignature);
    }

    /// @notice Gasless redeem: the voucher is bound to `player` and the tokens always go to
    ///         `player`, so anyone (the game's relayer) may submit it on their behalf.
    function withdrawFor(address player, uint256 gems, uint256 nonce, uint256 deadline, bytes calldata signature, bytes calldata cosignature)
        external
        whenNotPaused
        nonReentrant
    {
        _withdraw(player, gems, nonce, deadline, signature, cosignature);
    }

    function _withdraw(address player, uint256 gems, uint256 nonce, uint256 deadline, bytes calldata signature, bytes calldata cosignature)
        private
    {
        if (player == address(0)) revert ZeroAddress();
        if (gems == 0 || gems > MAX_GEMS_PER_TX) revert InvalidGemCount();
        if (block.timestamp > deadline) revert VoucherExpired();
        if (usedNonces[nonce]) revert NonceUsed();

        bytes32 digest = withdrawDigest(player, gems, nonce, deadline);
        if (ECDSA.recover(digest, signature) != signer) revert InvalidSignature();
        if (coSignThresholdGems != 0 && gems >= coSignThresholdGems) {
            if (cosigner == address(0) || cosignature.length == 0) revert CosignatureRequired();
            if (ECDSA.recover(digest, cosignature) != cosigner) revert InvalidSignature();
        }

        usedNonces[nonce] = true;
        _consumeDailyLimits(player, gems);

        uint256 amount = gems * gemPrice;
        if (token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

        emit Withdrawn(player, gems, amount, nonce);
        token.safeTransfer(player, amount);
    }

    /// @notice EIP-712 digest a voucher (and its cosignature) signs.
    function withdrawDigest(address player, uint256 gems, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, player, gems, nonce, deadline)));
    }

    /// @notice Units `player` can still withdraw today (type(uint256).max when unlimited).
    function remainingDailyGems(address player) external view returns (uint256) {
        uint256 p = type(uint256).max;
        if (dailyLimitGems != 0) {
            uint256 used = lastWithdrawDay[player] == _today() ? withdrawnGemsInDay[player] : 0;
            p = used >= dailyLimitGems ? 0 : dailyLimitGems - used;
        }
        uint256 g = remainingGlobalGems();
        return p < g ? p : g;
    }

    function remainingGlobalGems() public view returns (uint256) {
        if (globalDailyLimitGems == 0) return type(uint256).max;
        uint256 used = globalWithdrawDay == _today() ? globalWithdrawnInDay : 0;
        return used >= globalDailyLimitGems ? 0 : globalDailyLimitGems - used;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // -------------------------------------------------------------- treasury

    /// @notice Add liquidity / promo funds (or the RAT rewards pool).
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidGemCount();
        _pullExact(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    // ----------------------------------------------------------------- admin

    /// @notice Invalidate an issued voucher (owner, signer or guardian).
    function cancelNonce(uint256 nonce) external {
        if (msg.sender != owner() && msg.sender != signer && msg.sender != guardian) revert Unauthorized();
        usedNonces[nonce] = true;
        emit NonceCancelled(nonce);
    }

    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        if (signer_ == cosigner) revert SameKey();
        signer = signer_;
        emit SignerUpdated(signer_);
    }

    function setCosigner(address cosigner_, uint256 thresholdGems) external onlyOwner {
        if (cosigner_ != address(0) && cosigner_ == signer) revert SameKey();
        cosigner = cosigner_;
        coSignThresholdGems = thresholdGems;
        emit CosignerUpdated(cosigner_, thresholdGems);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    function setFee(address feeWallet_, uint16 feeBps) external onlyOwner {
        if (feeWallet_ == address(0)) revert ZeroAddress();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeWallet = feeWallet_;
        depositFeeBps = feeBps;
        emit FeeUpdated(feeWallet_, feeBps);
    }

    function setDailyLimits(uint256 perPlayerGems, uint256 globalGems) external onlyOwner {
        dailyLimitGems = perPlayerGems;
        globalDailyLimitGems = globalGems;
        emit DailyLimitUpdated(perPlayerGems, globalGems);
    }

    /// @notice Circuit breaker: the guardian (or owner) freezes deposits and withdrawals.
    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert Unauthorized();
        _pause();
    }

    /// @notice Only the (timelocked) owner can resume.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Move house revenue out of the vault. Off-chain accounting must keep player
    ///         balances covered before calling this (owner = timelocked multisig).
    function withdrawTreasury(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();
        emit TreasuryWithdrawn(to, amount);
        token.safeTransfer(to, amount);
    }

    /// @notice RAT vault: burn the RAT players spent on suits.
    function burnTreasury(uint256 amount) external onlyOwner nonReentrant {
        if (token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();
        emit Burned(amount);
        token.safeTransfer(BURN_ADDRESS, amount);
    }

    // -------------------------------------------------------------- internal

    function _deposit(address player, uint256 gems) private {
        if (gems == 0 || gems > MAX_GEMS_PER_TX) revert InvalidGemCount();
        (uint256 total, uint256 fee) = quoteDeposit(gems);
        emit Deposited(player, gems, total, fee);
        _pullExact(player, address(this), total - fee);
        if (fee > 0) token.safeTransferFrom(player, feeWallet, fee);
    }

    /// @dev Reject fee-on-transfer / rebasing tokens: the vault must receive exactly `amount`.
    function _pullExact(address from, address to, uint256 amount) private {
        uint256 before = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        if (token.balanceOf(to) - before != amount) revert UnsupportedToken();
    }

    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function _consumeDailyLimits(address player, uint256 gems) private {
        uint256 day = _today();
        if (dailyLimitGems != 0) {
            if (lastWithdrawDay[player] != day) {
                lastWithdrawDay[player] = day;
                withdrawnGemsInDay[player] = 0;
            }
            uint256 used = withdrawnGemsInDay[player];
            if (used + gems > dailyLimitGems) revert DailyLimitExceeded(used >= dailyLimitGems ? 0 : dailyLimitGems - used);
            withdrawnGemsInDay[player] = used + gems;
        }
        if (globalDailyLimitGems != 0) {
            if (globalWithdrawDay != day) {
                globalWithdrawDay = day;
                globalWithdrawnInDay = 0;
            }
            uint256 g = globalWithdrawnInDay;
            if (g + gems > globalDailyLimitGems) revert GlobalLimitExceeded(g >= globalDailyLimitGems ? 0 : globalDailyLimitGems - g);
            globalWithdrawnInDay = g + gems;
        }
    }
}
