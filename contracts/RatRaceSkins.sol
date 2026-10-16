// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev The permanent collection this shop mints into (RatRaceSuits).
interface IRatRaceSuits {
    function editions(uint256 id) external view returns (uint64 cap, uint64 minted, uint64 reserved, bool vault);
    function claimUsed(bytes32 claimId) external view returns (bool);
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory);
    function testMode() external view returns (bool);
    function setCap(uint256 id, uint64 cap) external;
    function mint(address to, uint256 id, uint256 amount) external;
    function reserve(uint256 id, uint256 amount) external;
    function release(uint256 id, uint256 amount) external;
    function mintReserved(address to, uint256 id, uint256 amount, bytes32 claimId) external;
    function killClaim(bytes32 claimId) external;
}

/**
 * @title RatRaceSkins
 * @notice The shop of the Rat Race Combat suits. The suits themselves live in the permanent collection
 *: this shop is one of its minters and
 * can be replaced (a new pot, new prices) without touching a copy, a cap or a claim id.
 *  - Wallet RAT purchases use short-lived, buyer-bound EIP-712 price quotes and atomically split 90%
 *    burn, 5% to the Big Cheese pot (`rewards`, fixed at deploy), 5% to the referrer (to the pot without
 *    one: 10%); no team share (RAT_POT_BPS and RAT_REFERRAL_BPS, set at deploy). A quote never goes
 *    below its edition's `minRatPrice`, set by the owner, and a RAT sale cannot open without it.
 *  - Suits paid with in-game RAT (and earned in the game) are reserved in the collection by the game's
 *    minter key (reserveGame), so no wallet sale can take them; a voucher signed by the claim signer
 *    (never the quote signer) mints the copy to the player's wallet. The minter or the owner can revoke a
 *    voucher before it is used; a cancelled off-chain sale gives its copy back (releaseGame).
 *  - Fixed-price USDC sales split between the treasury and the buyback wallet, within a price the buyer
 *    agreed to (buyUsdc's maxPrice).
 *  - The caps live in the collection: a cap only goes down once set, never below the copies minted and
 *    reserved, so no shop can oversell. Vault editions (suits earned by staking) are never for sale here.
 *  - No upgrades. Pausing stops sales, reservations and claims, never transfers or releases. The
 *    ownership moves in two steps and can never be renounced.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here releaseGame frees game copies the shop reserved, and `claim` mints the copy of a signed voucher.
 */
contract RatRaceSkins is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice What this shop sells an edition for (the cap, the copies: in the collection).
    struct Sale {
        uint128 priceUsdc; // token units (USDC: 6 decimals)
        bool usdcSale;
        bool ratSale;
        uint128 minRatPrice; // the least a RAT quote may charge for it (wei of RAT); 0: no RAT sale
    }

    struct RatQuote {
        address player;
        uint256 id;
        uint256 amount;
        address referrer;
        bytes32 orderId;
        uint256 deadline;
        uint256 version;
    }
    /// @notice The RAT price quote of a wallet purchase, signed by `quoteSigner`.
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: none.
    bytes32 public constant RAT_QUOTE_TYPEHASH = keccak256("RatQuote(address player,uint256 id,uint256 amount,address referrer,bytes32 orderId,uint256 deadline,uint256 version)");
    /// @notice The voucher of a suit bought (or earned) in the game, signed by `claimSigner`.
    /// @custom:security Who: a constant. Delay: never changes. Limits: none. Checks: none.
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address to,uint256 id,uint256 amount,bytes32 claimId,uint256 deadline)");
    address public constant DEAD = address(0xdead);

    /// @notice The permanent collection this shop mints into.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: the shop mints there only
    ///     within the collection's caps. Checks: the collection's owner can remove this shop as a minter at once.
    IRatRaceSuits public immutable suits;
    IERC20 public immutable rat;
    IERC20 public immutable usdc;
    uint16 public immutable RAT_POT_BPS; // 500: 5% of a RAT purchase to the pot
    uint16 public immutable RAT_REFERRAL_BPS; // 500: 5% to the referrer (to the pot without one); the rest burned
    /// @notice A TEST shop: its pot's and its collection's testMode() at deploy (they must agree). A real one
    /// gives at most 5% to the pot and 5% to the referrer, and only ever pays a real pot.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: a real shop never pays a TEST pot nor mints in a TEST collection. Checks: the constructor compares them.
    bool public immutable testMode;

    /// @notice A RAT purchase's shares, set at deploy (bps): to the pot, to the referrer; the rest is burned.
    struct RatSplit {
        uint16 potBps;
        uint16 referralBps;
    }
    address public immutable rewards; // the Big Cheese pot, fixed at deploy: nothing can redirect its share
    address public quoteSigner;
    address public claimSigner; // signs the in-game copies' claim vouchers: never the quote signer
    uint256 public quoteVersion;
    mapping(bytes32 => bool) public usedOrders;
    address public treasury;
    address public buyback;
    uint16 public buybackBps;
    address public minter;
    mapping(uint256 => Sale) public sales;

    event EditionSet(uint256 indexed id, uint64 maxSupply, uint128 priceUsdc, bool usdcSale);
    event Bought(address indexed player, uint256 indexed id, uint256 paid, uint256 toBuyback);
    event MinterSet(address minter);
    event PaymentSet(address treasury, address buyback, uint16 buybackBps);
    event RatPaymentSet(address rewards, address quoteSigner, uint256 version);
    event RatBought(address indexed player, uint256 indexed id, bytes32 indexed orderId, uint256 paid, uint256 burned, uint256 recycled, uint256 teamPaid, address referrer, uint256 referralPaid);
    event GameReserved(uint256 indexed id, uint256 amount, uint256 reserved);
    event GameReleased(uint256 indexed id, uint256 amount, uint256 reserved);
    event Claimed(bytes32 indexed claimId, address indexed to, uint256 indexed id, uint256 amount);
    event RatSaleSet(uint256 indexed id, bool open);
    event MinRatPriceSet(uint256 indexed id, uint128 minRatPrice);
    event ClaimSignerSet(address claimSigner);
    event ClaimRevoked(bytes32 indexed claimId, address by);

    error ZeroAddress();
    error UnknownEdition();
    error NotForSale();
    error SoldOut();
    error SupplyCanOnlyGoDown();
    error Unauthorized();
    error BadBps();
    error BadQuote();
    error OrderUsed();
    error UnsupportedToken();
    error BadClaim();
    error ClaimAlreadyUsed();
    error NotReserved();
    error BadAmount();
    error LengthMismatch();
    error SameKey();
    error NoRenounce();
    error BadCollection();
    error VaultEdition();

    constructor(
        address owner_,
        IRatRaceSuits suits_,
        IERC20 usdc_,
        address treasury_,
        address buyback_,
        uint16 buybackBps_,
        address minter_,
        IERC20 rat_,
        address rewards_,
        address quoteSigner_,
        address claimSigner_,
        RatSplit memory split_
    ) Ownable(owner_) EIP712("RatRaceSkins", "1") {
        if (address(suits_) == address(0) || address(usdc_) == address(0) || treasury_ == address(0) || buyback_ == address(0)) revert ZeroAddress();
        if (address(rat_) == address(0) || rewards_ == address(0) || quoteSigner_ == address(0)) revert ZeroAddress();
        if (buybackBps_ > 10_000 || uint256(split_.potBps) + split_.referralBps > 10_000) revert BadBps();
        bool test = _testModeOf(rewards_);
        // a shop, its pot and its collection are all TEST or all real
        if (suits_.testMode() != test) revert BadCollection();
        if (!test && (split_.potBps > 500 || split_.referralBps > 500)) revert BadBps();
        testMode = test;
        suits = suits_;
        RAT_POT_BPS = split_.potBps;
        RAT_REFERRAL_BPS = split_.referralBps;
        usdc = usdc_;
        treasury = treasury_;
        buyback = buyback_;
        buybackBps = buybackBps_;
        minter = minter_;
        rat = rat_;
        rewards = rewards_;
        quoteSigner = quoteSigner_;
        _setClaimSigner(claimSigner_);
    }

    // ---------------------------------------------------------------- sales

    /// @notice A short-lived, buyer-bound backend quote. All transfers and the mint are atomic.
    ///         RAT is an ordinary 18-decimal token; fee-on-transfer tokens are unsupported.
    /// @custom:security Who: the buyer named in the quote, with a quote signed by the quote signer (EIP-712, a
    ///     short deadline, one use per order). Delay: none. Limits: never under the edition's RAT floor
    ///     (minRatPrice) set by the owner, and no RAT sale without one; within the collection's cap; the split
    ///     is fixed at deploy: RAT_POT_BPS (5%) to the Big Cheese pot, RAT_REFERRAL_BPS (5%) to the referrer
    ///     (to the pot without one), the rest burned; no team share. Checks: refused while paused, or when the
    ///     edition's RAT sale is closed or sold out.
    function buyRat(RatQuote calldata q, bytes calldata signature) external whenNotPaused nonReentrant {
        if (q.player != msg.sender || q.amount == 0 || block.timestamp > q.deadline || q.version != quoteVersion
            || q.referrer == q.player || q.referrer == address(this)) revert BadQuote();
        if (usedOrders[q.orderId]) revert OrderUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RAT_QUOTE_TYPEHASH, q.player, q.id, q.amount, q.referrer, q.orderId, q.deadline, q.version)));
        if (!SignatureChecker.isValidSignatureNow(quoteSigner, digest, signature)) revert BadQuote();
        Sale memory s = sales[q.id];
        if (!s.ratSale) revert NotForSale();
        // the owner's floor: whatever the quote key signs, never below it (and never without it)
        if (s.minRatPrice == 0 || q.amount < s.minRatPrice) revert BadQuote();
        usedOrders[q.orderId] = true;
        // RAT_REFERRAL_BPS (5%) to the referrer, or to the pot without one; RAT_POT_BPS (5%) to the pot;
        // the rest (90%, and the dust) burned
        uint256 referralPaid = q.referrer == address(0) ? 0 : q.amount * RAT_REFERRAL_BPS / 10_000;
        uint256 recycled = q.amount * RAT_POT_BPS / 10_000 + (q.referrer == address(0) ? q.amount * RAT_REFERRAL_BPS / 10_000 : 0);
        uint256 burned = q.amount - recycled - referralPaid;
        {
            uint256 beforeBalance = rat.balanceOf(address(this));
            rat.safeTransferFrom(msg.sender, address(this), q.amount);
            if (rat.balanceOf(address(this)) != beforeBalance + q.amount) revert UnsupportedToken();
        }
        _ratPay(DEAD, burned);
        _ratPay(rewards, recycled);
        if (referralPaid != 0) _ratPay(q.referrer, referralPaid);
        suits.mint(msg.sender, q.id, 1);
        emit RatBought(msg.sender, q.id, q.orderId, q.amount, burned, recycled, 0, q.referrer, referralPaid);
    }

    /// @notice Wallet UI purchase bounded by the reviewed USDC quote, even with an old allowance.
    /// @custom:security Who: anyone, for themselves. Delay: none. Limits: the edition's price, never above
    ///     maxPrice, within the collection's cap; buybackBps of it to the buyback wallet, the rest to the
    ///     treasury. Checks: refused while paused, or when the USDC sale is closed or sold out.
    function buyUsdc(uint256 id, uint256 maxPrice) external whenNotPaused nonReentrant {
        Sale memory s = sales[id];
        if (s.priceUsdc > maxPrice) revert BadQuote();
        if (!s.usdcSale || s.priceUsdc == 0) revert NotForSale();
        uint256 price = s.priceUsdc;
        uint256 toBuyback = (price * buybackBps) / 10_000;
        usdc.safeTransferFrom(msg.sender, treasury, price - toBuyback);
        if (toBuyback > 0) usdc.safeTransferFrom(msg.sender, buyback, toBuyback);
        suits.mint(msg.sender, id, 1);
        emit Bought(msg.sender, id, price, toBuyback);
    }

    // ------------------------------------------------- game copies (off chain)

    /**
     * @notice The game's minter reserves copies it sold or awarded off chain (in-game RAT, contests, Vault
     *         copies of game stakes), in the collection: no wallet sale can take them.
     * @custom:security Who: the minter (the game's key) only. Delay: none. Limits: never more than the copies
     *     left in the collection. Checks: refused while paused.
     */
    function reserveGame(uint256[] calldata ids, uint256[] calldata amounts) external whenNotPaused {
        if (msg.sender != minter) revert Unauthorized();
        if (ids.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            suits.reserve(ids[i], amounts[i]);
            emit GameReserved(ids[i], amounts[i], _reserved(ids[i]));
        }
    }

    /// @notice A cancelled (refunded) off-chain sale gives its unclaimed copies back. Works while paused.
    /// @custom:security Who: the minter only. Delay: none. Limits: only reserved, unclaimed copies go back.
    ///     Checks: works while paused.
    function releaseGame(uint256[] calldata ids, uint256[] calldata amounts) external {
        if (msg.sender != minter) revert Unauthorized();
        if (ids.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            suits.release(ids[i], amounts[i]);
            emit GameReleased(ids[i], amounts[i], _reserved(ids[i]));
        }
    }

    /**
     * @notice Mints reserved copies to `to` with the backend's EIP-712 voucher
     *         Claim(address to,uint256 id,uint256 amount,bytes32 claimId,uint256 deadline).
     *         Anybody may send it (the sender pays the gas); a claimId mints once, in any shop.
     * @custom:security Who: anyone submits it, but only a voucher signed by the claim signer (never the quote
     *     signer) for this wallet, suit and amount, before its deadline, once per claim id (the collection
     *     keeps the used ids). Delay: none. Limits: only copies reserved for the game. Checks: refused while
     *     paused or once revoked.
     */
    function claim(address to, uint256 id, uint256 amount, bytes32 claimId, uint256 deadline, bytes calldata signature)
        external
        whenNotPaused
        nonReentrant
    {
        if (amount == 0 || block.timestamp > deadline) revert BadClaim();
        if (suits.claimUsed(claimId)) revert ClaimAlreadyUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, to, id, amount, claimId, deadline)));
        if (!SignatureChecker.isValidSignatureNow(claimSigner, digest, signature)) revert BadClaim();
        suits.mintReserved(to, id, amount, claimId);
        emit Claimed(claimId, to, id, amount);
    }

    /**
     * @notice Kill a claim voucher before it is used (the minter or the owner): a sale cancelled in the game
     *         never leaves a live voucher behind.
     * @custom:security Who: the minter or the owner. Delay: none. Limits: it only kills a voucher not used yet.
     */
    function revokeClaim(bytes32 claimId) external {
        if (msg.sender != minter && msg.sender != owner()) revert Unauthorized();
        suits.killClaim(claimId);
        emit ClaimRevoked(claimId, msg.sender);
    }

    // ---------------------------------------------------------------- views (the game server reads these)

    /// @notice An edition as the game reads it: the collection's cap and minted copies, this shop's prices.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function editions(uint256 id) external view returns (uint64 maxSupply, uint64 minted, uint128 priceUsdc, bool usdcSale, bool ratSale, uint128 minRatPrice) {
        (uint64 cap, uint64 m,,) = suits.editions(id);
        Sale memory s = sales[id];
        return (cap, m, s.priceUsdc, s.usdcSale, s.ratSale, s.minRatPrice);
    }

    /// @notice Copies reserved for the game in the collection, not claimed yet.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function reserved(uint256 id) external view returns (uint256) {
        return _reserved(id);
    }

    /// @notice Copies minted in the collection (all shops and claims).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function minted(uint256 id) external view returns (uint256) {
        (, uint64 m,,) = suits.editions(id);
        return m;
    }

    /// @notice Copies a wallet can still buy: cap - minted - reserved.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function remaining(uint256 id) external view returns (uint256) {
        (uint64 cap, uint64 m, uint64 r,) = suits.editions(id);
        return uint256(cap) - m - r;
    }

    /// @notice Whether a claim id was used or killed (in the collection, whatever shop).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function claimUsed(bytes32 claimId) external view returns (bool) {
        return suits.claimUsed(claimId);
    }

    /// @notice The collection's balances (for the game's ownership checks).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory) {
        return suits.balanceOfBatch(accounts, ids);
    }

    // ---------------------------------------------------------------- owner

    /// @notice One transaction per edition: its cap (in the collection) and both payment options.
    /// @custom:security Who: the owner (the admin Safe). Delay: none. Limits: a cap only ever goes down once
    ///     set, never under the copies minted and reserved (the collection checks it); a RAT sale needs the
    ///     edition's RAT floor; never a Vault edition.
    function configureEdition(uint256 id, uint64 cap, uint128 price, bool usdcOpen, bool ratOpen) external onlyOwner {
        (,,, bool vault) = suits.editions(id);
        if (vault) revert VaultEdition();
        Sale storage s = sales[id];
        if (ratOpen && s.minRatPrice == 0) revert BadQuote(); // (a RAT sale needs its floor first)
        suits.setCap(id, cap);
        s.priceUsdc = price;
        s.usdcSale = usdcOpen;
        s.ratSale = ratOpen;
        quoteVersion++;
        emit EditionSet(id, cap, price, usdcOpen);
        emit RatSaleSet(id, ratOpen);
    }

    /**
     * @notice The least a RAT quote may charge per edition (wei of RAT). Set it below the price at any RAT
     *         price the shop expects (a quote under it fails), above what a stolen quote key could abuse.
     * @custom:security Who: the owner (the admin Safe). Delay: none. Limits: a floor per edition that every RAT
     *     quote must meet (a stolen quote key cannot sell under it).
     */
    function setMinRatPrices(uint256[] calldata ids, uint128[] calldata mins) external onlyOwner {
        if (ids.length != mins.length) revert LengthMismatch();
        for (uint256 i; i < ids.length; ++i) {
            sales[ids[i]].minRatPrice = mins[i];
            emit MinRatPriceSet(ids[i], mins[i]);
        }
        quoteVersion++;
    }

    /// @notice A new key for the wallet RAT quotes (the pot they pay is fixed at deploy). Every older quote stops working.
    /// @custom:security Who: the owner (the admin Safe). Delay: none. Limits: the quote signer only, never the
    ///     claim signer; the pot never changes. Checks: every older quote stops working (quoteVersion).
    function setQuoteSigner(address quoteSigner_) external onlyOwner {
        if (quoteSigner_ == address(0)) revert ZeroAddress();
        if (quoteSigner_ == claimSigner) revert SameKey();
        quoteSigner = quoteSigner_;
        quoteVersion++;
        emit RatPaymentSet(rewards, quoteSigner_, quoteVersion);
    }

    /// @notice A new claim signer (never the quote signer). Vouchers it did not sign stop working.
    /// @custom:security Who: the owner (the admin Safe). Delay: none. Limits: never the quote signer; vouchers
    ///     of the old key stop working.
    function setClaimSigner(address claimSigner_) external onlyOwner {
        _setClaimSigner(claimSigner_);
    }

    /// @notice Set the game's minter key: it reserves and releases game copies and revokes vouchers; it never takes RAT or USDC.
    /// @custom:security Who: the owner (the admin Safe). Delay: none. Limits: the minter only reserves,
    ///     releases and revokes game copies; it never takes RAT or USDC.
    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @notice Set where USDC sales go: the treasury, the buyback wallet and the buyback share.
    /// @custom:security Who: the owner (the admin Safe). Delay: none. Limits: the buyback share at most 100%.
    function setPayment(address treasury_, address buyback_, uint16 buybackBps_) external onlyOwner {
        if (treasury_ == address(0) || buyback_ == address(0)) revert ZeroAddress();
        if (buybackBps_ > 10_000) revert BadBps();
        treasury = treasury_;
        buyback = buyback_;
        buybackBps = buybackBps_;
        quoteVersion++;
        emit PaymentSet(treasury_, buyback_, buybackBps_);
    }

    /// @notice Disabled: without an owner nobody could pause, fix an edition or replace a key.
    /// @custom:security Who: nobody: it always reverts.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    /// @notice Stop sales, reservations and claims (a brake): transfers and the copies held never stop.
    /// @custom:security Who: the owner (the admin Safe). Delay: none. Limits: it stops sales, reservations and
    ///     claims; never transfers, never a holder's copy.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume sales, reservations and claims.
    /// @custom:security Who: the owner (the admin Safe). Delay: none.
    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------- internal

    function _setClaimSigner(address c) internal {
        if (c == address(0)) revert ZeroAddress();
        if (c == quoteSigner) revert SameKey();
        claimSigner = c;
        emit ClaimSignerSet(c);
    }

    /// @dev A pot's testMode(): false for anything that does not answer it (a wallet, an older contract).
    function _testModeOf(address pot_) internal view returns (bool) {
        (bool ok, bytes memory r) = pot_.staticcall(abi.encodeWithSignature("testMode()"));
        return ok && r.length == 32 && abi.decode(r, (bool));
    }

    function _reserved(uint256 id) private view returns (uint256) {
        (,, uint64 r,) = suits.editions(id);
        return r;
    }

    function _ratPay(address to, uint256 amount) private {
        if (to == address(this)) revert BadQuote();
        uint256 beforeBalance = rat.balanceOf(to);
        rat.safeTransfer(to, amount);
        if (rat.balanceOf(to) != beforeBalance + amount) revert UnsupportedToken();
    }
}
