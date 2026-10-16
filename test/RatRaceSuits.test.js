// RatRaceSuits: the permanent collection. Caps that only
// go down, minters added after a public notice and removed at once, claim ids used once whatever shop, game
// copies that survive a new shop, Vault copies that move only once their one-way switch is open.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deploySuits, shopWith } = require('./helpers/suits.cjs');
const { REAL_SPLIT } = require('./helpers/timings.cjs');

const DAY = 86400;
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
const mine = async (t) => { await ethers.provider.send('evm_setNextBlockTimestamp', [t]); await ethers.provider.send('evm_mine', []); };

async function deploy() {
  const [owner, treasury, shop, other, alice, bob] = await ethers.getSigners();
  const suits = await deploySuits(owner.address, treasury.address);
  await suits.bootstrapMinter(shop.address); // (a signer stands for a shop contract here)
  return { suits, owner, treasury, shop, other, alice, bob };
}

describe('RatRaceSuits (the permanent collection)', () => {
  it('a real collection says so; a TEST one (a flag or a shorter notice) says TEST everywhere; bounds', async () => {
    const [owner, treasury] = await ethers.getSigners();
    const real = await deploySuits(owner.address, treasury.address);
    expect([await real.testMode(), await real.name(), await real.symbol(), await real.uri(8), await real.NOTICE(), await real.EXECUTION_WINDOW()])
      .to.deep.equal([false, 'Rat Race Combat Suits', 'RRCSUIT', 'https://play.ratracecombat.com/api/nft/8.json', 3n * 86400n, 14n * 86400n]);
    for (const t of [await deploySuits(owner.address, treasury.address, 500, true), await deploySuits(owner.address, treasury.address, 500, false, 600, 3600)]) {
      expect([await t.testMode(), await t.name(), await t.symbol(), await t.uri(8)]).to.deep.equal([true, 'Rat Race TEST Suits (no value)', 'RRTEST', 'https://dev.ratracecombat.com/api/nft/test/8.json']);
    }
    const F = await ethers.getContractFactory('RatRaceSuits');
    for (const [n, w] of [[0, 3600], [600, 0], [3 * DAY + 1, 14 * DAY], [3 * DAY, 14 * DAY + 1]]) {
      await expect(F.deploy(owner.address, treasury.address, 500, n, w, false, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, 'BadSettings');
    }
    expect(await real.royaltyInfo(8, 10000n)).to.deep.equal([treasury.address, 500n]);
    // the metadata: changed (ERC-4906 tells the marketplaces) until a one-way freeze; no unfreeze exists
    expect(await real.supportsInterface('0x49064906')).to.equal(true);
    await expect(real.setBaseURI('https://example.test/')).to.emit(real, 'BatchMetadataUpdate').withArgs(0n, ethers.MaxUint256);
    expect(await real.uri(8)).to.equal('https://example.test/8.json');
    await expect(real.connect(treasury).freezeMetadata()).to.be.revertedWithCustomError(real, 'OwnableUnauthorizedAccount');
    await expect(real.freezeMetadata()).to.emit(real, 'MetadataFrozen');
    await expect(real.setBaseURI('https://other.test/')).to.be.revertedWithCustomError(real, 'MetadataIsFrozen');
    await expect(real.freezeMetadata()).to.be.revertedWithCustomError(real, 'MetadataIsFrozen');
    expect(real.interface.fragments.some((f) => f.type === 'function' && /unfreeze/i.test(f.name))).to.equal(false);
    // the shop deployed right after, by the same wallet, is a minter from the start (no owner transaction)
    const [deployer] = await ethers.getSigners();
    const next = ethers.getCreateAddress({ from: deployer.address, nonce: (await ethers.provider.getTransactionCount(deployer.address)) + 1 });
    const withShop = await F.deploy(owner.address, treasury.address, 500, 3 * DAY, 14 * DAY, false, next);
    expect(await withShop.isMinter(next)).to.equal(true);
    await expect(real.renounceOwnership()).to.be.revertedWithCustomError(real, 'NoRenounce');
  });

  it('caps: any for a new edition, then only lower, never under minted + reserved; by the owner or a minter only', async () => {
    const { suits, shop, other, alice } = await deploy();
    await expect(suits.connect(other).setCap(8, 10)).to.be.revertedWithCustomError(suits, 'NotMinter');
    await suits.connect(shop).setCap(8, 10);
    await expect(suits.connect(shop).setCap(8, 11)).to.be.revertedWithCustomError(suits, 'SupplyCanOnlyGoDown');
    await suits.connect(shop).mint(alice.address, 8, 3);
    await suits.connect(shop).reserve(8, 2);
    await expect(suits.setCap(8, 4)).to.be.revertedWithCustomError(suits, 'SupplyCanOnlyGoDown');
    await suits.setCap(8, 5);
    expect(await suits.remaining(8)).to.equal(0n);
    await expect(suits.connect(shop).mint(alice.address, 8, 1)).to.be.revertedWithCustomError(suits, 'SoldOut');
    await expect(suits.connect(shop).reserve(8, 1)).to.be.revertedWithCustomError(suits, 'SoldOut');
    await expect(suits.connect(other).mint(alice.address, 8, 1)).to.be.revertedWithCustomError(suits, 'NotMinter');
    await expect(suits.connect(shop).mint(alice.address, 99, 1)).to.be.revertedWithCustomError(suits, 'UnknownEdition');
  });

  it('a new minter waits NOTICE in public and lapses; the first ones only before any copy; removal is at once', async () => {
    const { suits, shop, other, alice } = await deploy();
    await suits.connect(shop).setCap(8, 10);
    await suits.connect(shop).mint(alice.address, 8, 1); // the collection is live
    await expect(suits.bootstrapMinter(other.address)).to.be.revertedWithCustomError(suits, 'AlreadyLive');
    await expect(suits.addMinter(other.address)).to.be.revertedWithCustomError(suits, 'NotAnnounced');
    await expect(suits.connect(other).announceMinter(other.address)).to.be.revertedWithCustomError(suits, 'OwnableUnauthorizedAccount');
    await expect(suits.announceMinter(other.address)).to.emit(suits, 'MinterAnnounced');
    const readyAt = Number(await suits.minterReadyAt(other.address));
    await expect(suits.addMinter(other.address)).to.be.revertedWithCustomError(suits, 'NotReady');
    await mine(readyAt + 14 * DAY + 1);
    await expect(suits.addMinter(other.address)).to.be.revertedWithCustomError(suits, 'Expired');
    await suits.announceMinter(other.address);
    await mine(Number(await suits.minterReadyAt(other.address)));
    await expect(suits.addMinter(other.address)).to.emit(suits, 'MinterAdded').withArgs(other.address);
    await suits.connect(other).mint(alice.address, 8, 1);
    await suits.removeMinter(other.address);
    await expect(suits.connect(other).mint(alice.address, 8, 1)).to.be.revertedWithCustomError(suits, 'NotMinter');
    expect(await suits.balanceOf(alice.address, 8)).to.equal(2n, 'a removed minter leaves every copy where it is');
    // an announcement can be dropped
    await suits.announceMinter(other.address);
    await suits.cancelMinter(other.address);
    expect(await suits.minterReadyAt(other.address)).to.equal(0n);
  });

  it('game copies: reserved, released, minted once per claim id, killed claim ids never mint', async () => {
    const { suits, shop, alice } = await deploy();
    await suits.connect(shop).setCap(14, 5);
    await suits.connect(shop).reserve(14, 3);
    await expect(suits.connect(shop).release(14, 4)).to.be.revertedWithCustomError(suits, 'NotReserved');
    await suits.connect(shop).release(14, 1);
    const id1 = ethers.id('claim-1'), id2 = ethers.id('claim-2');
    await suits.connect(shop).mintReserved(alice.address, 14, 1, id1);
    await expect(suits.connect(shop).mintReserved(alice.address, 14, 1, id1)).to.be.revertedWithCustomError(suits, 'ClaimAlreadyUsed');
    await suits.killClaim(id2);
    await expect(suits.connect(shop).mintReserved(alice.address, 14, 1, id2)).to.be.revertedWithCustomError(suits, 'ClaimAlreadyUsed');
    await expect(suits.connect(shop).mintReserved(alice.address, 14, 2, ethers.id('claim-3'))).to.be.revertedWithCustomError(suits, 'NotReserved');
    expect((await suits.editions(14)).slice(0, 3)).to.deep.equal([5n, 1n, 1n]);
  });

  it('a new shop on the same collection keeps every reserved copy and never re-mints an old claim id', async () => {
    const [owner, treasury, buyback, minter, quoter, claimer, alice, rewards] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
    const shop1 = await shopWith([owner.address, await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address, 500, await rat.getAddress(), rewards.address, quoter.address, claimer.address, REAL_SPLIT]);
    const suits = shop1.suits;
    await shop1.configureEdition(14, 100, 50_000_000, false, false);
    await shop1.connect(minter).reserveGame([14], [2]);
    // the claim voucher of shop 1
    const { chainId } = await ethers.provider.getNetwork();
    const { CLAIM_TYPES } = await import('../shared/skins-chain.js');
    const voucher = async (shop, claimId) => {
      const v = { to: alice.address, id: 14n, amount: 1n, claimId, deadline: BigInt(await now()) + 3600n };
      const domain = { name: 'RatRaceSkins', version: '1', chainId, verifyingContract: await shop.getAddress() };
      return [v.to, v.id, v.amount, v.claimId, v.deadline, await claimer.signTypedData(domain, CLAIM_TYPES, v)];
    };
    const used = ethers.id('game-copy-1');
    await shop1.claim(...(await voucher(shop1, used)));
    // a second shop on the same collection (announced, added NOTICE later)
    const F = await ethers.getContractFactory('RatRaceSkins');
    const shop2 = await F.deploy(owner.address, await suits.getAddress(), await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address, await rat.getAddress(), rewards.address, quoter.address, claimer.address, REAL_SPLIT);
    await suits.announceMinter(await shop2.getAddress());
    await mine(Number(await suits.minterReadyAt(await shop2.getAddress())));
    await suits.addMinter(await shop2.getAddress());
    await suits.removeMinter(await shop1.getAddress());
    expect(await shop2.reserved(14)).to.equal(1n, 'the copy still reserved for the game is still there');
    await expect(shop2.claim(...(await voucher(shop2, used)))).to.be.revertedWithCustomError(shop2, 'ClaimAlreadyUsed');
    await shop2.claim(...(await voucher(shop2, ethers.id('game-copy-2'))));
    expect(await suits.balanceOf(alice.address, 14)).to.equal(2n);
    await expect(shop1.connect(minter).reserveGame([14], [1])).to.be.revertedWithCustomError(suits, 'NotMinter');
  });

  it('Vault copies stay where they are minted until the one-way switch, announced NOTICE ahead; sold editions move freely', async () => {
    const { suits, owner, shop, alice, bob } = await deploy();
    const VAULT = 1_000_037n;
    await expect(suits.connect(shop).markVault([VAULT])).to.be.revertedWithCustomError(suits, 'OwnableUnauthorizedAccount');
    await suits.markVault([VAULT]);
    await suits.connect(shop).setCap(VAULT, 1_000_000);
    await suits.connect(shop).setCap(8, 10);
    // (M1 of the split's review: an edition a shop already sells never becomes a Vault one, even before its first copy)
    await suits.connect(shop).setCap(9, 10);
    await expect(suits.markVault([9])).to.be.revertedWithCustomError(suits, 'AlreadyCopies');
    await suits.connect(shop).mint(alice.address, VAULT, 1);
    await suits.connect(shop).mint(alice.address, 8, 1);
    await expect(suits.markVault([8])).to.be.revertedWithCustomError(suits, 'AlreadyCopies');
    await suits.connect(alice).safeTransferFrom(alice.address, bob.address, 8, 1, '0x');
    await expect(suits.connect(alice).safeTransferFrom(alice.address, bob.address, VAULT, 1, '0x')).to.be.revertedWithCustomError(suits, 'Soulbound');
    await expect(suits.connect(alice).safeBatchTransferFrom(alice.address, bob.address, [VAULT], [1], '0x')).to.be.revertedWithCustomError(suits, 'Soulbound');
    // the switch: announced, NOTICE, within the window, once, for good
    await expect(suits.openVaultTransfers()).to.be.revertedWithCustomError(suits, 'NotAnnounced');
    await suits.announceVaultTransfers();
    await expect(suits.openVaultTransfers()).to.be.revertedWithCustomError(suits, 'NotReady');
    await mine(Number(await suits.vaultOpenReadyAt()) + 14 * DAY + 1);
    await expect(suits.openVaultTransfers()).to.be.revertedWithCustomError(suits, 'Expired');
    await suits.announceVaultTransfers();
    await mine(Number(await suits.vaultOpenReadyAt()));
    await expect(suits.connect(alice).openVaultTransfers()).to.be.revertedWithCustomError(suits, 'OwnableUnauthorizedAccount');
    await expect(suits.connect(owner).openVaultTransfers()).to.emit(suits, 'VaultTransfersOpened');
    await suits.connect(alice).safeTransferFrom(alice.address, bob.address, VAULT, 1, '0x');
    expect(await suits.balanceOf(bob.address, VAULT)).to.equal(1n);
    await expect(suits.announceVaultTransfers()).to.be.revertedWithCustomError(suits, 'AlreadyOpen');
    // nothing can close them, burn or take a copy
    const writes = suits.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name);
    for (const no of ['burn', 'burnBatch', 'closeVaultTransfers', 'seize', 'upgradeTo']) expect(writes).to.not.include(no);
  });
});
