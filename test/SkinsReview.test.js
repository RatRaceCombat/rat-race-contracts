// RatRaceSkins after the security review of 2026-10-13: the owner's RAT floor per edition (a stolen
// quote key cannot sell a suit for 1 wei), the claim vouchers' own key, revoking a voucher, no plain
// buy(id), no renouncing, the royalties following the treasury.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { shopWith } = require('./helpers/suits.cjs'); // the shop on a permanent collection (RatRaceSuits)

const USDC = (n) => ethers.parseUnits(String(n), 6);
const RAT = (n) => ethers.parseUnits(String(n), 18);
const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);

async function deploy(split = [500, 500]) {
  const [owner, treasury, buyback, minter, quoter, claimer, alice, bob, rewards] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const skins = await shopWith([
    owner.address, await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address, 500,
    await rat.getAddress(), rewards.address, quoter.address, claimer.address, split
  ]);
  await rat.mint(alice.address, RAT(100000));
  await rat.connect(alice).approve(await skins.getAddress(), ethers.MaxUint256);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'RatRaceSkins', version: '1', chainId, verifyingContract: await skins.getAddress() };
  const { RAT_QUOTE_TYPES, CLAIM_TYPES } = await import('../shared/skins-chain.js');
  const quote = async (amount, extra = {}, by = quoter) => {
    const q = { player: alice.address, id: 8n, amount, referrer: ethers.ZeroAddress, orderId: ethers.hexlify(ethers.randomBytes(32)), deadline: (await now()) + 300n, version: await skins.quoteVersion(), ...extra };
    return [q, await by.signTypedData(domain, RAT_QUOTE_TYPES, q)];
  };
  const voucher = async (extra = {}, by = claimer) => {
    const v = { to: alice.address, id: 8n, amount: 1n, claimId: ethers.hexlify(ethers.randomBytes(32)), deadline: (await now()) + 3600n, ...extra };
    return [v.to, v.id, v.amount, v.claimId, v.deadline, await by.signTypedData(domain, CLAIM_TYPES, v)];
  };
  return { skins, usdc, rat, owner, treasury, buyback, minter, quoter, claimer, alice, bob, rewards, quote, voucher };
}

describe('RatRaceSkins after the security review of 2026-10-13', () => {
  it('M1: a RAT quote never goes below the owner\'s floor, and a RAT sale cannot open without one', async () => {
    const { skins, alice, bob, quote } = await deploy();
    await expect(skins.configureEdition(8, 1000, USDC(15), false, true)).to.be.revertedWithCustomError(skins, 'BadQuote');
    await skins.configureEdition(8, 1000, USDC(15), false, false);
    await expect(skins.connect(bob).setMinRatPrices([8], [RAT(500)])).to.be.revertedWithCustomError(skins, 'OwnableUnauthorizedAccount');
    await expect(skins.setMinRatPrices([8], [RAT(500)])).to.emit(skins, 'MinRatPriceSet').withArgs(8, RAT(500));
    await skins.configureEdition(8, 1000, USDC(15), false, true);
    expect((await skins.editions(8)).minRatPrice).to.equal(RAT(500));
    // a stolen quote key signs 1 wei: refused; at the floor: sold
    await expect(skins.connect(alice).buyRat(...(await quote(1n)))).to.be.revertedWithCustomError(skins, 'BadQuote');
    await expect(skins.connect(alice).buyRat(...(await quote(RAT(499))))).to.be.revertedWithCustomError(skins, 'BadQuote');
    await skins.connect(alice).buyRat(...(await quote(RAT(500))));
    expect(await skins.suits.balanceOf(alice.address, 8)).to.equal(1n);
    await expect(skins.setMinRatPrices([8, 9], [1n])).to.be.revertedWithCustomError(skins, 'LengthMismatch');
  });

  it('M1: the claim vouchers have their own key; the quote key never mints, and the two can never be the same', async () => {
    const { skins, usdc, rat, owner, treasury, buyback, minter, quoter, claimer, rewards, voucher } = await deploy();
    await skins.configureEdition(8, 1000, USDC(15), false, false);
    await skins.connect(minter).reserveGame([8], [2]);
    await expect(skins.claim(...(await voucher({}, quoter)))).to.be.revertedWithCustomError(skins, 'BadClaim');
    await skins.claim(...(await voucher()));
    const F = await ethers.getContractFactory('RatRaceSkins');
    await expect(shopWith([owner.address, await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address, 500, await rat.getAddress(), rewards.address, quoter.address, quoter.address, [500, 500]])).to.be.revertedWithCustomError(skins, 'SameKey');
    await expect(skins.setClaimSigner(quoter.address)).to.be.revertedWithCustomError(skins, 'SameKey');
    await expect(skins.setQuoteSigner(claimer.address)).to.be.revertedWithCustomError(skins, 'SameKey');
    await expect(skins.setClaimSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(skins, 'ZeroAddress');
  });

  it('M2: the minter or the owner revokes a voucher before it is used; a revoked voucher never mints', async () => {
    const { skins, minter, alice, bob, voucher } = await deploy();
    await skins.configureEdition(8, 1000, USDC(15), false, false);
    await skins.connect(minter).reserveGame([8], [3]);
    const v = await voucher();
    await expect(skins.connect(alice).revokeClaim(v[3])).to.be.revertedWithCustomError(skins, 'Unauthorized');
    await expect(skins.connect(minter).revokeClaim(v[3])).to.emit(skins, 'ClaimRevoked').withArgs(v[3], minter.address);
    await expect(skins.claim(...v)).to.be.revertedWithCustomError(skins, 'ClaimAlreadyUsed');
    expect(await skins.claimUsed(v[3])).to.equal(true);
    await expect(skins.connect(minter).revokeClaim(v[3])).to.be.revertedWithCustomError(skins, 'ClaimAlreadyUsed');
    const w = await voucher({ to: bob.address });
    await skins.revokeClaim(w[3]); // the owner too
    await expect(skins.claim(...w)).to.be.revertedWithCustomError(skins, 'ClaimAlreadyUsed');
    // a used voucher cannot be revoked
    const u = await voucher();
    await skins.claim(...u);
    await expect(skins.connect(minter).revokeClaim(u[3])).to.be.revertedWithCustomError(skins, 'ClaimAlreadyUsed');
    expect(await skins.reserved(8)).to.equal(2n, 'the revoked copies stay reserved until the minter releases them');
  });

  it('L2, L3: no buy without a price bound, no renouncing the ownership', async () => {
    const { skins } = await deploy();
    expect(skins.interface.fragments.some((f) => f.type === 'function' && f.name === 'buy')).to.equal(false);
    await expect(skins.renounceOwnership()).to.be.revertedWithCustomError(skins, 'NoRenounce');
  });

  it('Info: the royalties are the collection\'s (the treasury at deploy), set by its owner', async () => {
    const { skins, bob } = await deploy();
    expect(await skins.suits.royaltyInfo(8, USDC(100))).to.deep.equal([(await ethers.getSigners())[1].address, USDC(5)]);
    await expect(skins.suits.connect(bob).setRoyalty(bob.address, 250)).to.be.revertedWithCustomError(skins.suits, 'OwnableUnauthorizedAccount');
    await skins.suits.setRoyalty(bob.address, 250);
    expect(await skins.suits.royaltyInfo(8, USDC(100))).to.deep.equal([bob.address, USDC(2.5)]);
  });

  it('a real shop gives at most 5% to the pot and 5% to the referrer, and only ever pays a real pot (the review of 2026-10-13, M-2)', async () => {
    const { skins, usdc, rat, owner, treasury, buyback, minter, quoter, claimer, rewards } = await deploy();
    expect(await skins.testMode()).to.equal(false);
    const F = await ethers.getContractFactory('RatRaceSkins');
    const args = async (pot, split) => [owner.address, await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address, 500, await rat.getAddress(), pot, quoter.address, claimer.address, split];
    for (const split of [[501, 500], [500, 501], [0, 10000]]) await expect(shopWith([...(await args(rewards.address, split))])).to.be.revertedWithCustomError(F, 'BadBps');
    // a TEST pot makes a TEST shop: any split; and the shop never moves to a pot of the other kind
    const testPot = await (await ethers.getContractFactory('OwedMock')).deploy(await rat.getAddress());
    await testPot.setTestMode(true);
    const t = await shopWith([...(await args(await testPot.getAddress(), [1000, 200]))]);
    expect(await t.testMode()).to.equal(true);
    // its copies never pass for the real suits: their own name, symbol and metadata
    expect([await t.suits.name(), await t.suits.symbol(), await t.suits.uri(8)]).to.deep.equal(['Rat Race TEST Suits (no value)', 'RRTEST', 'https://dev.ratracecombat.com/api/nft/test/8.json']);
    expect([await skins.suits.name(), await skins.suits.symbol(), await skins.suits.uri(8)]).to.deep.equal(['Rat Race Combat Suits', 'RRCSUIT', 'https://play.ratracecombat.com/api/nft/8.json']);
    // the pot is fixed at deploy: nothing can redirect its share, TEST or real
    expect(F.interface.getFunction('setRatPayment')).to.equal(null);
    expect([await t.rewards(), await skins.rewards()]).to.deep.equal([await testPot.getAddress(), rewards.address]);
  });

  it('the RAT split is set at deploy (5% pot, 5% referrer for real), never over 100%', async () => {
    const { skins, rat, alice, bob, rewards, quote } = await deploy([500, 200]);
    expect([await skins.RAT_POT_BPS(), await skins.RAT_REFERRAL_BPS()]).to.deep.equal([500n, 200n]);
    await skins.setMinRatPrices([8], [RAT(100)]);
    await skins.configureEdition(8, 1000, USDC(15), false, true);
    const dead = '0x000000000000000000000000000000000000dEaD';
    const before = await rat.balanceOf(dead);
    await skins.connect(alice).buyRat(...(await quote(RAT(1000), { referrer: bob.address })));
    expect([await rat.balanceOf(rewards.address), await rat.balanceOf(bob.address), (await rat.balanceOf(dead)) - before]).to.deep.equal([RAT(50), RAT(20), RAT(930)]);
    const F = await ethers.getContractFactory('RatRaceSkins');
    const [owner, treasury, buyback, minter, quoter, claimer] = await ethers.getSigners();
    await expect(shopWith([owner.address, await skins.usdc(), treasury.address, buyback.address, 5000, minter.address, 500, await rat.getAddress(), rewards.address, quoter.address, claimer.address, [5001, 5000]])).to.be.revertedWithCustomError(F, 'BadBps');
  });
});
