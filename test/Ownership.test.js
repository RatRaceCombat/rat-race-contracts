const { expect } = require('chai');
const { ethers } = require('hardhat');
const assert = require('node:assert/strict');
const { REAL_DIST, REAL_SPLIT, limits } = require('./helpers/timings.cjs');
const { shopWith } = require('./helpers/suits.cjs');
const { buildOwnershipPlan } = require('../scripts/lib/ownership-plan.cjs');

async function fixture() {
  const [trezor, deployer, next, replacement, signer, cosigner, guardian, team, buyback, minter] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC', deployer)).deploy();
  const rat = await (await ethers.getContractFactory('MockRAT', deployer)).deploy();
  const vault = await ethers.getContractFactory('RatRaceVault', deployer);
  const cfg = (token, price) => ({ owner: trezor.address, token, signer: signer.address, cosigner: cosigner.address,
    guardian: guardian.address, feeWallet: team.address, gemPrice: price, depositFeeBps: 0,
    dailyLimitGems: 1000, globalDailyLimitGems: 10000, coSignThresholdGems: 500 });
  const contracts = {
    USDC: await vault.deploy(cfg(await usdc.getAddress(), 100000)),
    RAT: await vault.deploy(cfg(await rat.getAddress(), ethers.parseEther('1'))),
    distributor: await (await ethers.getContractFactory('RatRaceDistributor', deployer)).deploy(
      trezor.address, await rat.getAddress(), signer.address, guardian.address, ethers.ZeroAddress, team.address,
      limits(1800, ethers.parseEther('50000'), ethers.parseEther('50000'), ethers.parseEther('50'), ethers.parseEther('50000'), ethers.parseEther('100000')), REAL_DIST),
    skins: await shopWith([
      trezor.address, await usdc.getAddress(), team.address, buyback.address, 5000, minter.address,
      500, await rat.getAddress(), team.address, signer.address, guardian.address, REAL_SPLIT], deployer),
  };
  // (the permanent collection: owned the same way, without a pause: its own test below)
  return { trezor, deployer, next, replacement, contracts, suits: contracts.skins.suits };
}

describe('Ownership: hardware wallet initially, two-step handover later', () => {
  // (the distributor hands over through its 3-day timelock: its own test below)
  it('distributor: starts owned by the hardware wallet; a new owner only through the 3-day timelock, then it accepts', async () => {
    const { trezor, deployer, next, contracts } = await fixture();
    const c = contracts.distributor;
    const DAY = 86400;
    expect(await c.owner()).to.equal(trezor.address);
    await expect(c.connect(trezor).transferOwnership(next.address)).to.be.revertedWithCustomError(c, 'NeedsTimelock');
    const move = new ethers.Interface(['function transferOwnership(address)']).encodeFunctionData('transferOwnership', [next.address]);
    await expect(c.connect(deployer).schedule(move)).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
    await c.connect(trezor).schedule(move);
    await ethers.provider.send('evm_increaseTime', [3 * DAY]);
    await ethers.provider.send('evm_mine', []);
    await c.connect(trezor).execute(move);
    expect(await c.owner()).to.equal(trezor.address); // until the exact proposed owner accepts
    await expect(c.connect(deployer).acceptOwnership()).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
    await c.connect(next).acceptOwnership();
    expect(await c.owner()).to.equal(next.address);
  });

  it('suits, the permanent collection: owned by the hardware wallet, handed over in two steps, never renounced', async () => {
    const { trezor, next, suits } = await fixture();
    expect(await suits.owner()).to.equal(trezor.address);
    await suits.connect(trezor).transferOwnership(next.address);
    expect(await suits.owner()).to.equal(trezor.address);
    await suits.connect(next).acceptOwnership();
    expect(await suits.owner()).to.equal(next.address);
    await expect(suits.connect(next).renounceOwnership()).to.be.revertedWithCustomError(suits, 'NoRenounce');
  });

  for (const kind of ['USDC', 'RAT', 'skins']) {
    describe(kind, () => {
      it('can start owned by the hardware wallet while a separate account pays deployment gas', async () => {
        const { trezor, deployer, next, contracts } = await fixture();
        const c = contracts[kind];
        expect(await c.owner()).to.equal(trezor.address);
        expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
        await expect(c.connect(deployer).transferOwnership(next.address)).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
      });

      it('keeps authority with the hardware wallet until the exact proposed owner accepts', async () => {
        const { trezor, deployer, next, contracts } = await fixture();
        const c = contracts[kind];
        await expect(c.connect(trezor).transferOwnership(next.address)).to.emit(c, 'OwnershipTransferStarted').withArgs(trezor.address, next.address);
        expect(await c.owner()).to.equal(trezor.address);
        expect(await c.pendingOwner()).to.equal(next.address);
        await expect(c.connect(next).pause()).to.be.reverted;
        await expect(c.connect(deployer).acceptOwnership()).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
        await expect(c.connect(next).acceptOwnership()).to.emit(c, 'OwnershipTransferred').withArgs(trezor.address, next.address);
        expect(await c.owner()).to.equal(next.address);
        expect(await c.pendingOwner()).to.equal(ethers.ZeroAddress);
        await expect(c.connect(trezor).unpause()).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
        await expect(c.connect(trezor).transferOwnership(deployer.address)).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
        await c.connect(next).pause();
      });

      it('can replace or cancel a proposal without giving the discarded address ownership', async () => {
        const { trezor, next, replacement, contracts } = await fixture();
        const c = contracts[kind];
        await c.connect(trezor).transferOwnership(next.address);
        await c.connect(trezor).transferOwnership(ethers.ZeroAddress);
        await expect(c.connect(next).acceptOwnership()).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
        expect(await c.owner()).to.equal(trezor.address);
        await c.connect(trezor).transferOwnership(next.address);
        await c.connect(trezor).transferOwnership(replacement.address);
        await expect(c.connect(next).acceptOwnership()).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
        await c.connect(replacement).acceptOwnership();
        expect(await c.owner()).to.equal(replacement.address);
      });

      it('can hand over a paused contract and only the new owner can resume it', async () => {
        const { trezor, next, contracts } = await fixture();
        const c = contracts[kind];
        await c.connect(trezor).pause();
        await c.connect(trezor).transferOwnership(next.address);
        await c.connect(next).acceptOwnership();
        await expect(c.connect(trezor).unpause()).to.be.revertedWithCustomError(c, 'OwnableUnauthorizedAccount');
        await c.connect(next).unpause();
        expect(await c.paused()).to.equal(false);
      });
    });
  }

  it('prepares only missing proposals and accepts, using the actual owner of each contract', async () => {
    const { trezor, next, contracts } = await fixture();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const targets = await Promise.all(Object.entries(contracts).map(async ([name, c]) => ({ name, address: await c.getAddress() })));
    await contracts.USDC.connect(trezor).transferOwnership(next.address);
    await contracts.RAT.connect(trezor).transferOwnership(next.address);
    await contracts.RAT.connect(next).acceptOwnership();
    const plan = await buildOwnershipPlan(ethers.provider, targets, next.address, 'trezor', chainId);
    expect(plan.proposals).to.have.length(2);
    expect(plan.proposals.every((tx) => tx.from === trezor.address)).to.equal(true);
    expect(plan.acceptances).to.have.length(3);
    expect(plan.acceptances.filter((tx) => tx.ready)).to.have.length(1);
    expect(plan.states.find((state) => state.name === 'RAT').status).to.equal('complete');
    expect(plan.transactionsSent).to.equal(0);
  });

  it('refuses a wrong chain, duplicate targets and a non-deployed Safe', async () => {
    const { next, contracts } = await fixture();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const target = { name: 'USDC', address: await contracts.USDC.getAddress() };
    await assert.rejects(buildOwnershipPlan(ethers.provider, [target], next.address, 'trezor', 999), /chain/);
    await assert.rejects(buildOwnershipPlan(ethers.provider, [target, target], next.address, 'trezor', chainId), /distinct/);
    await assert.rejects(buildOwnershipPlan(ethers.provider, [target], next.address, 'safe', chainId), /not deployed/);
  });
});
