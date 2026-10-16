// RatRaceLaunch: the distributor and the pot deployed together, linked, in one transaction.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { REAL_DIST, REAL_POT, TEST_DIST, TEST_POT } = require('./helpers/timings.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);

async function launch(over = {}) {
  const [owner, game, guardian, potKey, player, sentinel] = await ethers.getSigners();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const params = {
    owner: owner.address, rat: await rat.getAddress(), signer: game.address, guardian: guardian.address, sentinel: sentinel.address,
    distTimings: REAL_DIST, potTimings: REAL_POT,
    delay: 600, maxStepWithdraw: RAT(50000), maxStepSettle: RAT(20000), maxBounty: RAT(50),
    outflowCap: RAT(50000), burnCap: RAT(20000), potSigner: potKey.address, nightBps: 1000, monthBps: 1000, ...over,
  };
  const L = await ethers.getContractFactory('RatRaceLaunch');
  const launcher = await L.deploy(params);
  const receipt = await launcher.deploymentTransaction().wait();
  const dist = await ethers.getContractAt('RatRaceDistributor', await launcher.distributor());
  const pot = await ethers.getContractAt('RatRacePot', await launcher.pot());
  return { launcher, receipt, dist, pot, rat, owner, game, guardian, potKey, player, sentinel, params };
}

const wait = async (s) => { await ethers.provider.send('evm_increaseTime', [s]); await ethers.provider.send('evm_mine', []); };

async function sign(dist, signer, cp) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'RatRaceDistributor', version: '1', chainId, verifyingContract: await dist.getAddress() };
  const types = { Checkpoint: [
    { name: 'epoch', type: 'uint64' }, { name: 'root', type: 'bytes32' }, { name: 'withdrawTotal', type: 'uint256' },
    { name: 'burnTotal', type: 'uint256' }, { name: 'potTotal', type: 'uint256' }, { name: 'bounty', type: 'uint256' },
  ] };
  return signer.signTypedData(domain, types, cp);
}

describe('RatRaceLaunch (the distributor and the pot, deployed together)', () => {
  it('one transaction: both deployed, linked both ways and confirmed, owned by the owner, the launcher holds no power', async () => {
    const { launcher, receipt, dist, pot, owner, guardian, sentinel } = await launch();
    expect(await dist.pot()).to.equal(await pot.getAddress());
    expect(await pot.distributor()).to.equal(await dist.getAddress());
    expect(await dist.potLinked()).to.equal(true);
    expect(await dist.owner()).to.equal(owner.address);
    expect(await pot.owner()).to.equal(owner.address);
    expect(await dist.guardian()).to.equal(guardian.address);
    expect(await dist.sentinel()).to.equal(sentinel.address);
    expect(await dist.delay()).to.equal(600n);
    expect(await dist.testMode()).to.equal(false); // the real time rules: a production launch
    await expect(launcher.deploymentTransaction()).to.emit(launcher, 'Launched').withArgs(await dist.getAddress(), await pot.getAddress(), false);
    expect(await launcher.testMode()).to.equal(false);
    // no function: the launcher keeps nothing but the two addresses
    const writes = launcher.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability));
    expect(writes.length).to.equal(0);
    // HyperEVM: over the small blocks' 2M gas, well under a big block's 30M
    expect(receipt.gasUsed).to.be.below(30_000_000n);
    console.log(`      (launch gas: ${receipt.gasUsed})`);
  });

  it('the pot share of a checkpoint reaches the pot once it activates, under the burn cap', async () => {
    const { dist, pot, rat, game } = await launch();
    await rat.mint(await dist.getAddress(), RAT(1_000_000));
    const cp = { epoch: 1n, root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: RAT(100), potTotal: RAT(400), bounty: 0n };
    await dist.publish(cp.epoch, cp.root, cp.withdrawTotal, cp.burnTotal, cp.potTotal, cp.bounty, await sign(dist, game, cp));
    expect(await rat.balanceOf(await pot.getAddress())).to.equal(0n); // (its veto window first)
    await wait(600);
    await dist.activate();
    expect(await rat.balanceOf(await pot.getAddress())).to.equal(RAT(400));
    expect(await dist.potPaid()).to.equal(RAT(400));
  });

  it('status(): everything in one call, the same as the separate views', async () => {
    const { dist, pot, rat, owner, game, guardian, sentinel } = await launch();
    await rat.mint(await dist.getAddress(), RAT(1000));
    const cp = { epoch: 1n, root: ethers.ZeroHash, withdrawTotal: RAT(100), burnTotal: RAT(10), potTotal: RAT(20), bounty: 0n };
    await dist.publish(cp.epoch, cp.root, cp.withdrawTotal, cp.burnTotal, cp.potTotal, cp.bounty, await sign(dist, game, cp));
    expect((await dist.status()).owed).to.equal(RAT(130)); // pending: what it will burn and send too
    await wait(600);
    await dist.activate();
    const s = await dist.status();
    expect(s.balance).to.equal(RAT(970)); // (10 burned, 20 to the pot)
    expect(s.owed).to.equal(RAT(100));
    expect(s.surplus).to.equal(RAT(870));
    expect([s.owner, s.signer, s.guardian, s.sentinel, s.pot]).to.deep.equal([owner.address, game.address, guardian.address, sentinel.address, await pot.getAddress()]);
    expect(s.potLinked).to.equal(true);
    expect(s.potPaid).to.equal(RAT(20));
    expect(s.burnRoom).to.equal(await dist.burnRoom());
    expect(s.paidRoom).to.equal(await dist.paidRoom());
    expect(s.freezeCredit).to.equal(await dist.freezeCreditNow());
    expect(s.epochNow).to.equal(BigInt(Math.floor((await ethers.provider.getBlock('latest')).timestamp / 600)));
    expect(s.active.potTotal).to.equal(RAT(20));
    expect(s.pending.activeAt).to.equal(0n);
  });

  it('a test launch: both test (short time rules), a change in an hour; never a real one mixed with a test one', async () => {
    const { launcher, dist, pot, owner } = await launch({ distTimings: TEST_DIST, potTimings: TEST_POT });
    expect([await launcher.testMode(), await dist.testMode(), await pot.testMode()]).to.deep.equal([true, true, true]);
    await expect(launcher.deploymentTransaction()).to.emit(launcher, 'Launched').withArgs(await dist.getAddress(), await pot.getAddress(), true);
    const swap = new ethers.Interface(['function setSigner(address)']).encodeFunctionData('setSigner', [owner.address]);
    await dist.connect(owner).schedule(swap);
    await wait(TEST_DIST.timelock);
    await dist.connect(owner).execute(swap);
    expect(await dist.signer()).to.equal(owner.address);
    // a real distributor with a test pot, or the other way: refused, nothing deployed (the pot itself refuses
    // a distributor of the other kind since the review of 46fc023; the Launch's MixedTimings stays behind it)
    const P = await ethers.getContractFactory('RatRacePot');
    await expect(launch({ distTimings: REAL_DIST, potTimings: TEST_POT })).to.be.revertedWithCustomError(P, 'BadDistributor');
    await expect(launch({ distTimings: TEST_DIST, potTimings: REAL_POT })).to.be.revertedWithCustomError(P, 'BadDistributor');
  });

  it('refuses the same key for the checkpoints and the pot draws, or as the sentinel; nothing is deployed then', async () => {
    const [, game, , potKey] = await ethers.getSigners();
    const L = await ethers.getContractFactory('RatRaceLaunch');
    await expect(launch({ potSigner: game.address })).to.be.revertedWithCustomError(L, 'SameKey');
    await expect(launch({ sentinel: game.address })).to.be.revertedWithCustomError(L, 'SameKey');
    await expect(launch({ sentinel: potKey.address })).to.be.revertedWithCustomError(L, 'SameKey');
    const { dist } = await launch({ sentinel: ethers.ZeroAddress }); // (no sentinel: allowed)
    expect(await dist.sentinel()).to.equal(ethers.ZeroAddress);
    await expect(launch({ delay: 0 })).to.be.reverted; // (no veto window: refused by the distributor)
  });
});
