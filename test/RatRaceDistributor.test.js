const { expect } = require('chai');
const { ethers } = require('hardhat');
const { REAL_DIST, limits } = require('./helpers/timings.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const DEAD = '0x000000000000000000000000000000000000dEaD';
const coder = ethers.AbiCoder.defaultAbiCoder();

// OpenZeppelin-style Merkle tree: leaf = keccak(keccak(abi.encode(player, cumulative))), sorted pairs
const leafOf = (player, cumulative) => ethers.keccak256(ethers.keccak256(coder.encode(['address', 'uint256'], [player, cumulative])));
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
      const sib = i ^ 1;
      if (sib < layer.length) out.push(layer[sib]);
      i >>= 1;
    }
    return out;
  };
  return { root: layers.at(-1)[0], proof, total: entries.reduce((s, [, c]) => s + c, 0n) };
}

async function sign(dist, signer, cp, domainOverrides = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'RatRaceDistributor', version: '1', chainId, verifyingContract: await dist.getAddress(), ...domainOverrides };
  const types = { Checkpoint: [
    { name: 'epoch', type: 'uint64' }, { name: 'root', type: 'bytes32' }, { name: 'withdrawTotal', type: 'uint256' },
    { name: 'burnTotal', type: 'uint256' }, { name: 'potTotal', type: 'uint256' }, { name: 'bounty', type: 'uint256' },
  ] };
  return signer.signTypedData(domain, types, cp);
}
const args = (cp, sig) => [cp.epoch, cp.root, cp.withdrawTotal, cp.burnTotal, cp.potTotal, cp.bounty, sig];
const HOUR = 3600;
const DAY = 24 * HOUR;
// the changes that wait the timelock (3 days; 14 for a guardian or a sweep), as schedule() and execute() take them
const ADMIN = new ethers.Interface([
  'function setSigner(address)', 'function setGuardian(address)', 'function setTeam(address)',
  'function setLimits(uint64,uint256,uint256,uint256)', 'function sweep(uint256)',
]);
const wait = async (s) => { await ethers.provider.send('evm_increaseTime', [s]); await ethers.provider.send('evm_mine', []); };

// the deploy's daily caps (fixed for good): 50,000 RAT may leave and 100,000 be burned in any 24 h
const OUTFLOW_CAP = RAT(50000);
const BURN_CAP = RAT(100000);

async function deploy({ delay = 1800, reserve = RAT(1000000) } = {}) {
  const [owner, game, guardian, team, alice, bob, carol, keeper] = await ethers.getSigners();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const dist = await (await ethers.getContractFactory('RatRaceDistributor')).deploy(
    owner.address, await rat.getAddress(), game.address, guardian.address, ethers.ZeroAddress, team.address,
    limits(delay, RAT(50000), RAT(50000), RAT(50), OUTFLOW_CAP, BURN_CAP), REAL_DIST,
  );
  await rat.mint(await dist.getAddress(), reserve); // the reserve
  return { dist, rat, owner, game, guardian, team, alice, bob, carol, keeper };
}

describe('RatRaceDistributor (checkpoints every 10 minutes, players claim)', () => {
  // some tests move the clock by weeks: put it back after each one (the vesting tests need today's date)
  let snapshot;
  beforeEach(async () => { snapshot = await ethers.provider.send('evm_snapshot', []); });
  afterEach(async () => { await ethers.provider.send('evm_revert', [snapshot]); });

  it('checkpoint signatures cannot cross chains or contracts', async () => {
    const { dist, game, alice, bob } = await deploy();
    const t = tree([[alice.address, RAT(10)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    for (const domain of [{ chainId: 999 }, { verifyingContract: bob.address }]) {
      await expect(dist.publish(...args(cp, await sign(dist, game, cp, domain)))).to.be.revertedWithCustomError(dist, 'BadSignature');
    }
    expect(await dist.lastPublishedEpoch()).to.equal(0n);
  });

  it('a vetoed checkpoint cannot be replayed to collect its bounty again', async () => {
    const { dist, rat, game, guardian, alice, keeper } = await deploy();
    const t = tree([[alice.address, RAT(500)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: RAT(5) };
    const signature = await sign(dist, game, cp);
    await dist.connect(keeper).publish(...args(cp, signature));
    await dist.connect(guardian).veto();
    await expect(dist.connect(keeper).publish(...args(cp, signature))).to.be.revertedWithCustomError(dist, 'StaleEpoch');
    expect(await rat.balanceOf(keeper.address)).to.equal(RAT(5));
  });

  it('a checkpoint and its bounty must be fully backed by the reserve', async () => {
    const { dist, game, alice } = await deploy({ reserve: RAT(504) });
    const t = tree([[alice.address, RAT(500)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: RAT(5) };
    await expect(dist.publish(...args(cp, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'InsufficientReserve');
    expect((await dist.pending()).activeAt).to.equal(0n);
  });

  it('a published checkpoint activates after the delay: burn, bounty, claims (no team share)', async () => {
    const { dist: unlinked, rat, game, alice, bob, keeper } = await deploy();
    const t = tree([[alice.address, RAT(850)], [bob.address, RAT(170)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: RAT(300), potTotal: RAT(60), bounty: RAT(7) };
    // a pot share needs a confirmed pot: an address that is no contract naming this distributor never gets one
    await expect(unlinked.connect(keeper).publish(...args(cp, await sign(unlinked, game, cp)))).to.be.revertedWithCustomError(unlinked, 'PotNotLinked');
    await expect(unlinked.confirmPot()).to.be.revertedWithCustomError(unlinked, 'PotNotLinked');
    const team = await (await ethers.getContractFactory('PotStub')).deploy(); // (stands for RatRacePot)
    const [owner] = await ethers.getSigners();
    const dist = await (await ethers.getContractFactory('RatRaceDistributor')).deploy(
      owner.address, await rat.getAddress(), game.address, (await ethers.getSigners())[2].address, ethers.ZeroAddress, await team.getAddress(),
      limits(1800, RAT(50000), RAT(50000), RAT(50), OUTFLOW_CAP, BURN_CAP), REAL_DIST,
    );
    await rat.mint(await dist.getAddress(), RAT(1000000));
    await expect(dist.confirmPot()).to.be.revertedWithCustomError(dist, 'PotNotLinked'); // it names nobody yet
    await team.setDistributor(await dist.getAddress());
    await expect(dist.confirmPot()).to.emit(dist, 'PotLinked');
    await expect(dist.connect(keeper).publish(...args(cp, await sign(dist, game, cp)))).to.emit(dist, 'Published');
    expect(await rat.balanceOf(keeper.address)).to.equal(RAT(7)); // the publisher's bounty
    await expect(dist.claim(alice.address, RAT(850), t.proof(0))).to.be.revertedWithCustomError(dist, 'NoActiveCheckpoint');
    await wait(1800);
    await expect(dist.claim(alice.address, RAT(850), t.proof(0))).to.emit(dist, 'Activated').withArgs(1, RAT(300), RAT(60));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(850));
    expect(await rat.balanceOf(DEAD)).to.equal(RAT(300));
    expect(await rat.balanceOf(await team.getAddress())).to.equal(RAT(60)); // the pot's share, to the pot
    expect(await dist.pot()).to.equal(await team.getAddress());
    // anybody may submit a player's claim: the RAT still go to the player
    await dist.connect(keeper).claim(bob.address, RAT(170), t.proof(1));
    expect(await rat.balanceOf(bob.address)).to.equal(RAT(170));
    await expect(dist.claim(alice.address, RAT(850), t.proof(0))).to.be.revertedWithCustomError(dist, 'NothingToClaim');
  });

  it('cumulative amounts: the next checkpoint pays only the difference', async () => {
    const { dist, rat, game, alice, bob } = await deploy();
    let t = tree([[alice.address, RAT(100)], [bob.address, RAT(10)]]);
    let cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await wait(1800);
    await dist.claim(alice.address, RAT(100), t.proof(0));
    t = tree([[alice.address, RAT(160)], [bob.address, RAT(10)]]);
    cp = { epoch: 2, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await wait(1800);
    await dist.claim(alice.address, RAT(160), t.proof(0));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(160));
    expect(await dist.claimed(alice.address)).to.equal(RAT(160));
  });

  // the first checkpoint, active: alice may withdraw 40 (what publishAndClaim claims against)
  const first = async (dist, game, alice) => {
    const t = tree([[alice.address, RAT(40)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await wait(1800);
    return t;
  };

  it('publish + claim in one transaction (the first player of the epoch): the new one waits its delay, the claim takes the active one', async () => {
    const { dist, rat, game, alice } = await deploy();
    const t1 = await first(dist, game, alice);
    const t = tree([[alice.address, RAT(60)]]);
    const cp = { epoch: 2, root: t.root, withdrawTotal: t.total, burnTotal: RAT(5), potTotal: 0n, bounty: RAT(3) };
    await dist.connect(alice).publishAndClaim(...args(cp, await sign(dist, game, cp)), alice.address, RAT(40), t1.proof(0));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(43)); // claim + bounty
    expect((await dist.pending()).epoch).to.equal(2n);
  });

  it('the signed update bonus cannot be changed or paid through a failed atomic claim', async () => {
    const { dist, rat, game, alice, team } = await deploy();
    const t1 = await first(dist, game, alice);
    const t = tree([[alice.address, RAT(60)]]);
    const cp = { epoch: 2, root: t.root, withdrawTotal: t.total, burnTotal: RAT(5), potTotal: 0n, bounty: RAT(3) };
    const sig = await sign(dist, game, cp);
    await expect(dist.connect(alice).publishAndClaim(...args({ ...cp, bounty: RAT(4) }, sig), alice.address, RAT(40), t1.proof(0)))
      .to.be.revertedWithCustomError(dist, 'BadSignature');
    await expect(dist.connect(alice).publishAndClaim(...args(cp, sig), alice.address, RAT(41), t1.proof(0)))
      .to.be.revertedWithCustomError(dist, 'BadProof');
    expect(await dist.lastPublishedEpoch()).to.equal(1);
    expect(await rat.balanceOf(alice.address)).to.equal(0);
    expect(await rat.balanceOf(DEAD)).to.equal(0);
    expect(await rat.balanceOf(team.address)).to.equal(0);
    await dist.connect(alice).publishAndClaim(...args(cp, sig), alice.address, RAT(40), t1.proof(0));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(43));
    // published already: it only claims, and there is nothing left to claim
    await expect(dist.connect(alice).publishAndClaim(...args(cp, sig), alice.address, RAT(40), t1.proof(0)))
      .to.be.revertedWithCustomError(dist, 'NothingToClaim');
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(43));
  });

  it('only the game key signs; epochs move forward; totals never decrease', async () => {
    const { dist, game, alice, bob } = await deploy();
    const t = tree([[alice.address, RAT(10)]]);
    const cp = { epoch: 5, root: t.root, withdrawTotal: t.total, burnTotal: RAT(2), potTotal: 0n, bounty: 0n };
    await expect(dist.publish(...args(cp, await sign(dist, bob, cp)))).to.be.revertedWithCustomError(dist, 'BadSignature');
    const forged = { ...cp, withdrawTotal: RAT(99) }; // tampered after signing
    await expect(dist.publish(...args(forged, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'BadSignature');
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    const lower = { ...cp, epoch: 6, burnTotal: RAT(1) };
    await expect(dist.publish(...args(lower, await sign(dist, game, lower)))).to.be.revertedWithCustomError(dist, 'PendingNotReady'); // one at a time
    await wait(1800);
    await expect(dist.publish(...args(cp, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'StaleEpoch');
    await expect(dist.publish(...args(lower, await sign(dist, game, lower)))).to.be.revertedWithCustomError(dist, 'TotalsDecrease');
  });

  it('a stolen key is capped: step limits, bounty cap, claims never beyond the signed total', async () => {
    const { dist, rat, game, alice, bob } = await deploy();
    const big = { epoch: 1, root: ethers.ZeroHash, withdrawTotal: RAT(50001), burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await expect(dist.publish(...args(big, await sign(dist, game, big)))).to.be.revertedWithCustomError(dist, 'StepTooBig');
    const settle = { ...big, withdrawTotal: 0n, burnTotal: RAT(50001) };
    await expect(dist.publish(...args(settle, await sign(dist, game, settle)))).to.be.revertedWithCustomError(dist, 'StepTooBig');
    const bounty = { ...big, withdrawTotal: 0n, bounty: RAT(51) };
    await expect(dist.publish(...args(bounty, await sign(dist, game, bounty)))).to.be.revertedWithCustomError(dist, 'BountyTooBig');
    // a root giving one player far more than the signed total: only the total can leave
    const t = tree([[alice.address, RAT(900000)], [bob.address, RAT(1)]]);
    const lie = { epoch: 1, root: t.root, withdrawTotal: RAT(1000), burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(lie, await sign(dist, game, lie)));
    await wait(1800);
    await dist.claim(alice.address, RAT(900000), t.proof(0)); // pays what the signed total allows, no more
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(1000));
    await expect(dist.claim(alice.address, RAT(900000), t.proof(0))).to.be.revertedWithCustomError(dist, 'OverWithdrawTotal');
  });

  it('the guardian vetoes a pending checkpoint during its delay; pause stops everything', async () => {
    const { dist, rat, game, guardian, alice, bob } = await deploy();
    const t = tree([[alice.address, RAT(500)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: t.total, burnTotal: 0n, potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    await expect(dist.connect(bob).veto()).to.be.revertedWithCustomError(dist, 'NotGuardian');
    await dist.connect(guardian).veto();
    await wait(3600);
    await expect(dist.claim(alice.address, RAT(500), t.proof(0))).to.be.revertedWithCustomError(dist, 'NoActiveCheckpoint');
    const cp2 = { ...cp, epoch: 2 };
    await dist.publish(...args(cp2, await sign(dist, game, cp2)));
    await dist.connect(guardian).pause();
    await wait(3600);
    await expect(dist.claim(alice.address, RAT(500), t.proof(0))).to.be.revertedWithCustomError(dist, 'EnforcedPause');
    await dist.unpause();
    await dist.claim(alice.address, RAT(500), t.proof(0));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(500));
  });

  it('nobody can burn or take the RAT no checkpoint owes (no sweep): they stay for the rewards to come', async () => {
    const { dist, rat, owner, game, alice } = await deploy({ reserve: RAT(130000) });
    const t = tree([[alice.address, RAT(50000)]]);
    const cp = { epoch: 1, root: t.root, withdrawTotal: RAT(50000), burnTotal: RAT(50000), potTotal: 0n, bounty: 0n };
    await dist.publish(...args(cp, await sign(dist, game, cp)));
    expect(await dist.owed()).to.equal(RAT(100000)); // pending: the withdrawals and the burn
    await wait(1800);
    await dist.activate();
    expect(await dist.owed()).to.equal(RAT(50000)); // the burn was settled on activation
    const free = (await rat.balanceOf(await dist.getAddress())) - (await dist.owed());
    expect(free).to.equal(RAT(30000));
    expect(dist.interface.getFunction('sweep(address,uint256)')).to.equal(null); // no sweep to a wallet
    expect(dist.interface.getFunction('sweep(uint256)')).to.equal(null); // nor to the dead address
    await expect(dist.schedule(ADMIN.encodeFunctionData('sweep', [free]))).to.be.revertedWithCustomError(dist, 'UnknownCall');
    expect((await dist.status()).surplus).to.equal(free);
    expect(await rat.balanceOf(DEAD)).to.equal(RAT(50000)); // the checkpoint's burn only
    expect(await rat.balanceOf(owner.address)).to.equal(0n);
  });

  it('a leaked signer gets at most the daily outflow cap published in any 24 hours, bounties included', async () => {
    const { dist, rat, game, alice } = await deploy({ delay: 600 });
    let epoch = 0;
    let base = { withdrawTotal: 0n, burnTotal: 0n, potTotal: 0n };
    const push = async (dw, dt = 0n, bounty = 0n, db = 0n) => {
      const cp = { epoch: ++epoch, root: ethers.ZeroHash, withdrawTotal: base.withdrawTotal + dw, burnTotal: base.burnTotal + db, potTotal: base.potTotal + dt, bounty };
      const tx = dist.connect(alice).publish(...args(cp, await sign(dist, game, cp)));
      await tx;
      base = cp;
    };
    await push(RAT(20000));
    await wait(HOUR);
    await push(RAT(29000), 0n, RAT(50)); // 49,050 so far
    expect(await dist.outflowRoom()).to.equal(RAT(950));
    await wait(600); // (one checkpoint at a time: each waits the delay)
    await expect(push(RAT(951))).to.be.revertedWithCustomError(dist, 'OverDailyCap');
    await expect(push(RAT(901), 0n, RAT(50))).to.be.revertedWithCustomError(dist, 'OverDailyCap'); // the bounty counts
    await push(RAT(950));
    expect(await dist.outflowRoom()).to.equal(0n);
    await wait(600);
    // a burn is not an outflow: it has its own cap
    await push(0n, 0n, 0n, RAT(50000));
    await wait(600);
    // 24 hours after the first publish its RAT still count (any 24 hours), an hour later they are free
    await wait(23 * HOUR - 1800);
    await expect(push(RAT(1))).to.be.revertedWithCustomError(dist, 'OverDailyCap');
    await wait(HOUR);
    expect(await dist.outflowRoom()).to.equal(RAT(20000)); // (the first hour's 20,000)
    await push(RAT(20000));
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(50)); // (the one bounty paid: nothing else is hers)
  });

  it('burns have their own daily cap: a 900,000 season burn settles over days while withdrawals go on', async () => {
    const { dist, rat, game, alice } = await deploy({ delay: 600 });
    let prev = null; // the checkpoint before: alice claims against it while publishing the next
    let epoch = 0;
    let base = { withdrawTotal: 0n, burnTotal: 0n, potTotal: 0n };
    const SEASON_BURN = RAT(900000);
    let days = 0;
    while (base.burnTotal < SEASON_BURN) {
      days++;
      for (let h = 0; h < 24; h++) {
        // every hour: some withdrawals, and as much of the burn as the step and the day's burn room allow
        const room = await dist.burnRoom();
        const step = [SEASON_BURN - base.burnTotal, RAT(50000), room].reduce((a, b) => (a < b ? a : b));
        const t = tree([[alice.address, base.withdrawTotal + RAT(100)]]);
        const cp = { epoch: ++epoch, root: t.root, withdrawTotal: base.withdrawTotal + RAT(100), burnTotal: base.burnTotal + step, potTotal: 0n, bounty: 0n };
        if (prev) await dist.publishAndClaim(...args(cp, await sign(dist, game, cp)), alice.address, prev.cp.withdrawTotal, prev.t.proof(0));
        else await dist.publish(...args(cp, await sign(dist, game, cp)));
        base = cp;
        prev = { cp, t };
        await wait(HOUR);
      }
    }
    await dist.activate();
    expect(await rat.balanceOf(DEAD)).to.equal(SEASON_BURN);
    expect(days).to.equal(9); // 100,000 a day
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(100) * BigInt(epoch - 1)); // no withdrawal waited behind the burn (the last one is next)
  });

  it('a vetoed checkpoint gives back what it counted in the daily caps', async () => {
    const { dist, game, guardian } = await deploy({ delay: 3600 });
    const cp = { epoch: 1, root: ethers.ZeroHash, withdrawTotal: RAT(50000), burnTotal: RAT(40000), potTotal: 0n, bounty: RAT(10) };
    await expect(dist.publish(...args(cp, await sign(dist, game, cp)))).to.be.revertedWithCustomError(dist, 'OverDailyCap'); // the steps fit, the bounty tips it over
    const ok = { ...cp, withdrawTotal: RAT(49990), burnTotal: RAT(50000) };
    await dist.publish(...args(ok, await sign(dist, game, ok)));
    expect(await dist.outflowRoom()).to.equal(0n);
    expect(await dist.burnRoom()).to.equal(RAT(50000));
    await dist.connect(guardian).veto();
    expect(await dist.outflowRoom()).to.equal(RAT(49990)); // the bounty was paid: it stays counted
    expect(await dist.burnRoom()).to.equal(BURN_CAP);
  });

  it('limits: tightening is immediate, loosening waits 3 days, and nothing goes above the daily caps', async () => {
    const { dist, guardian, bob } = await deploy();
    await expect(dist.connect(bob).setLimits(3600, RAT(1000), RAT(1000), RAT(5))).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    await dist.setLimits(3600, RAT(1000), RAT(1000), RAT(5));
    expect(await dist.maxStepWithdraw()).to.equal(RAT(1000));
    for (const l of [[1800, RAT(1000), RAT(1000), RAT(5)], [3600, RAT(1001), RAT(1000), RAT(5)], [3600, RAT(1000), RAT(1001), RAT(5)], [3600, RAT(1000), RAT(1000), RAT(6)]]) {
      await expect(dist.setLimits(...l)).to.be.revertedWithCustomError(dist, 'NeedsTimelock');
    }
    const back = ADMIN.encodeFunctionData('setLimits', [600, RAT(50000), RAT(50000), RAT(50)]);
    const above = ADMIN.encodeFunctionData('setLimits', [600, RAT(50001), RAT(50000), RAT(50)]);
    const aboveSettle = ADMIN.encodeFunctionData('setLimits', [600, RAT(50000), OUTFLOW_CAP + BURN_CAP + 1n, RAT(50)]);
    await dist.schedule(back);
    await dist.schedule(above);
    await dist.schedule(aboveSettle);
    await wait(3 * DAY - 60);
    await expect(dist.execute(back)).to.be.revertedWithCustomError(dist, 'NotReady');
    await wait(60);
    await expect(dist.execute(above)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await expect(dist.execute(aboveSettle)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await expect(dist.connect(guardian).execute(back)).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    await dist.execute(back);
    expect(await dist.delay()).to.equal(600n);
    expect(await dist.maxStepWithdraw()).to.equal(RAT(50000));
  });

  it('a new signer waits 3 days in public and a new guardian 14; the guardian can cancel a signer; the pot is fixed', async () => {
    const { dist, owner, game, guardian, team, bob, carol } = await deploy();
    expect(dist.interface.getFunction('setSigner')).to.equal(null); // no immediate way
    const swap = ADMIN.encodeFunctionData('setSigner', [bob.address]);
    await expect(dist.connect(bob).schedule(swap)).to.be.revertedWithCustomError(dist, 'OwnableUnauthorizedAccount');
    await expect(dist.schedule(swap)).to.emit(dist, 'Scheduled');
    await expect(dist.connect(bob).cancel(ethers.keccak256(swap))).to.be.revertedWithCustomError(dist, 'NotGuardian');
    await dist.connect(guardian).cancel(ethers.keccak256(swap));
    await wait(7 * DAY);
    await expect(dist.execute(swap)).to.be.revertedWithCustomError(dist, 'NotScheduled');
    expect(await dist.signer()).to.equal(game.address);
    // scheduled again, applied 3 days later (the guardian 14)
    for (const d of [swap, ADMIN.encodeFunctionData('setGuardian', [carol.address])]) await dist.schedule(d);
    await expect(dist.schedule(ADMIN.encodeFunctionData('setTeam', [owner.address]))).to.be.revertedWithCustomError(dist, 'UnknownCall');
    await wait(3 * DAY);
    await dist.execute(swap);
    await expect(dist.execute(ADMIN.encodeFunctionData('setGuardian', [carol.address]))).to.be.revertedWithCustomError(dist, 'NotReady');
    await wait(11 * DAY);
    await dist.execute(ADMIN.encodeFunctionData('setGuardian', [carol.address]));
    expect([await dist.signer(), await dist.guardian(), await dist.pot()]).to.deep.equal([bob.address, carol.address, team.address]);
    // nothing else can be scheduled: not a caller-made call (a new owner can: 3 days, then it accepts)
    const other = new ethers.Interface(['function sweep(address,uint256)', 'function renounceOwnership()']);
    for (const d of [other.encodeFunctionData('sweep', [bob.address, 1n]), other.encodeFunctionData('renounceOwnership', []), swap + '00', '0x12']) {
      await expect(dist.schedule(d)).to.be.revertedWithCustomError(dist, 'UnknownCall');
    }
  });

  it('the daily caps are fixed at deploy, and the step limits must fit under them', async () => {
    const { dist, rat, owner, game, guardian, team } = await deploy();
    expect(await dist.outflowCap()).to.equal(OUTFLOW_CAP);
    expect(await dist.burnCap()).to.equal(BURN_CAP);
    const writes = dist.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
    expect(writes).to.deep.equal(['acceptOwnership', 'activate', 'cancel', 'cancelOwnerOffer', 'claim', 'confirmPot', 'dropSentinel', 'execute', 'pause', 'publish', 'publishAndClaim', 'schedule', 'setLimits', 'unpause', 'veto']);
    const F = await ethers.getContractFactory('RatRaceDistributor');
    const make = (w, s, b, oc = OUTFLOW_CAP, bc = BURN_CAP) => F.deploy(owner.address, rat.getAddress(), game.address, guardian.address, ethers.ZeroAddress, team.address, limits(600, w, s, b, oc, bc), REAL_DIST);
    await expect(make(OUTFLOW_CAP + 1n, 0n, 0n)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await expect(make(0n, OUTFLOW_CAP + BURN_CAP + 1n, 0n)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await expect(make(0n, 0n, OUTFLOW_CAP + 1n)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await expect(make(0n, 0n, 0n, 0n)).to.be.revertedWithCustomError(dist, 'TooMuch');
    await expect(make(0n, 0n, 0n, OUTFLOW_CAP, 0n)).to.be.revertedWithCustomError(dist, 'TooMuch');
  });
});
