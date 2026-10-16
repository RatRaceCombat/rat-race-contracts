// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title RatRaceSuits
 * @notice The Rat Race Combat suits as NFTs (ERC-1155): the collection, deployed once and never
 * redeployed. Cosmetic only: a suit gives no combat or earnings advantage.
 *
 * It holds what makes a copy a copy: each edition's cap (it only ever goes down once set, never under
 * the copies minted and reserved), the copies minted and the copies reserved for the game (suits paid
 * in the game, claimed later), the claim ids already used, and the metadata. Nobody sells here: the
 * shops and the Vault minter are minters, replaceable contracts that mint within the caps. A new shop
 * (a new pot, new prices) never resets a cap, a reserved copy or a used claim id.
 *
 * Vault copies (suits earned by staking) are editions of their own, marked Vault: they cannot move
 * from wallet to wallet until the owner opens their transfers, once, announced NOTICE (3 days) ahead,
 * and nobody can ever close them again.
 *
 * Who decides what: the owner (the team Safe) adds a minter only after announcing it NOTICE (3 days)
 * ahead in public (the announcement lapses EXECUTION_WINDOW, 14 days, after it is ready) and removes one
 * at once (a brake). Before the first copy exists it may set the first minters at once (nothing to
 * protect yet). It sets the metadata address and the royalty. It can never take, burn or move a copy,
 * there is no upgrade, and the ownership can never be renounced.
 * Glossary (the same verbs mean different things across the Rat Race contracts: `release` sends RAT or copies
 * to one destination each, and a change waiting in public is schedule/execute, propose/apply or announce/add):
 * here release(id, amount) frees copies a minter reserved for the game; a new minter is announceMinter, then
 * addMinter after NOTICE; the Vault transfers are announceVaultTransfers, then openVaultTransfers.
 */
contract RatRaceSuits is ERC1155, ERC2981, Ownable2Step {
    struct Edition {
        uint64 cap; // 0: no such edition yet
        uint64 minted;
        uint64 reserved; // copies sold or earned in the game, not claimed yet
        bool vault; // a Vault edition: not transferable until vaultTransfersOpen
    }

    /// @notice A TEST collection (set at deploy, for good): its name, symbol and metadata say so.
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: none. Checks: a shorter
    ///     notice or window also makes it a TEST collection.
    bool public immutable testMode;
    /// @notice How long a new minter or the opening of Vault transfers waits in public (3 days for real).
    /// @custom:security Who: set at deploy, never changed. Delay: this one. Limits: 1 second to 3 days.
    ///     Checks: shorter than 3 days makes testMode() true.
    uint64 public immutable NOTICE;
    /// @notice A ready announcement lapses this long after its ready time (14 days for real).
    /// @custom:security Who: set at deploy, never changed. Delay: none. Limits: 1 second to 14 days.
    ///     Checks: shorter than 14 days makes testMode() true.
    uint64 public immutable EXECUTION_WINDOW;

    /// @notice Each edition's cap, minted and reserved copies, and whether it is a Vault edition.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    mapping(uint256 => Edition) public editions;
    /// @notice A claim id once it has minted or was killed: never again, whatever shop signs it.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    mapping(bytes32 => bool) public claimUsed;
    /// @notice The contracts allowed to mint (the shops, the Vault minter).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    mapping(address => bool) public isMinter;
    /// @notice When an announced minter may be added (0: not announced).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    mapping(address => uint64) public minterReadyAt;
    /// @notice Whether Vault copies move freely (opened once, never closed).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    bool public vaultTransfersOpen;
    /// @notice When the announced opening of Vault transfers may apply (0: not announced).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    uint64 public vaultOpenReadyAt;
    /// @notice True once a copy was minted or reserved: from then on a minter waits NOTICE.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    bool public live;
    /// @notice Where the copies' metadata lives: uri() starts with it (setBaseURI, until freezeMetadata).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    string public baseURI;
    /// @notice True once the owner froze the metadata: the metadata address can never change again.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing. Checks: none.
    bool public metadataFrozen;

    event MinterAnnounced(address indexed minter, uint64 readyAt);
    event MinterAnnouncementCancelled(address indexed minter);
    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);
    event CapSet(uint256 indexed id, uint64 cap, address by);
    event VaultMarked(uint256 indexed id);
    event VaultTransfersAnnounced(uint64 readyAt);
    event VaultTransfersAnnouncementCancelled();
    event VaultTransfersOpened();
    event Reserved(uint256 indexed id, uint256 amount, uint256 reserved, address by);
    event Released(uint256 indexed id, uint256 amount, uint256 reserved, address by);
    event ClaimMinted(bytes32 indexed claimId, address indexed to, uint256 indexed id, uint256 amount, address by);
    event ClaimKilled(bytes32 indexed claimId, address by);
    event BaseURISet(string baseURI);
    event MetadataFrozen();
    /// @dev ERC-4906: marketplaces refresh every copy's metadata.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    error ZeroAddress();
    error NotMinter();
    error NotAnnounced();
    error NotReady();
    error Expired();
    error AlreadyLive();
    error UnknownEdition();
    error SoldOut();
    error SupplyCanOnlyGoDown();
    error NotReserved();
    error BadAmount();
    error ClaimAlreadyUsed();
    error AlreadyCopies();
    error Soulbound();
    error AlreadyOpen();
    error BadSettings();
    error NoRenounce();
    error MetadataIsFrozen();

    /// @param firstMinter the shop deployed right after this collection (its address predicted from the
    ///     deployer's next nonce), a minter from the start; address 0: none.
    constructor(address owner_, address royaltyReceiver, uint96 royaltyBps, uint64 notice, uint64 executionWindow, bool test, address firstMinter)
        ERC1155("")
        Ownable(owner_)
    {
        if (royaltyReceiver == address(0)) revert ZeroAddress();
        if (notice == 0 || executionWindow == 0 || notice > 3 days || executionWindow > 14 days) revert BadSettings();
        NOTICE = notice;
        EXECUTION_WINDOW = executionWindow;
        testMode = test || notice < 3 days || executionWindow < 14 days;
        baseURI = testMode ? "https://dev.ratracecombat.com/api/nft/test/" : "https://play.ratracecombat.com/api/nft/";
        _setDefaultRoyalty(royaltyReceiver, royaltyBps);
        if (firstMinter != address(0)) {
            isMinter[firstMinter] = true;
            emit MinterAdded(firstMinter);
        }
    }

    // ------------------------------------------------------------------ names

    /// @notice The collection's name; a TEST collection says so, so no marketplace takes its copies for real suits.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function name() external view returns (string memory) {
        return testMode ? "Rat Race TEST Suits (no value)" : "Rat Race Combat Suits";
    }

    /// @notice The collection's symbol (RRCSUIT; a TEST collection: RRTEST).
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function symbol() external view returns (string memory) {
        return testMode ? "RRTEST" : "RRCSUIT";
    }

    /// @notice Where a copy's metadata is: <baseURI><id>.json.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function uri(uint256 id) public view override returns (string memory) {
        return string.concat(baseURI, Strings.toString(id), ".json");
    }

    /// @notice Copies of an edition a minter can still mint or reserve: cap - minted - reserved.
    /// @custom:security Who: anyone (read only). Delay: none. Limits: changes nothing.
    function remaining(uint256 id) external view returns (uint256) {
        Edition memory e = editions[id];
        return uint256(e.cap) - e.minted - e.reserved;
    }

    // ------------------------------------------------------------------ minters

    /// @notice Announce a new minter (a new shop, the Vault minter): it can be added NOTICE (3 days) later.
    /// @custom:security Who: the owner (the team Safe). Delay: the minter is added NOTICE (3 days) later at
    ///     the earliest, and the announcement lapses EXECUTION_WINDOW (14 days) after that. Limits: none.
    ///     Checks: public (MinterAnnounced), the owner can cancel it.
    function announceMinter(address minter) external onlyOwner {
        if (minter == address(0)) revert ZeroAddress();
        uint64 readyAt = uint64(block.timestamp) + NOTICE;
        minterReadyAt[minter] = readyAt;
        emit MinterAnnounced(minter, readyAt);
    }

    /// @notice Drop an announced minter before it is added.
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: it only drops an announcement.
    function cancelMinter(address minter) external onlyOwner {
        if (minterReadyAt[minter] == 0) revert NotAnnounced();
        delete minterReadyAt[minter];
        emit MinterAnnouncementCancelled(minter);
    }

    /// @notice Add an announced minter once its NOTICE is over, within EXECUTION_WINDOW.
    /// @custom:security Who: the owner (the team Safe). Delay: only NOTICE (3 days) after its announcement,
    ///     within EXECUTION_WINDOW (14 days) after, or it lapses. Limits: a minter mints only within the
    ///     caps. Checks: public (MinterAdded).
    function addMinter(address minter) external onlyOwner {
        uint64 readyAt = minterReadyAt[minter];
        if (readyAt == 0) revert NotAnnounced();
        if (block.timestamp < readyAt) revert NotReady();
        if (block.timestamp > uint256(readyAt) + EXECUTION_WINDOW) revert Expired();
        delete minterReadyAt[minter];
        isMinter[minter] = true;
        emit MinterAdded(minter);
    }

    /// @notice Set a first minter at once, before any copy exists (nothing to protect yet).
    /// @custom:security Who: the owner (the team Safe). Delay: none, but only before the first copy is
    ///     minted or reserved. Limits: after that, a minter waits NOTICE (3 days). Checks: public (MinterAdded).
    function bootstrapMinter(address minter) external onlyOwner {
        if (live) revert AlreadyLive();
        if (minter == address(0)) revert ZeroAddress();
        isMinter[minter] = true;
        emit MinterAdded(minter);
    }

    /// @notice Remove a minter at once (a brake: a shop or a key in doubt).
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: it only stops future mints; every
    ///     copy minted stays its holder's. Checks: public (MinterRemoved).
    function removeMinter(address minter) external onlyOwner {
        isMinter[minter] = false;
        emit MinterRemoved(minter);
    }

    modifier onlyMinter() {
        if (!isMinter[msg.sender]) revert NotMinter();
        _;
    }

    // ------------------------------------------------------------------ editions and copies

    /// @notice Set an edition's cap: any for a new edition, then only ever lower, never under the copies
    ///     minted and reserved (the collectors' guarantee, whatever shop sells it).
    /// @custom:security Who: the owner or a minter (a shop forwards its owner's edition setup). Delay: none.
    ///     Limits: a cap only goes down once set, never under minted + reserved. Checks: public (CapSet).
    function setCap(uint256 id, uint64 cap) external {
        if (!isMinter[msg.sender] && msg.sender != owner()) revert NotMinter();
        Edition storage e = editions[id];
        if (cap == 0 || (e.cap != 0 && cap > e.cap) || cap < uint256(e.minted) + e.reserved) revert SupplyCanOnlyGoDown();
        e.cap = cap;
        emit CapSet(id, cap, msg.sender);
    }

    /// @notice Mark editions as Vault editions (suits earned by staking), before they exist at all.
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: only an edition not created yet
    ///     (no cap: no shop sells it, no copy exists), and for good (a Vault edition never becomes a sold one).
    ///     Checks: public (VaultMarked).
    function markVault(uint256[] calldata ids) external onlyOwner {
        for (uint256 i; i < ids.length; ++i) {
            Edition storage e = editions[ids[i]];
            if (e.cap != 0) revert AlreadyCopies(); // (the review of the split, M1: never an edition a shop already sells)
            e.vault = true;
            emit VaultMarked(ids[i]);
        }
    }

    /// @notice Mint copies within the cap (a shop's sale, the Vault minter's earned suit).
    /// @custom:security Who: a minter only. Delay: none. Limits: minted + reserved never above the cap.
    function mint(address to, uint256 id, uint256 amount) external onlyMinter {
        Edition storage e = editions[id];
        if (e.cap == 0) revert UnknownEdition();
        if (amount == 0) revert BadAmount();
        if (uint256(e.minted) + e.reserved + amount > e.cap) revert SoldOut();
        e.minted += uint64(amount);
        live = true;
        _mint(to, id, amount, "");
    }

    /// @notice Reserve copies for the game (sold or earned in the game, claimed later): no sale can take them.
    /// @custom:security Who: a minter only. Delay: none. Limits: minted + reserved never above the cap.
    ///     Checks: public (Reserved).
    function reserve(uint256 id, uint256 amount) external onlyMinter {
        Edition storage e = editions[id];
        if (e.cap == 0) revert UnknownEdition();
        if (amount == 0) revert BadAmount();
        uint256 total = uint256(e.reserved) + amount;
        if (uint256(e.minted) + total > e.cap) revert SoldOut();
        e.reserved = uint64(total);
        live = true;
        emit Reserved(id, amount, total, msg.sender);
    }

    /// @notice Give reserved copies back (a cancelled game sale).
    /// @custom:security Who: a minter only. Delay: none. Limits: only reserved, unclaimed copies.
    ///     Checks: public (Released).
    function release(uint256 id, uint256 amount) external onlyMinter {
        Edition storage e = editions[id];
        if (amount == 0) revert BadAmount();
        if (amount > e.reserved) revert NotReserved();
        e.reserved -= uint64(amount);
        emit Released(id, amount, e.reserved, msg.sender);
    }

    /// @notice Mint reserved copies to their player, once per claim id (whatever shop checked the voucher).
    /// @custom:security Who: a minter only (the shop that checked the player's voucher). Delay: none.
    ///     Limits: only reserved copies; a claim id mints once, ever. Checks: public (ClaimMinted).
    function mintReserved(address to, uint256 id, uint256 amount, bytes32 claimId) external onlyMinter {
        if (claimUsed[claimId]) revert ClaimAlreadyUsed();
        Edition storage e = editions[id];
        if (amount == 0) revert BadAmount();
        if (amount > e.reserved) revert NotReserved();
        claimUsed[claimId] = true;
        e.reserved -= uint64(amount);
        e.minted += uint64(amount);
        _mint(to, id, amount, "");
        emit ClaimMinted(claimId, to, id, amount, msg.sender);
    }

    /// @notice Kill a claim id before it is used (a cancelled game sale's voucher dies with it).
    /// @custom:security Who: a minter or the owner. Delay: none. Limits: it only kills an unused claim id.
    function killClaim(bytes32 claimId) external {
        if (!isMinter[msg.sender] && msg.sender != owner()) revert NotMinter();
        if (claimUsed[claimId]) revert ClaimAlreadyUsed();
        claimUsed[claimId] = true;
        emit ClaimKilled(claimId, msg.sender);
    }

    // ------------------------------------------------------------------ Vault transfers

    /// @notice Announce the opening of Vault transfers: it can apply NOTICE (3 days) later, once, for good.
    /// @custom:security Who: the owner (the team Safe). Delay: NOTICE (3 days), lapsing EXECUTION_WINDOW
    ///     (14 days) after. Limits: none. Checks: public (VaultTransfersAnnounced); the owner can cancel it.
    function announceVaultTransfers() external onlyOwner {
        if (vaultTransfersOpen) revert AlreadyOpen();
        vaultOpenReadyAt = uint64(block.timestamp) + NOTICE;
        emit VaultTransfersAnnounced(vaultOpenReadyAt);
    }

    /// @notice Drop the announced opening of Vault transfers.
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: it only drops an announcement.
    function cancelVaultTransfers() external onlyOwner {
        if (vaultOpenReadyAt == 0) revert NotAnnounced();
        vaultOpenReadyAt = 0;
        emit VaultTransfersAnnouncementCancelled();
    }

    /// @notice Open Vault transfers, for good: nobody can ever close them again.
    /// @custom:security Who: the owner (the team Safe). Delay: only NOTICE (3 days) after the announcement,
    ///     within EXECUTION_WINDOW (14 days) after, or it lapses. Limits: one way, for good.
    ///     Checks: public (VaultTransfersOpened).
    function openVaultTransfers() external onlyOwner {
        uint64 readyAt = vaultOpenReadyAt;
        if (readyAt == 0) revert NotAnnounced();
        if (block.timestamp < readyAt) revert NotReady();
        if (block.timestamp > uint256(readyAt) + EXECUTION_WINDOW) revert Expired();
        vaultTransfersOpen = true;
        vaultOpenReadyAt = 0;
        emit VaultTransfersOpened();
    }

    /// @dev Vault copies stay where they were minted until vaultTransfersOpen (mints are not transfers).
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0) && to != address(0) && !vaultTransfersOpen) {
            for (uint256 i; i < ids.length; ++i) if (editions[ids[i]].vault) revert Soulbound();
        }
        super._update(from, to, ids, values);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Where the metadata is read (until it is frozen).
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: the metadata address only; never a
    ///     copy, a cap or a holder; never again once frozen. Checks: public (BaseURISet, ERC-4906).
    function setBaseURI(string calldata baseURI_) external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        baseURI = baseURI_;
        emit BaseURISet(baseURI_);
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice Freeze the metadata address for good: nobody can ever change it again.
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: one way, for good: there is no
    ///     unfreeze. Checks: public (MetadataFrozen).
    function freezeMetadata() external onlyOwner {
        if (metadataFrozen) revert MetadataIsFrozen();
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    /// @notice The royalty on secondary sales (EIP-2981).
    /// @custom:security Who: the owner (the team Safe). Delay: none. Limits: at most 100% (EIP-2981); it never
    ///     touches a copy.
    function setRoyalty(address receiver, uint96 bps) external onlyOwner {
        _setDefaultRoyalty(receiver, bps);
    }

    /// @notice Disabled: without an owner nobody could remove a minter in doubt.
    /// @custom:security Who: nobody: it always reverts.
    function renounceOwnership() public pure override {
        revert NoRenounce();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, ERC2981) returns (bool) {
        return interfaceId == bytes4(0x49064906) || super.supportsInterface(interfaceId); // (ERC-4906)
    }
}
