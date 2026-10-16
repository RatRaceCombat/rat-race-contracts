// What a player can check on the explorer: the timelocks (3 days, 7 to raise the outflow cap, 14 for a new
// guardian) and the two daily caps cannot be bypassed; there is no sweep.
// The list of functions that change state is frozen here: a new admin function fails this test until
// someone decides whether it waits the timelock.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { REAL_DIST, limits } = require('./helpers/timings.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400;
// the calls only `execute` can make, after TIMELOCK (they are not functions of the contract's ABI)
const ADMIN = new ethers.Interface([
  'function setSigner(address)', 'function setGuardian(address)', 'function setSentinel(address)', 'function transferOwnership(address)', 'function setOutflowCap(uint256)', 'function setTeam(address)',
  'function setLimits(uint64,uint256,uint256,uint256)', 'function sweep(uint256)',
]);
const wait = async (s) => {
  await ethers.provider.send('evm_increaseTime', [s]);
  await ethers.provider.send('evm_mine', []);
};

async function deploy() {
  const [owner, game, guardian, team, stranger, next, sentinel] = await ethers.getSigners();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const dist = await (await ethers.getContractFactory('RatRaceDistributor')).deploy(
    owner.address, await rat.getAddress(), game.address, guardian.address, sentinel.address, team.address,
    limits(600, RAT(50000), RAT(50000), RAT(50), RAT(50000), RAT(100000)), REAL_DIST,
  );
  return { dist, rat, owner, game, guardian, team, stranger, next, sentinel };
}

describe('RatRaceDistributor admin surface (what the timelock covers)', () => {
  // these tests move the clock by weeks: put it back after each one (the vesting tests need today's date)
  let snapshot;
  beforeEach(async () => { snapshot = await ethers.provider.send('evm_snapshot', []); });
  afterEach(async () => { await ethers.provider.send('evm_revert', [snapshot]); });

  it('the state-changing functions are exactly these (a new one must be reviewed here)', async () => {
    const { dist } = await deploy();
    const writes = dist.interface.fragments
      .filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))
      .map((f) => f.name)
      .sort();
    expect(writes).to.deep.equal([
      'acceptOwnership', // the new owner of a two-step transfer (same powers, same timelock)
      'activate', // anybody: promotes a pending checkpoint after its delay
      'cancel', // owner or guardian: drops a scheduled change (the guardian never its own replacement)
      'cancelOwnerOffer', // owner: withdraws an owner offer not accepted yet
      'claim', // a player
      'confirmPot', // anybody: turns the pot share on once the pot is a contract naming this distributor
      'dropSentinel', // owner or guardian: removes the sentinel at once (it can only freeze)
      'execute', // owner: applies a scheduled change once TIMELOCK is over
      'pause', // owner, guardian or sentinel: stops claims for 4 days at most (an emergency brake, never a way out for RAT)
      'publish', // anybody, with the game's signature
      'publishAndClaim', // a player, with the game's signature
      'schedule', // owner: starts the public 3 days (7 for an outflow cap raise, 14 for a new guardian)
      'setLimits', // owner: tightening only, at once
      'unpause', // owner
      'veto', // guardian, owner or sentinel: drops a pending checkpoint before its delay is over (after it, only in a pause)
    ]);
  });

  it('the timelock is a constant of 3 days (7 to raise the outflow cap, 14 for a guardian), the caps have no direct setter, no sweep', async () => {
    const { dist, owner } = await deploy();
    await expect(dist.connect(owner).schedule(ADMIN.encodeFunctionData('sweep', [RAT(1)]))).to.be.revertedWithCustomError(dist, 'UnknownCall');
    expect(await dist.TIMELOCK()).to.equal(3n * BigInt(DAY));
    expect(await dist.TIMELOCK_RAISE()).to.equal(7n * BigInt(DAY));
    expect(await dist.TIMELOCK_LONG()).to.equal(14n * BigInt(DAY));
    expect(await dist.MIN_DELAY()).to.equal(600n);
    expect(await dist.MAX_DELAY()).to.equal(BigInt(DAY));
    expect(await dist.MAX_OUTFLOW_CAP()).to.equal(RAT(200000));
    expect(await dist.outflowCap()).to.equal(RAT(50000));
    expect(await dist.burnCap()).to.equal(RAT(100000));
    const names = dist.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
    for (const n of names) {
      if (/^[A-Z_]+$/.test(n)) continue; // (a constant: the selector of a timelocked call, e.g. SET_OUTFLOW_CAP)
      if (/^(set|update|change).*cap/i.test(n) || /^set(Timelock|TIMELOCK)/.test(n)) throw new Error(`${n} could change a fixed rule`);
    }
  });

  it('every change of signer, sentinel or a looser limit waits 3 days in public, a second short is refused; the pot never changes', async () => {
    const { dist, owner, stranger, next } = await deploy();
    const calls = [
      ADMIN.encodeFunctionData('setSigner', [stranger.address]),
      ADMIN.encodeFunctionData('setSentinel', [next.address]),
      ADMIN.encodeFunctionData('setLimits', [600, RAT(50000), RAT(50000), RAT(60)]), // a larger bounty
      ADMIN.encodeFunctionData('setLimits', [600, RAT(50001), RAT(50000), RAT(50)]), // a step above the daily cap
    ];
    for (const data of calls) {
      const tx = await dist.connect(owner).schedule(data);
      const at = (await ethers.provider.getBlock(tx.blockNumber)).timestamp + 3 * DAY;
      await expect(tx).to.emit(dist, 'Scheduled').withArgs(ethers.keccak256(data), data, at); // the exact call, on chain
      expect(await dist.scheduledAt(ethers.keccak256(data))).to.equal(at);
    }
    await wait(3 * DAY - 10);
    for (const data of calls) await expect(dist.connect(owner).execute(data)).to.be.revertedWithCustomError(dist, 'NotReady');
    await wait(10);
    await expect(dist.connect(stranger).execute(calls[0])).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    for (const data of calls.slice(0, 3)) await expect(dist.connect(owner).execute(data)).to.emit(dist, 'Executed');
    // even after its 3 days, no limit can go past the daily cap
    await expect(dist.connect(owner).execute(calls[3])).to.be.revertedWithCustomError(dist, 'TooMuch');
    expect(await dist.signer()).to.equal(stranger.address);
    expect(await dist.maxBounty()).to.equal(RAT(60));
    expect(await dist.maxStepWithdraw()).to.equal(RAT(50000));
    expect(await dist.sentinel()).to.equal(next.address);
  });

  it('H-1: a new guardian waits 14 days in public (the check on the owner), and the guardian cannot cancel it', async () => {
    const { dist, owner, guardian, stranger } = await deploy();
    const data = ADMIN.encodeFunctionData('setGuardian', [stranger.address]);
    const tx = await dist.connect(owner).schedule(data);
    const at = (await ethers.provider.getBlock(tx.blockNumber)).timestamp + 14 * DAY;
    await expect(tx).to.emit(dist, 'Scheduled').withArgs(ethers.keccak256(data), data, at);
    await expect(dist.connect(guardian).cancel(ethers.keccak256(data))).to.be.revertedWithCustomError(dist, 'NotGuardian');
    await wait(14 * DAY - 10);
    await expect(dist.connect(owner).execute(data)).to.be.revertedWithCustomError(dist, 'NotReady');
    await wait(10);
    await expect(dist.connect(owner).execute(data)).to.emit(dist, 'GuardianSet').withArgs(stranger.address);
    expect(guardian.address).to.not.equal(await dist.guardian());
  });

  it('M-1: the sentinel only pauses and vetoes; the owner or the guardian drops it at once; never the signer', async () => {
    const { dist, owner, game, guardian, sentinel, stranger } = await deploy();
    const id = ethers.keccak256(ADMIN.encodeFunctionData('setSigner', [stranger.address]));
    await dist.connect(owner).schedule(ADMIN.encodeFunctionData('setSigner', [stranger.address]));
    await expect(dist.connect(sentinel).cancel(id)).to.be.revertedWithCustomError(dist, 'NotGuardian');
    await expect(dist.connect(sentinel).schedule(ADMIN.encodeFunctionData('setSigner', [sentinel.address]))).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    await expect(dist.connect(sentinel).unpause()).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    await expect(dist.connect(sentinel).dropSentinel()).to.be.revertedWithCustomError(dist, 'NotGuardian');
    await expect(dist.connect(sentinel).veto()).to.be.revertedWithCustomError(dist, 'NothingPending');
    await expect(dist.connect(sentinel).pause()).to.emit(dist, 'Paused');
    await expect(dist.connect(owner).unpause()).to.emit(dist, 'Unpaused');
    await expect(dist.connect(guardian).dropSentinel()).to.emit(dist, 'SentinelSet').withArgs(ethers.ZeroAddress);
    await expect(dist.connect(sentinel).pause()).to.be.revertedWithCustomError(dist, 'NotGuardian');
    // a sentinel is never the checkpoint key (a leaked signer could then veto the honest checkpoints)
    const same = ADMIN.encodeFunctionData('setSentinel', [game.address]);
    await dist.connect(owner).schedule(same);
    await wait(3 * DAY);
    await expect(dist.connect(owner).execute(same)).to.be.revertedWithCustomError(dist, 'SameKey');
  });

  it('a new owner only through the timelock (3 days, then it accepts), and it gets no shortcut afterwards', async () => {
    const { dist, owner, stranger, next } = await deploy();
    await expect(dist.connect(owner).transferOwnership(next.address)).to.be.revertedWithCustomError(dist, 'NeedsTimelock');
    const move = ADMIN.encodeFunctionData('transferOwnership', [next.address]);
    await dist.connect(owner).schedule(move);
    await wait(3 * DAY);
    await expect(dist.connect(owner).execute(move)).to.emit(dist, 'OwnerOffered');
    expect(await dist.pendingOwner()).to.equal(next.address);
    await dist.connect(next).acceptOwnership();
    expect(await dist.owner()).to.equal(next.address);
    expect(await dist.ownerOfferUntil()).to.equal(0n);
    const data = ADMIN.encodeFunctionData('setSigner', [stranger.address]);
    await dist.connect(next).schedule(data);
    await expect(dist.connect(next).execute(data)).to.be.revertedWithCustomError(dist, 'NotReady');
    await expect(dist.connect(next).setLimits(600, RAT(60000), RAT(50000), RAT(50))).to.be.revertedWithCustomError(dist, 'NeedsTimelock');
  });

  it('L-5: an owner offer lapses 14 days after it is made, and the owner withdraws it at once', async () => {
    const { dist, owner, stranger, next } = await deploy();
    const move = ADMIN.encodeFunctionData('transferOwnership', [next.address]);
    await dist.connect(owner).schedule(move);
    await wait(3 * DAY);
    await dist.connect(owner).execute(move);
    await expect(dist.connect(stranger).cancelOwnerOffer()).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    await dist.connect(owner).cancelOwnerOffer();
    expect(await dist.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(dist.connect(next).acceptOwnership()).to.be.revertedWithCustomError(dist, 'Expired');
    // offered again, and not taken in time
    await dist.connect(owner).schedule(move);
    await wait(3 * DAY);
    await dist.connect(owner).execute(move);
    await wait(14 * DAY + 1);
    await expect(dist.connect(next).acceptOwnership()).to.be.revertedWithCustomError(dist, 'Expired');
    expect(await dist.owner()).to.equal(owner.address);
  });
});
