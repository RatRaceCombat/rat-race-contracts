// The 2026-10-13 security reviews of RatRaceDistributor: each attack they proved, replayed against the
// fixed contract with the V1 production settings (delay 10 minutes, steps 50,000 / 20,000, bounty 50,
// caps 50,000 out / 20,000 burned in any 24 hours), plus the limits the team put on its own powers.
// The second review (82, the same evening) is tagged R2: the owner is a 2-of-3 Safe, the effort goes on
// the hot keys (the checkpoint signer) and the delays that warn the public.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { REAL_DIST, limits, DAY: ONE_DAY } = require('./helpers/timings.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const coder = ethers.AbiCoder.defaultAbiCoder();
const leafOf = (p, c) => ethers.keccak256(ethers.keccak256(coder.encode(['address', 'uint256'], [p, c])));
const pair = (a, b) => ethers.keccak256(ethers.concat(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));
function tree(entries) {
  let level = entries.map(([p, c]) => leafOf(p, c));
  const layers = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i], level[i + 1]) : level[i]);
    layers.push((level = next));
  }
  const proof = (i) => {
    const out = [];
    for (const layer of layers.slice(0, -1)) {
      if ((i ^ 1) < layer.length) out.push(layer[i ^ 1]);
      i >>= 1;
    }
    return out;
  };
  return { root: layers.at(-1)[0], proof, total: entries.reduce((s, [, c]) => s + c, 0n) };
}
async function sign(dist, signer, cp) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'RatRaceDistributor', version: '1', chainId, verifyingContract: await dist.getAddress() };
  const types = { Checkpoint: [
    { name: 'epoch', type: 'uint64' }, { name: 'root', type: 'bytes32' }, { name: 'withdrawTotal', type: 'uint256' },
    { name: 'burnTotal', type: 'uint256' }, { name: 'potTotal', type: 'uint256' }, { name: 'bounty', type: 'uint256' },
  ] };
  return signer.signTypedData(domain, types, cp);
}
const args = (cp, sig) => [cp.epoch, cp.root, cp.withdrawTotal, cp.burnTotal, cp.potTotal, cp.bounty, sig];
const HOUR = 3600;
const DAY = 24 * HOUR;
const wait = async (s) => { await ethers.provider.send('evm_increaseTime', [s]); await ethers.provider.send('evm_mine', []); };
const EPOCH = 600; // RatRaceDistributor.EPOCH: 10 minutes
const DELAY = 600; // the V1 delay: MIN_DELAY, the veto window
const epochNow = async () => BigInt(Math.floor((await ethers.provider.getBlock('latest')).timestamp / EPOCH));
const ADMIN = new ethers.Interface([
  'function setSigner(address)', 'function setGuardian(address)', 'function setTeam(address)',
  'function setLimits(uint64,uint256,uint256,uint256)', 'function sweep(uint256)',
]);

async function deploy() {
  const s = await ethers.getSigners();
  const [owner, game, guardian, team, alice, bob, attacker, newSigner, newGuardian] = s;
  const sentinel = s[10];
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const dist = await (await ethers.getContractFactory('RatRaceDistributor')).deploy(
    owner.address, await rat.getAddress(), game.address, guardian.address, sentinel.address, team.address,
    limits(DELAY, RAT(50000), RAT(20000), RAT(50), RAT(50000), RAT(20000)), REAL_DIST);
  await rat.mint(await dist.getAddress(), RAT(1000000));
  return { dist, rat, owner, game, guardian, team, alice, bob, attacker, newSigner, newGuardian, sentinel };
}

describe('RatRaceDistributor security fixes (reviews of 2026-10-13)', () => {
  // these tests move the clock by weeks: put it back after each one (the vesting tests need today's date)
  let snapshot;
  beforeEach(async () => { snapshot = await ethers.provider.send('evm_snapshot', []); });
  afterEach(async () => { await ethers.provider.send('evm_revert', [snapshot]); });

  it('R2 M-2: an epoch more than an hour ahead of the clock is refused, so a stolen signer holds publishing up an hour at most', async () => {
    const { dist, game, attacker, sentinel } = await deploy();
    const h = await epochNow();
    for (const epoch of [2n ** 64n - 1n, h + 146n, h + 7n]) {
      const cp = { epoch, root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: 0n, potTotal: 0n, bounty: 0n };
      await expect(dist.connect(attacker).publish(...args(cp, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'EpochTooFar');
    }
    const ahead = { epoch: h + 6n, root: ethers.ZeroHash, withdrawTotal: RAT(50000), burnTotal: RAT(20000), potTotal: 0n, bounty: 0n };
    await dist.connect(attacker).publish(...args(ahead, await sign(dist, game, ahead)));
    // vetoed in its delay: its inflated totals never become the floor of the next checkpoints
    await dist.connect(sentinel).veto();
    await wait(7 * EPOCH);
    const next = { epoch: await epochNow(), root: ethers.ZeroHash, withdrawTotal: RAT(10), burnTotal: 0n, potTotal: 0n, bounty: 0n };
    expect(next.epoch > ahead.epoch).to.equal(true);
    await dist.publish(...args(next, await sign(dist, game, next)));
    expect(await dist.lastPublishedEpoch()).to.equal(next.epoch);
    await wait(DELAY);
    await dist.activate();
    expect((await dist.active()).withdrawTotal).to.equal(RAT(10));
  });

  it('timings: the real ones by default (testMode false); a test only shortens them, in their order', async () => {
    const { dist, rat, owner, game, guardian, team, stranger } = await (async () => ({ ...(await deploy()), stranger: (await ethers.getSigners())[11] }))();
    expect(await dist.testMode()).to.equal(false);
    expect([await dist.TIMELOCK(), await dist.TIMELOCK_RAISE(), await dist.TIMELOCK_LONG(), await dist.EXECUTION_WINDOW(), await dist.PAUSE_MAX(), await dist.PAUSE_PERIOD()].map(Number))
      .to.deep.equal(Object.values(REAL_DIST));
    expect(Number(await dist.MAX_DELAY())).to.equal(ONE_DAY);
    expect(Number(await dist.MIN_PAUSE())).to.equal(HOUR);
    const F = await ethers.getContractFactory('RatRaceDistributor');
    const make = (t) => F.deploy(owner.address, rat.getAddress(), game.address, guardian.address, ethers.ZeroAddress, team.address, limits(DELAY, RAT(50000), RAT(20000), RAT(50), RAT(50000), RAT(20000)), t);
    // a test deployment: an hour for a change, two for a raise or a guardian, a day to execute, an hour of pause
    const TEST = { timelock: HOUR, timelockRaise: 2 * HOUR, timelockLong: 2 * HOUR, executionWindow: ONE_DAY, pauseMax: 2 * HOUR, pausePeriod: 4 * HOUR };
    const t = await make(TEST);
    expect(await t.testMode()).to.equal(true);
    expect(Number(await t.TIMELOCK())).to.equal(HOUR);
    expect(Number(await t.MAX_DELAY())).to.equal(2 * HOUR); // (a veto still fits the credit)
    expect(Number(await t.freezeCreditNow())).to.equal(2 * HOUR);
    const swap = ADMIN.encodeFunctionData('setSigner', [stranger.address]);
    await t.connect(owner).schedule(swap);
    await wait(HOUR);
    await t.connect(owner).execute(swap);
    expect(await t.signer()).to.equal(stranger.address);
    // never longer than the real ones, never 0, never out of their order, a pause at least the veto window
    for (const bad of [
      { ...REAL_DIST, timelock: REAL_DIST.timelock + 1 }, { ...REAL_DIST, pauseMax: REAL_DIST.pauseMax + 1 }, { ...REAL_DIST, executionWindow: 0 },
      { ...TEST, timelockRaise: HOUR - 1 }, { ...TEST, timelockLong: HOUR }, { ...TEST, pauseMax: HOUR - 1 },
      { ...TEST, pausePeriod: HOUR - 1 }, { ...TEST, timelock: 300, timelockRaise: 300, timelockLong: 300, pauseMax: 300 },
      // the real margins kept: a pause of the timelock and min(a day, the timelock), a refill longer than the pause
      { ...TEST, pauseMax: 2 * HOUR - 1 }, { ...TEST, pausePeriod: 2 * HOUR },
    ]) await expect(make(bad)).to.be.revertedWithCustomError(dist, 'BadTimings');
  });

  it('R2 M-1: a delay of 0 is refused, so every checkpoint waits a veto window', async () => {
    const { dist, rat, owner, game, guardian, team } = await deploy();
    const F = await ethers.getContractFactory('RatRaceDistributor');
    await expect(F.deploy(owner.address, await rat.getAddress(), game.address, guardian.address, ethers.ZeroAddress, team.address,
      limits(0, RAT(50000), RAT(20000), RAT(50), RAT(50000), RAT(20000)), REAL_DIST)).to.be.revertedWithCustomError(dist, 'TooLittle');
    await expect(dist.connect(owner).execute(ADMIN.encodeFunctionData('setLimits', [0, RAT(50000), RAT(20000), RAT(50)]))).to.be.revertedWithCustomError(dist, 'NotScheduled');
    const lower = ADMIN.encodeFunctionData('setLimits', [EPOCH - 1, RAT(50000), RAT(20000), RAT(50)]);
    await dist.connect(owner).schedule(lower);
    await wait(3 * DAY);
    await expect(dist.connect(owner).execute(lower)).to.be.revertedWithCustomError(dist, 'TooLittle');
  });

  it('R2 M-1: a stolen signer\'s checkpoint waits its delay: the sentinel vetoes it, then pauses, and nothing leaves', async () => {
    const { dist, rat, game, alice, attacker, sentinel } = await deploy();
    const t1 = tree([[alice.address, RAT(1000)]]);
    const cp1 = { epoch: 1n, root: t1.root, withdrawTotal: t1.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp1, await sign(dist, game, cp1)));
    await wait(DELAY);
    // the stolen key: 40,000 to the attacker, and its claim in the same transaction finds nothing to take
    const steal = tree([[attacker.address, RAT(40000)], [alice.address, RAT(1000)]]);
    const cp2 = { epoch: 2n, root: steal.root, withdrawTotal: steal.total, burnTotal: RAT(20000), potTotal: 0n, bounty: RAT(50) };
    await expect(dist.connect(attacker).publishAndClaim(...args(cp2, await sign(dist, game, cp2)), attacker.address, RAT(40000), steal.proof(0)))
      .to.be.revertedWithCustomError(dist, 'BadProof'); // (the claim is against the active root, not its own)
    await dist.connect(attacker).publish(...args(cp2, await sign(dist, game, cp2)));
    await expect(dist.connect(attacker).claim(attacker.address, RAT(40000), steal.proof(0))).to.be.revertedWithCustomError(dist, 'BadProof');
    // the watcher sees a root the game never signed: veto, then pause (the owner replaces the signer meanwhile)
    await expect(dist.connect(sentinel).veto()).to.emit(dist, 'Vetoed').withArgs(2n, sentinel.address, DELAY, 0n);
    await dist.connect(sentinel).pause();
    await wait(DELAY);
    await expect(dist.connect(attacker).claim(attacker.address, RAT(40000), steal.proof(0))).to.be.revertedWithCustomError(dist, 'EnforcedPause');
    expect(await rat.balanceOf(attacker.address)).to.equal(RAT(50)); // its bounty, no more
    expect(await dist.burned()).to.equal(0n);
    expect((await dist.active()).root).to.equal(t1.root);
  });

  it('H-2: unwatched, a bad root still cannot take more than the daily cap, whatever backlog the players left unclaimed', async () => {
    const { dist, rat, game, guardian, alice, bob, attacker } = await deploy();
    // two honest days: alice and bob may withdraw 50,000 each, and nobody claimed yet
    const t1 = tree([[alice.address, RAT(50000)]]);
    const cp1 = { epoch: 1n, root: t1.root, withdrawTotal: t1.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp1, await sign(dist, game, cp1)));
    await wait(25 * HOUR);
    const t2 = tree([[alice.address, RAT(50000)], [bob.address, RAT(50000)]]);
    const cp2 = { epoch: 2n, root: t2.root, withdrawTotal: t2.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp2, await sign(dist, game, cp2)));
    await wait(DELAY);
    // a stolen signer key gives the whole 100,000 backlog to the attacker and nobody vetoes: one day's cap leaves, no more
    const steal = tree([[attacker.address, RAT(100000)], [bob.address, 1n]]);
    const cp3 = { epoch: 3n, root: steal.root, withdrawTotal: RAT(100000), burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.connect(attacker).publish(...args(cp3, await sign(dist, game, cp3)));
    await wait(DELAY);
    await dist.connect(attacker).claim(attacker.address, RAT(100000), steal.proof(0));
    expect(await rat.balanceOf(attacker.address)).to.equal(RAT(50000));
    expect(await dist.paidRoom()).to.equal(0n);
    await expect(dist.connect(attacker).claim(attacker.address, RAT(100000), steal.proof(0))).to.be.revertedWithCustomError(dist, 'OverDailyCap');
    // the guardian pauses: the rest stays in the contract until the signer is replaced
    await dist.connect(guardian).pause();
    await wait(DAY + HOUR);
    await expect(dist.connect(attacker).claim(attacker.address, RAT(100000), steal.proof(0))).to.be.revertedWithCustomError(dist, 'EnforcedPause');
    expect(await rat.balanceOf(attacker.address)).to.equal(RAT(50000));
  });

  it('H-2: honest players claim normally under the daily cap', async () => {
    const { dist, rat, game, alice, bob } = await deploy();
    const t = tree([[alice.address, RAT(30000)], [bob.address, RAT(20000)]]);
    const cp = { epoch: 1n, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await expect(dist.claim(alice.address, RAT(30000), t.proof(0))).to.be.revertedWithCustomError(dist, 'NoActiveCheckpoint');
    await wait(DELAY);
    await dist.claim(alice.address, RAT(30000), t.proof(0));
    await dist.claim(bob.address, RAT(20000), t.proof(1));
    expect(await rat.balanceOf(alice.address) + await rat.balanceOf(bob.address)).to.equal(RAT(50000));
    expect(await dist.paidRoom()).to.equal(0n);
  });

  it('R2 L-3: a proof of the root active just before still claims, so a checkpoint activating meanwhile breaks no claim', async () => {
    const { dist, rat, game, alice, bob } = await deploy();
    const t1 = tree([[alice.address, RAT(100)], [bob.address, RAT(10)]]);
    const cp1 = { epoch: 1n, root: t1.root, withdrawTotal: t1.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp1, await sign(dist, game, cp1)));
    await wait(DELAY);
    await dist.activate();
    // alice fetched her proof of cp1; cp2 (alice 300) activates before her claim lands
    const t2 = tree([[alice.address, RAT(300)], [bob.address, RAT(10)]]);
    const cp2 = { epoch: 2n, root: t2.root, withdrawTotal: t2.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp2, await sign(dist, game, cp2)));
    await wait(DELAY);
    await dist.activate();
    expect(await dist.previousRoot()).to.equal(t1.root);
    await dist.claim(alice.address, RAT(100), t1.proof(0));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(100));
    await dist.claim(alice.address, RAT(300), t2.proof(0)); // the rest with the new proof
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(300));
    // two checkpoints back, a proof no longer counts
    const t3 = tree([[alice.address, RAT(300)], [bob.address, RAT(20)]]);
    const cp3 = { epoch: 3n, root: t3.root, withdrawTotal: t3.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp3, await sign(dist, game, cp3)));
    await wait(DELAY);
    await dist.activate();
    await expect(dist.claim(bob.address, RAT(10), t1.proof(1))).to.be.revertedWithCustomError(dist, 'BadProof');
    await dist.claim(bob.address, RAT(10), t2.proof(1)); // (cp2, the one before)
    expect(await rat.balanceOf(bob.address)).to.equal(RAT(10));
  });

  it('R2 L-3: a root of a replaced signer key never claims past the first checkpoint of the new key', async () => {
    const { dist, owner, game, alice, attacker, newSigner } = await deploy();
    // the stolen key's root went active unwatched
    const bad = tree([[attacker.address, RAT(20000)], [alice.address, RAT(10)]]);
    const cp1 = { epoch: 1n, root: bad.root, withdrawTotal: bad.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp1, await sign(dist, game, cp1)));
    await wait(DELAY);
    await dist.activate();
    // the owner replaces the key; the new key's first checkpoint keeps the totals (the ledger is reconciled later)
    const swap = ADMIN.encodeFunctionData('setSigner', [newSigner.address]);
    await dist.connect(owner).schedule(swap);
    await wait(3 * DAY);
    await dist.connect(owner).execute(swap);
    const good = tree([[alice.address, RAT(10)], [game.address, bad.total - RAT(10)]]);
    const cp2 = { epoch: 2n, root: good.root, withdrawTotal: bad.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp2, await sign(dist, newSigner, cp2)));
    await wait(DELAY);
    await dist.activate();
    expect(await dist.previousRoot()).to.equal(ethers.ZeroHash);
    await expect(dist.connect(attacker).claim(attacker.address, RAT(20000), bad.proof(0))).to.be.revertedWithCustomError(dist, 'BadProof');
    await dist.claim(alice.address, RAT(10), good.proof(0));
  });

  it('N-1: a claim bigger than the day\'s window pays what fits, and the same proof pays the rest on the next days', async () => {
    const { dist, rat, game, alice, bob } = await deploy();
    // 180,000 RAT published to alice over 4 days (an express withdrawal), claimed once at the end
    let t;
    for (let day = 1n; day <= 4n; day++) {
      t = tree([[alice.address, RAT(45000) * day], [bob.address, RAT(1)]]);
      const cp = { epoch: day, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
      await dist.publish(...args(cp, await sign(dist, game, cp)));
      await wait(DAY + HOUR);
    }
    const proof = t.proof(0);
    await dist.claim(alice.address, RAT(180000), proof);
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(50000)); // the day's window
    await expect(dist.claim(alice.address, RAT(180000), proof)).to.be.revertedWithCustomError(dist, 'OverDailyCap');
    for (let i = 0; i < 3; i++) {
      await wait(DAY + HOUR);
      await dist.claim(alice.address, RAT(180000), proof);
    }
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(180000));
    expect(await dist.claimed(alice.address)).to.equal(RAT(180000));
    await expect(dist.claim(alice.address, RAT(180000), proof)).to.be.revertedWithCustomError(dist, 'NothingToClaim');
    // what the last part left of the window still serves the other players
    await dist.claim(bob.address, RAT(1), t.proof(1));
    expect(await rat.balanceOf(bob.address)).to.equal(RAT(1));
  });

  it('N-3, R2 L-6: a day whose window is full still publishes: the bounty shrinks to what is left and counts only what was paid', async () => {
    const { dist, rat, game, alice, keeper } = await (async () => ({ ...(await deploy()), keeper: (await ethers.getSigners())[9] }))();
    const t = tree([[alice.address, RAT(50000)]]);
    const cp1 = { epoch: 1n, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp1, await sign(dist, game, cp1)));
    await wait(DAY + HOUR); // (a new day for what is published: only the paid window is full)
    await dist.claim(alice.address, RAT(50000), t.proof(0));
    expect(await dist.paidRoom()).to.equal(0n);
    const cp2 = { ...cp1, epoch: 2n, burnTotal: RAT(10), bounty: RAT(5) };
    await expect(dist.connect(keeper).publish(...args(cp2, await sign(dist, game, cp2))))
      .to.emit(dist, 'Published').withArgs(2n, cp2.root, cp2.withdrawTotal, RAT(10), 0n, keeper.address, 0n);
    expect(await rat.balanceOf(keeper.address)).to.equal(0n);
    expect(await dist.outflowRoom()).to.equal(RAT(50000)); // the unpaid bounty takes no room
    await wait(DELAY);
    await dist.activate();
    expect(await dist.burned()).to.equal(RAT(10));
  });

  it('H-3, R2 H-1: the guardian cannot block its own replacement (14 days in public), and its pauses end by themselves', async () => {
    const { dist, owner, guardian, newGuardian } = await deploy();
    await dist.connect(guardian).pause();
    const data = ADMIN.encodeFunctionData('setGuardian', [newGuardian.address]);
    await dist.connect(owner).schedule(data);
    await expect(dist.connect(guardian).cancel(ethers.keccak256(data))).to.be.revertedWithCustomError(dist, 'NotGuardian');
    // the guardian still cancels the other scheduled changes (it watches the owner too)
    const other = ADMIN.encodeFunctionData('setLimits', [DELAY, RAT(50000), RAT(20000), RAT(60)]);
    await dist.connect(owner).schedule(other);
    await dist.connect(guardian).cancel(ethers.keccak256(other));
    // the pause used the whole freeze credit (4 days): it ends by itself, and nobody can extend it
    expect(await dist.paused()).to.equal(true);
    await expect(dist.connect(owner).pause()).to.be.revertedWithCustomError(dist, 'EnforcedPause');
    await wait(4 * DAY + 1);
    expect(await dist.paused()).to.equal(false);
    // the credit refills at 4 days per 30 days of open withdrawals, for the owner too
    await expect(dist.connect(guardian).pause()).to.be.revertedWithCustomError(dist, 'NoFreezeCredit');
    await expect(dist.connect(owner).pause()).to.be.revertedWithCustomError(dist, 'NoFreezeCredit');
    await expect(dist.connect(owner).execute(data)).to.be.revertedWithCustomError(dist, 'NotReady');
    await wait(10 * DAY);
    await dist.connect(owner).execute(data); // (TIMELOCK_LONG, 14 days: the owner cannot swap its check quietly)
    expect(await dist.guardian()).to.equal(newGuardian.address);
    await wait(30 * DAY);
    expect(await dist.freezeCreditNow()).to.equal(BigInt(4 * DAY));
    // a false alarm: the owner unpauses after an hour and gets the rest of the credit back
    await dist.connect(newGuardian).pause();
    await wait(HOUR);
    await expect(dist.connect(owner).unpause()).to.emit(dist, 'Unpaused');
    const left = await dist.freezeCreditNow();
    expect(left > BigInt(4 * DAY - HOUR - 60) && left <= BigInt(4 * DAY - HOUR)).to.equal(true);
    await expect(dist.connect(owner).unpause()).to.be.revertedWithCustomError(dist, 'ExpectedPause');
  });

  it('pauses and vetoes together cannot hold the withdrawals more than about an eighth of the time', async () => {
    const { dist, guardian } = await deploy();
    // a hostile guardian pauses again every time it can, for 120 days
    const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
    const start = await now();
    const end = start + BigInt(120 * DAY);
    let paused = 0n;
    while ((await now()) < end) {
      if (!(await dist.paused())) {
        try {
          await dist.connect(guardian).pause();
          const until = await dist.pausedUntil();
          paused += (until < end ? until : end) - (await now());
        } catch { /* no credit yet */ }
      }
      await wait(HOUR);
    }
    // the full credit at the start, then the steady state 4 / (30 + 4), about 12% of the time
    const bound = 4 * DAY + (120 * DAY * 4) / 34;
    expect(Number(paused)).to.be.above(0.08 * 120 * DAY); // (it does pause)
    expect(Number(paused)).to.be.at.most(bound);
  });

  it('a veto uses the freeze credit: the owner cannot veto every checkpoint forever', async () => {
    const { dist, owner, game } = await deploy();
    await dist.connect(owner).setLimits(DAY, RAT(50000), RAT(20000), RAT(50)); // the longest delay (MAX_DELAY)
    let epoch = 0n;
    const next = async () => {
      const cp = { epoch: ++epoch, root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: 0n, potTotal: 0n, bounty: 0n };
      await dist.publish(...args(cp, await sign(dist, game, cp)));
    };
    for (let i = 0; i < 4; i++) { await next(); await dist.connect(owner).veto(); } // 4 x 1 day: the 4 days of credit
    await next();
    await expect(dist.connect(owner).veto()).to.be.revertedWithCustomError(dist, 'NoFreezeCredit');
    await wait(DAY);
    await dist.activate();
    expect((await dist.active()).epoch).to.equal(epoch); // it went through
  });

  it('R2 L-2: the delay never goes above a day, so a veto (it costs the delay) always fits in the freeze credit', async () => {
    const { dist, owner } = await deploy();
    await expect(dist.connect(owner).setLimits(DAY + 1, RAT(50000), RAT(20000), RAT(50))).to.be.revertedWithCustomError(dist, 'TooMuch');
    expect(await dist.MAX_DELAY()).to.be.at.most(await dist.PAUSE_MAX());
  });

  it('R2 L-1: a checkpoint past its delay is vetoed only in a pause (an emergency); nothing pending, nothing to veto', async () => {
    const { dist, game, guardian, alice } = await deploy();
    await expect(dist.connect(guardian).veto()).to.be.revertedWithCustomError(dist, 'NothingPending');
    const t = tree([[alice.address, RAT(100)]]);
    const cp1 = { epoch: 1n, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp1, await sign(dist, game, cp1)));
    await wait(DELAY);
    // players may claim against it now (activation is lazy): a routine veto is too late
    await expect(dist.connect(guardian).veto()).to.be.revertedWithCustomError(dist, 'TooLate');
    expect(await dist.claimable(alice.address, RAT(100))).to.equal(RAT(100));
    // a bad checkpoint nobody activated yet: the guardian pauses first, then drops it
    await dist.connect(guardian).pause();
    await expect(dist.connect(guardian).veto()).to.emit(dist, 'Vetoed');
    expect((await dist.pending()).activeAt).to.equal(0n);
  });

  it('FZ-1: a veto during a pause is never free, so pause, veto and unpause cannot loop forever', async () => {
    const { dist, owner, game, guardian } = await deploy();
    await dist.connect(owner).setLimits(2 * HOUR, RAT(50000), RAT(20000), RAT(50)); // a delay the floor allows
    let epoch = 0n;
    const next = async () => {
      const cp = { epoch: ++epoch, root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: 0n, potTotal: 0n, bounty: 0n };
      await dist.publish(...args(cp, await sign(dist, game, cp)));
    };
    // the owner's loop, in one block in practice: pause, veto, unpause; each round costs the delay
    let rounds = 0;
    for (;;) {
      await next();
      if ((await dist.freezeCreditNow()) < BigInt(HOUR)) break;
      await dist.connect(owner).pause();
      try { await dist.connect(owner).veto(); } catch { await dist.connect(owner).unpause(); break; }
      await dist.connect(owner).unpause();
      rounds++;
      if (rounds > 200) throw new Error('the loop never ran out');
    }
    expect(rounds).to.be.at.most((4 * 24) / 2 + 1); // 4 days of credit at 2 hours a veto: about 48, then it stops
    expect(rounds).to.be.at.least(44);
    // and the pending checkpoint goes through
    await wait(2 * HOUR);
    await dist.activate();
    expect((await dist.active()).epoch).to.equal(epoch);
    // a guardian's short pause cannot carry a veto that costs more than it has left
    await wait(4 * DAY);
    await next();
    await dist.connect(guardian).pause();
    const left = (await dist.pausedUntil()) - BigInt((await ethers.provider.getBlock('latest')).timestamp);
    if (left < BigInt(2 * HOUR)) await expect(dist.connect(guardian).veto()).to.be.revertedWithCustomError(dist, 'NoFreezeCredit');
  });

  it('claimable() says what a claim would really pay now', async () => {
    const { dist, game, alice, guardian } = await deploy();
    const t = tree([[alice.address, RAT(70000)], [game.address, 1n]]);
    const cp = { epoch: 1n, root: t.root, withdrawTotal: RAT(40000), burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    expect(await dist.claimable(alice.address, RAT(70000))).to.equal(0n); // (still in its delay)
    await wait(DELAY);
    expect(await dist.claimable(alice.address, RAT(70000))).to.equal(RAT(40000)); // the signed total
    await dist.claim(alice.address, RAT(70000), t.proof(0));
    expect(await dist.claimable(alice.address, RAT(70000))).to.equal(0n);
    await dist.connect(guardian).pause();
    expect(await dist.claimable(alice.address, RAT(80000))).to.equal(0n);
  });

  it('a pause stops publishing and claims, and only for a while', async () => {
    const { dist, game, guardian, alice } = await deploy();
    const t = tree([[alice.address, RAT(100)]]);
    const cp = { epoch: 1n, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.connect(guardian).pause();
    await expect(dist.publish(...args(cp, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'EnforcedPause');
    await wait(8 * DAY);
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await wait(DELAY);
    await dist.claim(alice.address, RAT(100), t.proof(0));
    expect(await dist.claimed(alice.address)).to.equal(RAT(100));
  });

  it('nobody can renounce the ownership', async () => {
    const { dist, owner } = await deploy();
    await expect(dist.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(dist, 'NoRenounce');
    expect(await dist.owner()).to.equal(owner.address);
  });

  it('nothing goes to the team: the pot share goes only to the pot fixed at deploy, under the burn cap', async () => {
    const { dist, rat, owner, game, team, attacker } = await deploy();
    // the pot cannot be changed: there is no such call
    await expect(dist.connect(owner).schedule(ADMIN.encodeFunctionData('setTeam', [attacker.address]))).to.be.revertedWithCustomError(dist, 'UnknownCall');
    expect(await dist.pot()).to.equal(team.address); // (a wallet as the pot address, by mistake)
    const cp = { epoch: 1n, root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: RAT(5000), potTotal: RAT(15000), bounty: 0n };
    // PL-1: a wallet as the pot never receives anything: no contract naming this distributor, no pot share
    await expect(dist.confirmPot()).to.be.revertedWithCustomError(dist, 'PotNotLinked');
    await expect(dist.publish(...args(cp, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'PotNotLinked');
    expect(await rat.balanceOf(team.address)).to.equal(0n);
    // a contract naming another distributor is refused too
    const stub = await (await ethers.getContractFactory('PotStub')).deploy();
    await stub.setDistributor(attacker.address);
    const linked = await (await ethers.getContractFactory('RatRaceDistributor')).deploy(
      owner.address, await rat.getAddress(), game.address, (await ethers.getSigners())[2].address, ethers.ZeroAddress, await stub.getAddress(),
      limits(DELAY, RAT(50000), RAT(20000), RAT(50), RAT(50000), RAT(20000)), REAL_DIST);
    await rat.mint(await linked.getAddress(), RAT(1000000));
    await expect(linked.confirmPot()).to.be.revertedWithCustomError(linked, 'PotNotLinked');
    // with the real link (the stub naming this distributor), the share goes to the pot, under the burn cap
    await stub.setDistributor(await linked.getAddress());
    await expect(linked.confirmPot()).to.emit(linked, 'PotLinked');
    const pot = await stub.getAddress();
    await linked.publish(...args(cp, await sign(linked, game, cp)));
    await wait(DELAY);
    await linked.activate();
    expect(await rat.balanceOf(pot)).to.equal(RAT(15000));
    expect(await linked.potPaid()).to.equal(RAT(15000));
    const d2 = linked;
    // burns and the pot's share share the 20,000 a day of the burn cap; nothing went to a wallet
    expect(await d2.burnRoom()).to.equal(0n);
    expect(await d2.paidRoom()).to.equal(RAT(50000));
    const more = { ...cp, epoch: 2n, potTotal: RAT(15001) };
    await expect(d2.publish(...args(more, await sign(d2, game, more)))).to.be.revertedWithCustomError(d2, 'OverDailyCap');
    expect(await rat.balanceOf(attacker.address)).to.equal(0n);
  });

  it('FZ-1R: a veto during a pause shortens the pause: pauses and vetoes together never hold more than the credit', async () => {
    const { dist, owner, game, guardian } = await deploy();
    await dist.connect(owner).setLimits(5 * HOUR, RAT(50000), RAT(20000), RAT(50));
    const cp = { epoch: 1n, root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await dist.connect(guardian).pause();
    const before = await dist.pausedUntil();
    await expect(dist.connect(guardian).veto()).to.emit(dist, 'Vetoed').withArgs(1n, guardian.address, 5 * HOUR, before - BigInt(5 * HOUR));
    expect(await dist.pausedUntil()).to.equal(before - BigInt(5 * HOUR)); // the veto came out of the pause
  });

  it('the outflow cap: lowered after 3 days, raised after 7, never above 200,000 nor under the steps or the 24,000 floor', async () => {
    const { dist, owner } = await deploy();
    const CAP = new ethers.Interface(['function setOutflowCap(uint256)']);
    const cut = CAP.encodeFunctionData('setOutflowCap', [RAT(40000)]);
    await expect(dist.connect(owner).schedule(cut)).to.emit(dist, 'Scheduled');
    expect(await dist.scheduledLong(ethers.keccak256(cut))).to.equal(false);
    await wait(3 * DAY);
    // the step (50,000) is above it: lower the step first (instant), then the cut applies
    await expect(dist.connect(owner).execute(cut)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await dist.connect(owner).setLimits(DELAY, RAT(40000), RAT(20000), RAT(50));
    await dist.connect(owner).execute(cut);
    expect(await dist.outflowCap()).to.equal(RAT(40000));
    // a raise waits 7 days
    const up = CAP.encodeFunctionData('setOutflowCap', [RAT(200000)]);
    await dist.connect(owner).schedule(up);
    expect(await dist.scheduledLong(ethers.keccak256(up))).to.equal(true);
    await wait(3 * DAY);
    await expect(dist.connect(owner).execute(up)).to.be.revertedWithCustomError(dist, 'NotReady');
    await wait(4 * DAY);
    await dist.connect(owner).execute(up);
    expect(await dist.outflowCap()).to.equal(RAT(200000));
    // never above the maximum, never under the floor
    for (const v of [RAT(200001), RAT(23999)]) {
      const d = CAP.encodeFunctionData('setOutflowCap', [v]);
      await dist.connect(owner).schedule(d);
      await wait(7 * DAY);
      await expect(dist.connect(owner).execute(d)).to.be.reverted;
    }
    // a cut scheduled for 3 days cannot turn into a raise because the cap fell meanwhile
    const at150 = CAP.encodeFunctionData('setOutflowCap', [RAT(150000)]);
    await dist.connect(owner).schedule(at150); // a cut from 200,000: 3 days
    const at100 = CAP.encodeFunctionData('setOutflowCap', [RAT(100000)]);
    await dist.connect(owner).schedule(at100);
    await wait(3 * DAY);
    await dist.connect(owner).execute(at100); // 100,000
    await expect(dist.connect(owner).execute(at150)).to.be.revertedWithCustomError(dist, 'NeedsTimelock'); // now a raise
  });

  it('nothing burns the spare RAT (no sweep): what no checkpoint owes stays for the rewards to come', async () => {
    const { dist, owner, game } = await deploy();
    await expect(dist.connect(owner).schedule(ADMIN.encodeFunctionData('sweep', [RAT(1)]))).to.be.revertedWithCustomError(dist, 'UnknownCall');
    const s = await dist.status();
    expect(s.surplus).to.equal(s.balance - s.owed);
    expect(s.surplus > 0n).to.equal(true);
    // the day's burn cap is the checkpoints' alone
    expect(await dist.burnRoom()).to.equal(RAT(20000));
    const cp = { epoch: await epochNow(), root: ethers.ZeroHash, withdrawTotal: 0n, burnTotal: RAT(20000), potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
  });

  it('L-1: when a bot publishes first and takes the bounty, the player\'s publish-and-claim still claims', async () => {
    const { dist, rat, game, alice, attacker } = await deploy();
    const t = tree([[alice.address, RAT(100)]]);
    const cp = { epoch: 1n, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: RAT(4) };
    const sig = await sign(dist, game, cp);
    await dist.connect(attacker).publish(...args(cp, sig));
    await wait(DELAY);
    await dist.connect(alice).publishAndClaim(...args(cp, sig), alice.address, RAT(100), t.proof(0));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(100));
  });

  it('L-2: a scheduled change lapses 14 days after it is ready; it must be announced again', async () => {
    const { dist, owner, newSigner } = await deploy();
    const data = ADMIN.encodeFunctionData('setSigner', [newSigner.address]);
    await dist.connect(owner).schedule(data);
    await wait(21 * DAY + 1);
    await expect(dist.connect(owner).execute(data)).to.be.revertedWithCustomError(dist, 'Expired');
    await dist.connect(owner).schedule(data);
    await wait(7 * DAY);
    await dist.connect(owner).execute(data);
    expect(await dist.signer()).to.equal(newSigner.address);
  });

  it('nobody can slow the withdrawals below 24,000 RAT a day, at once or through the timelock', async () => {
    const { dist, owner } = await deploy();
    // one checkpoint at a time, one an epoch at most: step x (24 h / max(delay, 10 min))
    // with the shortest delay (10 minutes) the step must be at least 24,000 / 144 RAT
    await expect(dist.connect(owner).setLimits(DELAY, RAT(166), RAT(20000), RAT(50))).to.be.revertedWithCustomError(dist, 'TooLittle');
    await expect(dist.connect(owner).setLimits(DAY, RAT(23999), 0, 0)).to.be.revertedWithCustomError(dist, 'TooLittle');
    await dist.connect(owner).setLimits(DELAY, RAT(1000), 0, 0); // 1,000 every 10 minutes
    await expect(dist.connect(owner).setLimits(2 * HOUR, RAT(1000), 0, 0)).to.be.revertedWithCustomError(dist, 'TooLittle');
    const back = ADMIN.encodeFunctionData('setLimits', [DAY, RAT(24000), 0, 0]); // 24,000 once a day: allowed
    await dist.connect(owner).schedule(back);
    const stop = ADMIN.encodeFunctionData('setLimits', [0, 0, 0, 0]);
    await dist.connect(owner).schedule(stop);
    await wait(7 * DAY);
    await dist.connect(owner).execute(back);
    expect(await dist.delay()).to.equal(BigInt(DAY));
    await expect(dist.connect(owner).execute(stop)).to.be.revertedWithCustomError(dist, 'TooLittle');
  });
});
