const { expect } = require('chai');
const { ethers } = require('hardhat');
const { shopWith } = require('./helpers/suits.cjs'); // the shop on a permanent collection (RatRaceSuits)
const { REAL_SPLIT } = require('./helpers/timings.cjs'); // the RAT shares of a purchase: pot, referrer (5% each)

const USDC = (n) => BigInt(Math.round(n * 1e6));

async function deploy() {
  const [owner, treasury, buyback, minter, alice, bob, relayer] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const skins = await shopWith([
    owner.address, await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address, 500,
    await rat.getAddress(), relayer.address, minter.address, treasury.address, REAL_SPLIT
  ]);
  await skins.configureEdition(14, 100, USDC(50), true, false); // Masked Rat
  await skins.configureEdition(8, 1000, USDC(5), true, false); // Cop
  for (const s of [alice, bob]) await usdc.mint(s.address, USDC(1000));
  return { skins, usdc, rat, owner, treasury, buyback, minter, alice, bob, relayer };
}

describe('RatRaceSkins (limited editions)', () => {
  it('a failed payment neither consumes stock nor leaves a partial treasury payment', async () => {
    const { skins, usdc, treasury, buyback, alice } = await deploy();
    const address = await skins.getAddress();
    await usdc.connect(alice).approve(address, USDC(2.5));
    await expect(skins.connect(alice).buyUsdc(8, ethers.MaxUint256)).to.be.reverted;
    expect(await skins.remaining(8)).to.equal(1000n);
    expect(await skins.suits.balanceOf(alice.address, 8)).to.equal(0n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(0n);
    expect(await usdc.balanceOf(buyback.address)).to.equal(0n);
    expect(await usdc.allowance(alice.address, address)).to.equal(USDC(2.5));
  });

  it('administration is owner-only, disabled sales stay closed and ERC interfaces are advertised', async () => {
    const { skins, alice, owner } = await deploy();
    await expect(skins.connect(alice).setMinter(alice.address)).to.be.revertedWithCustomError(skins, 'OwnableUnauthorizedAccount');
    await expect(skins.connect(alice).configureEdition(8, 1, 1, true, false)).to.be.revertedWithCustomError(skins, 'OwnableUnauthorizedAccount');
    await expect(skins.connect(alice).pause()).to.be.revertedWithCustomError(skins, 'OwnableUnauthorizedAccount');
    await expect(skins.setPayment(owner.address, alice.address, 10001)).to.be.revertedWithCustomError(skins, 'BadBps');
    await expect(skins.setPayment(ethers.ZeroAddress, alice.address, 0)).to.be.revertedWithCustomError(skins, 'ZeroAddress');
    await skins.configureEdition(8, 1000, USDC(5), false, false);
    await expect(skins.connect(alice).buyUsdc(8, ethers.MaxUint256)).to.be.revertedWithCustomError(skins, 'NotForSale');
    expect(await skins.suits.supportsInterface('0xd9b67a26')).to.equal(true); // ERC1155
    expect(await skins.suits.supportsInterface('0x2a55205a')).to.equal(true); // ERC2981
    expect(await skins.suits.supportsInterface('0xffffffff')).to.equal(false);
  });

  it('sells a suit at its fixed price, split between the treasury and the buyback wallet', async () => {
    const { skins, usdc, treasury, buyback, alice } = await deploy();
    await usdc.connect(alice).approve(await skins.getAddress(), USDC(5));
    await expect(skins.connect(alice).buyUsdc(8, ethers.MaxUint256)).to.emit(skins, 'Bought').withArgs(alice.address, 8, USDC(5), USDC(2.5));
    expect(await skins.suits.balanceOf(alice.address, 8)).to.equal(1n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(USDC(2.5));
    expect(await usdc.balanceOf(buyback.address)).to.equal(USDC(2.5));
    expect(await skins.remaining(8)).to.equal(999n);
  });

  it('an edition sells out and its cap can only go down', async () => {
    const { skins, usdc, owner, alice } = await deploy();
    await skins.connect(owner).configureEdition(13, 2, USDC(35), true, false);
    await usdc.connect(alice).approve(await skins.getAddress(), USDC(1000));
    await skins.connect(alice).buyUsdc(13, ethers.MaxUint256);
    await skins.connect(alice).buyUsdc(13, ethers.MaxUint256);
    await expect(skins.connect(alice).buyUsdc(13, ethers.MaxUint256)).to.be.revertedWithCustomError(skins, 'SoldOut');
    await expect(skins.connect(owner).configureEdition(13, 3, USDC(35), true, false)).to.be.revertedWithCustomError(skins, 'SupplyCanOnlyGoDown');
    await expect(skins.connect(owner).configureEdition(13, 1, USDC(35), true, false)).to.be.revertedWithCustomError(skins, 'SupplyCanOnlyGoDown'); // below minted
    await expect(skins.connect(alice).buyUsdc(99, ethers.MaxUint256)).to.be.revertedWithCustomError(skins, 'NotForSale'); // (an edition this shop does not sell)
  });

  it('the game mints nothing directly: it only reserves copies, within the cap (claims: SkinsClaims.test.js)', async () => {
    const { skins, minter, alice } = await deploy();
    expect(skins.interface.getFunction('mintTo')).to.equal(null);
    expect(skins.interface.getFunction('mintGamePaid')).to.equal(null);
    await expect(skins.connect(alice).reserveGame([14], [1])).to.be.revertedWithCustomError(skins, 'Unauthorized');
    await expect(skins.connect(minter).reserveGame([14], [1])).to.emit(skins, 'GameReserved').withArgs(14, 1, 1);
    expect(await skins.suits.balanceOf(minter.address, 14)).to.equal(0n);
    expect(await skins.remaining(14)).to.equal(99n);
  });

  it('pays a 5% royalty to the treasury, serves metadata, trades even when paused', async () => {
    const { skins, usdc, owner, treasury, alice, bob } = await deploy();
    const [receiver, amount] = await skins.suits.royaltyInfo(14, USDC(100));
    expect(receiver).to.equal(treasury.address);
    expect(amount).to.equal(USDC(5));
    expect(await skins.suits.uri(14)).to.equal('https://play.ratracecombat.com/api/nft/14.json');
    await usdc.connect(alice).approve(await skins.getAddress(), USDC(10));
    await skins.connect(alice).buyUsdc(8, ethers.MaxUint256);
    await skins.connect(owner).pause();
    await expect(skins.connect(alice).buyUsdc(8, ethers.MaxUint256)).to.be.revertedWithCustomError(skins, 'EnforcedPause');
    await skins.suits.connect(alice).safeTransferFrom(alice.address, bob.address, 8, 1, '0x');
    expect(await skins.suits.balanceOf(bob.address, 8)).to.equal(1n);
  });
});
