// The founders' vesting: OpenZeppelin's VestingWallet schedule,
// 300,000 RAT each, nothing before the launch, then linear over 365 days;
// the launch set at deploy, or by the beneficiary once with begin(), 30 days ahead at least, the RAT locked meanwhile. No admin (2026-10-14):
// only the beneficiary, who can neither renounce nor hand it over in one step.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const time = {
  setNextBlockTimestamp: (t) => ethers.provider.send('evm_setNextBlockTimestamp', [t]),
  increaseTo: async (t) => { await ethers.provider.send('evm_setNextBlockTimestamp', [t]); await ethers.provider.send('evm_mine', []); },
};

const RAT = (n) => ethers.parseUnits(String(n), 18);
let START; // the launch: set by deploy(), an hour after the chain's clock
const DURATION = 31536000; // 365 days, 12 months
const RELEASE = 'release(address)';

describe('Founders vesting (FoundersVesting: OpenZeppelin VestingWallet, no admin)', () => {
  let snapshot;
  beforeEach(async () => { snapshot = await ethers.provider.send('evm_snapshot', []); });
  afterEach(async () => { await ethers.provider.send('evm_revert', [snapshot]); });

  async function deploy() {
    START = (await ethers.provider.getBlock('latest')).timestamp + 3600;
    const [deployer, founderA, founderB, stranger, newWallet] = await ethers.getSigners();
    const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
    const V = await ethers.getContractFactory('FoundersVesting');
    const a = await V.deploy(founderA.address, START, DURATION);
    const b = await V.deploy(founderB.address, START, DURATION);
    for (const w of [a, b]) await rat.mint(await w.getAddress(), RAT(300000));
    return { rat, a, b, V, deployer, founderA, founderB, stranger, newWallet };
  }

  it('the schedule: 365 days from the launch set at deploy, never backdated over a day; another duration is a TEST vesting for good', async () => {
    expect(DURATION / 86400).to.equal(365);
    const { a, V, founderA } = await deploy();
    expect([await a.start(), await a.duration(), await a.owner(), await a.testMode()]).to.deep.equal([BigInt(START), BigInt(DURATION), founderA.address, false]);
    expect(await (await V.deploy(founderA.address, START + 86400 * 30, DURATION)).testMode()).to.equal(false); // (a launch a month ahead)
    expect(await (await V.deploy(founderA.address, START, 600)).testMode()).to.equal(true);
    // the real schedule never starts in the past (its RAT would be released at once); a day of clock slack only
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await expect(V.deploy(founderA.address, now - 2 * 86400, DURATION)).to.be.revertedWithCustomError(V, 'BackdatedStart');
    expect(await (await V.deploy(founderA.address, now - 3600, DURATION)).start()).to.equal(BigInt(now - 3600));
    expect(await (await V.deploy(founderA.address, now - 2 * 86400, 600)).testMode()).to.equal(true); // (a TEST vesting may start in the past)
  });

  it('nothing before the launch, then linear, all of it 365 days later; anyone may release, the RAT go to the founder', async () => {
    const { rat, a, b, founderA, founderB, stranger } = await deploy();
    const token = await rat.getAddress();
    await a.connect(stranger)[RELEASE](token);
    expect(await rat.balanceOf(founderA.address)).to.equal(0n);
    await time.increaseTo(START - 60);
    expect(await a['releasable(address)'](token)).to.equal(0n);
    await time.setNextBlockTimestamp(START + DURATION / 4);
    await a.connect(stranger)[RELEASE](token);
    expect(await rat.balanceOf(founderA.address)).to.equal(RAT(75000));
    expect(await rat.balanceOf(stranger.address)).to.equal(0n);
    await time.setNextBlockTimestamp(START + DURATION / 2);
    await b.connect(stranger)[RELEASE](token);
    expect(await rat.balanceOf(founderB.address)).to.equal(RAT(150000));
    await time.increaseTo(START + DURATION);
    await a[RELEASE](token);
    await b[RELEASE](token);
    expect(await rat.balanceOf(founderA.address)).to.equal(RAT(300000));
    expect(await rat.balanceOf(founderB.address)).to.equal(RAT(300000));
  });

  it('only the beneficiary hands it over, in two steps (the new wallet accepts); never renounced', async () => {
    const { rat, a, V, founderA, stranger, newWallet } = await deploy();
    await expect(a.connect(founderA).renounceOwnership()).to.be.revertedWithCustomError(V, 'NoRenounce');
    await expect(a.connect(stranger).transferOwnership(stranger.address)).to.be.revertedWithCustomError(V, 'OwnableUnauthorizedAccount');
    await a.connect(founderA).transferOwnership(newWallet.address);
    expect(await a.owner()).to.equal(founderA.address); // (not before the new wallet accepts)
    await expect(a.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(V, 'OwnableUnauthorizedAccount');
    await a.connect(newWallet).acceptOwnership();
    expect(await a.owner()).to.equal(newWallet.address);
    await time.increaseTo(START + DURATION);
    await a[RELEASE](await rat.getAddress());
    expect(await rat.balanceOf(newWallet.address)).to.equal(RAT(300000));
  });

  it('a start left to the beneficiary: the RAT locked from the deploy, nothing vests until it begins, once, 30 days ahead at least, by nobody else', async () => {
    const { rat, V, founderA, stranger } = await deploy();
    const v = await V.deploy(founderA.address, 0, DURATION);
    const token = await rat.getAddress();
    await rat.mint(await v.getAddress(), RAT(300000));
    expect([await v.startAtDeploy(), await v.begunAt(), await v.testMode()]).to.deep.equal([0n, 0n, false]);
    expect(await v.start()).to.equal(2n ** 64n - 1n); // (a time that never comes: nothing vests)
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await time.increaseTo(now + 600 * 86400); // (more than the whole schedule later: still nothing, not begun)
    expect(await v['releasable(address)'](token)).to.equal(0n);
    await v.connect(stranger)[RELEASE](token);
    expect(await rat.balanceOf(founderA.address)).to.equal(0n);
    // nobody but the beneficiary starts it; never sooner than 30 days ahead (every holder sees the date a month before)
    await expect(v.connect(stranger).begin(0)).to.be.revertedWithCustomError(V, 'OwnableUnauthorizedAccount');
    const t = (await ethers.provider.getBlock('latest')).timestamp;
    await expect(v.connect(founderA).begin(t - 10)).to.be.revertedWithCustomError(V, 'StartTooSoon');
    await expect(v.connect(founderA).begin(t + 29 * 86400)).to.be.revertedWithCustomError(V, 'StartTooSoon');
    expect(await v.MIN_NOTICE()).to.equal(30n * 86400n);
    // the beneficiary sets the launch 40 days ahead: it starts there, linear over 365 days
    const launch = t + 40 * 86400;
    await expect(v.connect(founderA).begin(launch)).to.emit(v, 'Begun').withArgs(launch);
    expect([await v.start(), await v.end()]).to.deep.equal([BigInt(launch), BigInt(launch + DURATION)]);
    await expect(v.connect(founderA).begin(0)).to.be.revertedWithCustomError(V, 'AlreadyBegun'); // (once)
    await time.increaseTo(launch - 60);
    expect(await v['releasable(address)'](token)).to.equal(0n);
    await time.setNextBlockTimestamp(launch + DURATION / 2);
    await v.connect(stranger)[RELEASE](token);
    expect(await rat.balanceOf(founderA.address)).to.equal(RAT(150000));
    // begin(0) takes the earliest start, 30 days on; a TEST vesting has no notice; a start fixed at deploy cannot be moved
    const w = await V.deploy(founderA.address, 0, DURATION);
    await w.connect(founderA).begin(0);
    expect(await w.begunAt()).to.equal(BigInt((await ethers.provider.getBlock('latest')).timestamp + 30 * 86400));
    const testV = await V.deploy(founderA.address, 0, 600);
    await testV.connect(founderA).begin(0);
    expect(await testV.begunAt()).to.equal(BigInt((await ethers.provider.getBlock('latest')).timestamp));
    const fixed = await V.deploy(founderA.address, (await ethers.provider.getBlock('latest')).timestamp + 86400, DURATION);
    await expect(fixed.connect(founderA).begin(0)).to.be.revertedWithCustomError(V, 'StartFixed');
  });

  it('no other power: the writes are release, the two-step hand-over and the blocked renounce; no admin', async () => {
    const { a } = await deploy();
    const writes = a.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
    expect(writes).to.deep.equal(['acceptOwnership', 'begin', 'release', 'release', 'transferOwnership']);
    expect(a.interface.getFunction('admin')).to.equal(null);
  });
});
