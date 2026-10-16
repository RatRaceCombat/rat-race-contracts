// RatRacePot: the Big Cheese pot on chain. In from anybody; out only to the distributor, signed by
// the game's pot key, at most nightBps of the pot for a UTC day and monthBps for a UTC month, one
// open period of each at a time.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { REAL_POT } = require('./helpers/timings.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400;
const H = 3600;
const NIGHT = 1;
const MONTH = 2;
const mine = async (t) => { await ethers.provider.send('evm_setNextBlockTimestamp', [t]); await ethers.provider.send('evm_mine', []); };
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
const ADMIN = new ethers.Interface(['function setSigner(address)', 'function setGuardian(address)', 'function setRates(uint256,uint256)']);
const monthOf = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

/** The distributor stand-in first (its pot() names the pot's future address), then the pot. */
async function deployPot(rat, game, guardian, rates = [1000, 1000], linkTo = null, timings = REAL_POT, linkTest = null) {
  const [owner] = await ethers.getSigners();
  const nonce = await ethers.provider.getTransactionCount(owner.address);
  // (a TEST pot needs a TEST distributor: the stand-in says so, one transaction more)
  const test = linkTest ?? Object.entries(REAL_POT).some(([k, v]) => timings[k] < v);
  const predicted = ethers.getCreateAddress({ from: owner.address, nonce: nonce + (test ? 2 : 1) });
  const link = await (await ethers.getContractFactory('PotLinkMock')).deploy(linkTo || predicted);
  if (test) await link.setTestMode(true);
  const pot = await (await ethers.getContractFactory('RatRacePot')).deploy(owner.address, await rat.getAddress(), await link.getAddress(), game.address, guardian.address, ...rates, timings);
  return { pot, link };
}

async function deploy() {
  const [owner, game, guardian, alice, bob, keeper] = await ethers.getSigners();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const { pot, link } = await deployPot(rat, game, guardian);
  const distributor = await link.getAddress();
  await rat.mint(await pot.getAddress(), RAT(10000));
  await rat.mint(alice.address, RAT(100000));
  const sign = async (kind, period, amount, key = game, at = pot) => {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: 'RatRacePot', version: '1', chainId, verifyingContract: await at.getAddress() };
    return key.signTypedData(domain, { Draw: [{ name: 'kind', type: 'uint8' }, { name: 'period', type: 'uint64' }, { name: 'amount', type: 'uint256' }] }, { kind, period, amount });
  };
  const draw = async (kind, period, amount, opts = {}) => pot.connect(opts.by || keeper).draw(kind, period, amount, await sign(kind, period, amount, opts.key, opts.at));
  // a day well ahead of the chain's clock, and a time of it
  const day0 = Math.floor((await now()) / DAY) + 2;
  const at = (day, hour, min = 0) => mine(day * DAY + hour * H + min * 60);
  return { rat, pot, link, owner, game, guardian, distributor, alice, bob, keeper, sign, draw, day0, at };
}

describe('RatRacePot (the Big Cheese pot on chain)', () => {
  it('anybody funds it, labelled or by a plain transfer', async () => {
    const { rat, pot, alice } = await deploy();
    await rat.connect(alice).approve(await pot.getAddress(), RAT(500));
    const tag = ethers.encodeBytes32String('buyback');
    await expect(pot.connect(alice).fund(RAT(500), tag)).to.emit(pot, 'Funded').withArgs(alice.address, RAT(500), tag);
    await rat.connect(alice).transfer(await pot.getAddress(), RAT(1500));
    expect(await pot.pot()).to.equal(RAT(12000));
  });

  it('the 9 PM bonus: at most 10% of the pot for a UTC day, to the distributor only, sent by anybody', async () => {
    const { rat, pot, distributor, keeper, draw, day0, at } = await deploy();
    const day = day0;
    await at(day, 19); // 19:00 UTC, 9 PM in Paris (summer)
    expect(await pot.room(NIGHT)).to.equal(RAT(1000));
    await expect(draw(NIGHT, day, RAT(1000) + 1n)).to.be.revertedWithCustomError(pot, 'OverCap');
    await expect(draw(NIGHT, day, 0n)).to.be.revertedWithCustomError(pot, 'NothingToDraw');
    await expect(draw(NIGHT, day, RAT(1000))).to.emit(pot, 'Drawn').withArgs(NIGHT, day, RAT(1000), RAT(10000), keeper.address);
    expect(await rat.balanceOf(distributor)).to.equal(RAT(1000));
    expect(await rat.balanceOf(keeper.address)).to.equal(0n);
    expect(await pot.room(NIGHT)).to.equal(0n);
    await expect(draw(NIGHT, day, RAT(1))).to.be.revertedWithCustomError(pot, 'AlreadyDrawn');
    // the next UTC day: 10% of what is left
    await at(day + 1, 20);
    await expect(draw(NIGHT, day + 1, RAT(900) + 1n)).to.be.revertedWithCustomError(pot, 'OverCap');
    await draw(NIGHT, day + 1, RAT(900));
    expect(await pot.pot()).to.equal(RAT(8100));
  });

  it('a day\'s NIGHT draw is open from 18:00 UTC that day to 12:00 UTC the next, one day at a time', async () => {
    const { pot, draw, day0, at } = await deploy();
    const day = day0;
    for (const [d, h, open] of [[day, 17.99, null], [day, 18, day], [day, 23.9, day], [day + 1, 0, day], [day + 1, 11.99, day], [day + 1, 12, null], [day + 1, 17.5, null]]) {
      const t = d * DAY + Math.round(h * H);
      for (const p of [day - 1, day, day + 1]) expect(await pot.isOpen(NIGHT, p, t)).to.equal(p === open, `day ${p - day} at ${h} h`);
    }
    await at(day + 1, 1); // 01:00 UTC: yesterday's 9 PM voucher arrives late
    expect((await pot.openPeriod(NIGHT)).map(Number)).to.deep.equal([1, day]);
    await expect(draw(NIGHT, day + 1, RAT(10))).to.be.revertedWithCustomError(pot, 'BadPeriod');
    await draw(NIGHT, day, RAT(500));
    await expect(draw(NIGHT, day, RAT(10))).to.be.revertedWithCustomError(pot, 'AlreadyDrawn');
    await at(day + 1, 13); // between 12:00 and 18:00 UTC: none open
    expect(await pot.room(NIGHT)).to.equal(0n);
    await expect(draw(NIGHT, day, RAT(1))).to.be.revertedWithCustomError(pot, 'BadPeriod');
    await expect(draw(NIGHT, day + 1, RAT(1))).to.be.revertedWithCustomError(pot, 'BadPeriod');
    await expect(pot.draw(3, day, RAT(1), '0x')).to.be.revertedWithCustomError(pot, 'BadKind');
  });

  it('a stolen pot key moves at most one NIGHT and one MONTH share at a month\'s turn, never four', async () => {
    const { pot, draw } = await deploy();
    const y = new Date((await now()) * 1000).getUTCFullYear() + 1; // (the chain's clock only moves forward)
    const t = Date.UTC(y, 2, 1, 0, 0, 5) / 1000; // 1 March, 00:00:05 UTC
    await mine(t);
    const day = Math.floor(t / DAY);
    const mar = monthOf(t);
    await draw(NIGHT, day - 1, RAT(1000)); // 28 February's
    await draw(MONTH, mar - 1, RAT(900)); // February's
    for (const [k, p] of [[NIGHT, day], [MONTH, mar], [NIGHT, day - 2], [MONTH, mar - 2]]) {
      await expect(draw(k, p, RAT(1))).to.be.revertedWithCustomError(pot, 'BadPeriod');
    }
    expect(await pot.pot()).to.equal(RAT(8100)); // 19% at most at 10%
  });

  it('only the game key signs, for this contract and this chain, the exact kind, period and amount', async () => {
    const { pot, draw, bob, rat, sign, keeper, game, guardian, day0, at } = await deploy();
    const day = day0;
    await at(day, 19);
    await expect(draw(NIGHT, day, RAT(10), { key: bob })).to.be.revertedWithCustomError(pot, 'BadSignature');
    const sig = await sign(NIGHT, day, RAT(10));
    await expect(pot.draw(NIGHT, day, RAT(11), sig)).to.be.revertedWithCustomError(pot, 'BadSignature');
    await expect(pot.draw(MONTH, monthOf(await now()) - 1, RAT(10), sig)).to.be.revertedWithCustomError(pot, 'BadSignature');
    // a voucher for another pot does not work here
    const { pot: other } = await deployPot(rat, game, guardian);
    await expect(pot.connect(keeper).draw(NIGHT, day, RAT(10), await sign(NIGHT, day, RAT(10), game, other))).to.be.revertedWithCustomError(pot, 'BadSignature');
    await pot.draw(NIGHT, day, RAT(10), sig);
  });

  it('the month\'s top 10 bonus: at most its rate, for a UTC calendar month, sent in the first 7 days of the month after it', async () => {
    const { rat, pot, distributor, draw } = await deploy();
    const y = new Date((await now()) * 1000).getUTCFullYear() + 1;
    const t = Date.UTC(y, 1, 3, 12) / 1000; // 3 February
    await mine(t);
    const feb = monthOf(t);
    expect(await pot.periodOf(MONTH, t)).to.equal(BigInt(feb));
    await expect(draw(MONTH, feb, RAT(1))).to.be.revertedWithCustomError(pot, 'BadPeriod'); // not before it ends
    await draw(MONTH, feb - 1, RAT(1000)); // January's top 10, paid late
    await expect(draw(MONTH, feb - 1, RAT(1))).to.be.revertedWithCustomError(pot, 'AlreadyDrawn');
    await mine(Date.UTC(y, 1, 8, 0, 0, 5) / 1000); // 8 February: January's window closed after 7 days
    await expect(draw(MONTH, feb - 1, RAT(1))).to.be.revertedWithCustomError(pot, 'BadPeriod');
    expect((await pot.openPeriod(MONTH))[0]).to.equal(false);
    await mine(Date.UTC(y, 2, 1, 0, 0, 5) / 1000); // 1 March: February's top 10
    await expect(draw(MONTH, feb, RAT(900) + 1n)).to.be.revertedWithCustomError(pot, 'OverCap');
    await draw(MONTH, feb, RAT(900));
    await expect(draw(MONTH, feb - 1, RAT(1))).to.be.revertedWithCustomError(pot, 'BadPeriod');
    expect(await rat.balanceOf(distributor)).to.equal(RAT(1900));
    // the 9 PM bonus is apart: 28 February's, still open until noon
    await draw(NIGHT, Math.floor((await now()) / DAY) - 1, RAT(100));
  });

  it('each draw has its own rate', async () => {
    const { pot, draw } = await deploy();
    await pot.setRates(500, 800);
    const y = new Date((await now()) * 1000).getUTCFullYear() + 1;
    const t = Date.UTC(y, 4, 2, 19) / 1000; // 2 May, 19:00 UTC
    await mine(t);
    await expect(draw(NIGHT, Math.floor(t / DAY), RAT(500) + 1n)).to.be.revertedWithCustomError(pot, 'OverCap');
    await draw(MONTH, monthOf(t) - 1, RAT(800)); // April's: 8% of 10,000
    await draw(NIGHT, Math.floor(t / DAY), RAT(460)); // 5% of 9,200
  });

  it('the UTC month on chain is the calendar\'s, for every day from 1970 to 2200', async () => {
    const { pot } = await deploy();
    const ts = [];
    for (let t = 0; t < Date.UTC(2200, 0, 1) / 1000; t += 37 * DAY + 3607) ts.push(t);
    for (const [y, m, d] of [[2000, 1, 29], [2100, 1, 28], [2100, 2, 1], [2024, 1, 29], [2024, 2, 1], [2031, 11, 31], [2032, 0, 1]]) {
      const t = Date.UTC(y, m, d) / 1000;
      ts.push(t, t - 1, t + DAY - 1);
    }
    for (const t of ts) expect(Number(await pot.periodOf(MONTH, t))).to.equal(monthOf(t), new Date(t * 1000).toISOString());
  });

  it('nothing goes anywhere but the distributor, which must name this pot: no sweep, no team', async () => {
    const { pot, rat, game, guardian, owner } = await deploy();
    const writes = pot.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
    expect(writes).to.deep.equal(['acceptOwnership', 'cancel', 'cancelOwnerOffer', 'draw', 'execute', 'fund', 'pause', 'pauseFor', 'schedule', 'setRates', 'unpause']);
    await expect(pot.renounceOwnership()).to.be.revertedWithCustomError(pot, 'NoRenounce');
    const F = await ethers.getContractFactory('RatRacePot');
    // a distributor that is a wallet, the token, or a contract naming another pot: refused
    for (const d of [owner.address, await rat.getAddress(), await (await ethers.getContractFactory('PotLinkMock')).deploy(owner.address).then((c) => c.getAddress())]) {
      await expect(F.deploy(owner.address, await rat.getAddress(), d, game.address, guardian.address, 1000, 1000, REAL_POT)).to.be.revertedWithCustomError(pot, 'BadDistributor');
    }
    await expect(F.deploy(owner.address, ethers.ZeroAddress, owner.address, game.address, guardian.address, 1000, 1000, REAL_POT)).to.be.revertedWithCustomError(pot, 'ZeroAddress');
    await expect(deployPot(rat, game, guardian, [3001, 1000])).to.be.revertedWithCustomError(pot, 'BadRates');
    await expect(deployPot(rat, game, guardian, [1000, 99])).to.be.revertedWithCustomError(pot, 'BadRates');
  });

  it('rates: lowered at once (never under 1%), raised only after 3 days in public (never above 30%)', async () => {
    const { pot, bob, guardian, draw, day0, at } = await deploy();
    await expect(pot.connect(bob).setRates(500, 500)).to.be.revertedWithCustomError(pot, 'OwnableUnauthorizedAccount');
    await pot.setRates(500, 800);
    expect([await pot.nightBps(), await pot.monthBps()]).to.deep.equal([500n, 800n]);
    await expect(pot.setRates(501, 800)).to.be.revertedWithCustomError(pot, 'NeedsTimelock');
    await expect(pot.setRates(500, 801)).to.be.revertedWithCustomError(pot, 'NeedsTimelock');
    await expect(pot.setRates(99, 800)).to.be.revertedWithCustomError(pot, 'BadRates');
    await at(day0, 19);
    await expect(draw(NIGHT, day0, RAT(500) + 1n)).to.be.revertedWithCustomError(pot, 'OverCap');
    const up = ADMIN.encodeFunctionData('setRates', [2000, 2000]);
    const tooHigh = ADMIN.encodeFunctionData('setRates', [3001, 2000]);
    await pot.schedule(up);
    await pot.schedule(tooHigh);
    await expect(pot.execute(up)).to.be.revertedWithCustomError(pot, 'NotReady');
    await mine((await now()) + 3 * DAY);
    await expect(pot.connect(guardian).execute(up)).to.be.revertedWithCustomError(pot, 'OwnableUnauthorizedAccount');
    await expect(pot.execute(tooHigh)).to.be.revertedWithCustomError(pot, 'BadRates');
    await pot.execute(up);
    expect(await pot.nightBps()).to.equal(2000n);
    await expect(pot.execute(up)).to.be.revertedWithCustomError(pot, 'NotScheduled');
    // a change not executed within 14 days after it is ready lapses
    await pot.setRates(1000, 1000);
    await pot.schedule(up);
    await mine((await now()) + 17 * DAY + 1);
    await expect(pot.execute(up)).to.be.revertedWithCustomError(pot, 'Expired');
  });

  it('a new signer waits 3 days, a new guardian 14; the guardian cancels a raise of the rates, never a key change', async () => {
    const { pot, game, guardian, bob, draw, at } = await deploy();
    const swap = ADMIN.encodeFunctionData('setSigner', [bob.address]);
    const fire = ADMIN.encodeFunctionData('setGuardian', [bob.address]);
    const up = ADMIN.encodeFunctionData('setRates', [1500, 1500]);
    await expect(pot.connect(bob).schedule(swap)).to.be.revertedWithCustomError(pot, 'OwnableUnauthorizedAccount');
    for (const d of [swap, fire, up]) await pot.schedule(d);
    await expect(pot.connect(bob).cancel(ethers.keccak256(up))).to.be.revertedWithCustomError(pot, 'NotGuardian');
    await expect(pot.connect(guardian).cancel(ethers.keccak256(swap))).to.be.revertedWithCustomError(pot, 'NotGuardian');
    await expect(pot.connect(guardian).cancel(ethers.keccak256(fire))).to.be.revertedWithCustomError(pot, 'NotGuardian');
    await pot.connect(guardian).cancel(ethers.keccak256(up));
    await expect(pot.connect(guardian).cancel(ethers.keccak256(up))).to.be.revertedWithCustomError(pot, 'NotScheduled');
    await mine((await now()) + 3 * DAY);
    await expect(pot.execute(up)).to.be.revertedWithCustomError(pot, 'NotScheduled');
    await expect(pot.execute(fire)).to.be.revertedWithCustomError(pot, 'NotReady'); // (the guardian is the check on the owner: 14 days in public)
    await pot.execute(swap);
    await mine((await now()) + 11 * DAY);
    await pot.execute(fire);
    expect([await pot.signer(), await pot.guardian()]).to.deep.equal([bob.address, bob.address]);
    const day = Math.floor((await now()) / DAY) + 1;
    await at(day, 19);
    await expect(draw(NIGHT, day, RAT(1), { key: game })).to.be.revertedWithCustomError(pot, 'BadSignature');
    await draw(NIGHT, day, RAT(1), { key: bob });
    // the owner cancels anything
    await pot.schedule(swap);
    await pot.cancel(ethers.keccak256(swap));
    // nothing else can be scheduled
    const other = new ethers.Interface(['function renounceOwnership()', 'function sweep(uint256)']);
    for (const d of [other.encodeFunctionData('renounceOwnership', []), other.encodeFunctionData('sweep', [1n]), swap + '00', '0x12']) {
      await expect(pot.schedule(d)).to.be.revertedWithCustomError(pot, 'UnknownCall');
    }
  });

  it('the pause stops the draws for its freeze credit at most, ends by itself, and refills slowly', async () => {
    const { pot, guardian, bob, draw, at, day0 } = await deploy();
    await at(day0, 19);
    await expect(pot.connect(bob).pause()).to.be.revertedWithCustomError(pot, 'NotGuardian');
    await pot.connect(guardian).pause();
    const until = Number(await pot.pausedUntil());
    expect(until - (await now())).to.equal(4 * DAY);
    await expect(pot.connect(guardian).pause()).to.be.revertedWithCustomError(pot, 'EnforcedPause');
    await expect(draw(NIGHT, day0, RAT(1))).to.be.revertedWithCustomError(pot, 'EnforcedPause');
    expect(await pot.room(NIGHT)).to.equal(0n);
    await mine(until);
    expect(await pot.paused()).to.equal(false);
    // the credit is spent: no new pause until it refills (8 days per 30 days of open draws)
    await expect(pot.connect(guardian).pause()).to.be.revertedWithCustomError(pot, 'NoFreezeCredit');
    await mine(until + 8 * 3600);
    await pot.connect(guardian).pause(); // 8 hours open give back 8 h x 4 / 30 = 3,840 s
    expect(Number(await pot.pausedUntil()) - (await now())).to.be.within(3840, 3845);
    // the owner ends it early; what is left goes back to the credit
    await pot.unpause();
    await expect(pot.unpause()).to.be.revertedWithCustomError(pot, 'ExpectedPause');
    await expect(pot.connect(guardian).unpause()).to.be.revertedWithCustomError(pot, 'OwnableUnauthorizedAccount');
    const day = Math.floor((await now()) / DAY) + 1;
    await at(day, 19);
    await draw(NIGHT, day, RAT(1));
  });
});

describe('RatRacePot after the rules of 2026-10-13 (3-day timelock, 30% at most, everything readable)', () => {
  it('the ownership moves only through the 3-day timelock, then the new owner accepts', async () => {
    const { pot, owner, bob, guardian } = await deploy();
    await expect(pot.transferOwnership(bob.address)).to.be.revertedWithCustomError(pot, 'NeedsTimelock');
    const move = new ethers.Interface(['function transferOwnership(address)']).encodeFunctionData('transferOwnership', [bob.address]);
    await pot.schedule(move);
    await expect(pot.connect(guardian).cancel(ethers.keccak256(move))).to.be.revertedWithCustomError(pot, 'NotGuardian');
    await mine((await now()) + 3 * DAY - 60);
    await expect(pot.execute(move)).to.be.revertedWithCustomError(pot, 'NotReady');
    await mine((await now()) + 60);
    await pot.execute(move);
    expect(await pot.owner()).to.equal(owner.address);
    expect(await pot.pendingOwner()).to.equal(bob.address);
    await pot.connect(bob).acceptOwnership();
    expect(await pot.owner()).to.equal(bob.address);
  });

  it('status() gives everything in one read', async () => {
    const { pot, rat, owner, game, guardian, distributor, draw, day0, at } = await deploy();
    await at(day0, 19);
    await draw(NIGHT, day0, RAT(400));
    const s = await pot.status();
    expect(s.pot).to.equal(RAT(9600));
    expect([s.nightBps, s.monthBps, s.minBps, s.nightMaxBps, s.monthMaxBps].map(Number)).to.deep.equal([1000, 1000, 100, 3000, 3000]);
    expect([s.nightOpen, Number(s.nightPeriod), s.nightRoom, s.nightDrawn]).to.deep.equal([true, day0, 0n, RAT(400)]);
    expect(s.monthOpen).to.equal((await pot.openPeriod(MONTH))[0]);
    expect(s.monthRoom).to.equal(s.monthOpen ? RAT(1000) : 0n); // (10% of the pot before the day's draws)
    expect(s.drawn24h).to.equal(RAT(400));
    expect([s.paused, s.freezeCredit]).to.deep.equal([false, BigInt(4 * DAY)]);
    expect([s.owner, s.pendingOwner, s.signer, s.guardian, s.distributor, s.rat]).to.deep.equal([owner.address, ethers.ZeroAddress, game.address, guardian.address, distributor, await rat.getAddress()]);
    expect([Number(s.timelock), Number(s.timelockLong), Number(s.executionWindow), Number(s.ownerOfferUntil)]).to.deep.equal([3 * DAY, 14 * DAY, 14 * DAY, 0]);
  });
});

describe('RatRacePot after the security review of 2026-10-13', () => {
  it('L1: a stolen pot key takes at most both rates of the pot in any 24 hours, never three shares', async () => {
    const { pot, draw } = await deploy();
    const y = new Date((await now()) * 1000).getUTCFullYear() + 1;
    const t = Date.UTC(y, 2, 1, 11, 0, 0) / 1000; // 1 March, 11:00 UTC: 28 February's NIGHT still open, February's MONTH open
    await mine(t);
    const day = Math.floor(t / DAY);
    const mar = monthOf(t);
    await draw(NIGHT, day - 1, RAT(1000)); // 28 February's: 10%
    await draw(MONTH, mar - 1, RAT(1000)); // February's: 10% of the pot before the day's draws (L4: the order never matters)
    expect(await pot.drawnLast24h()).to.equal(RAT(2000));
    await mine(day * DAY + 18 * H); // 1 March's NIGHT opens 7 hours later
    expect(await pot.room(NIGHT)).to.equal(0n);
    await expect(draw(NIGHT, day, RAT(1))).to.be.revertedWithCustomError(pot, 'OverCap');
    expect(await pot.pot()).to.equal(RAT(8000)); // 20% at 10% + 10% (was 27.1%: three shares in six hours)
    // a day later the window has moved on
    await mine((day + 1) * DAY + 19 * H);
    expect(await pot.drawnLast24h()).to.equal(0n);
    await draw(NIGHT, day + 1, RAT(800));
  });

  it('L4: the second draw of the day is capped on the pot before the first, whatever the order', async () => {
    const { pot, draw } = await deploy();
    const y = new Date((await now()) * 1000).getUTCFullYear() + 1;
    const t = Date.UTC(y, 5, 1, 9, 0, 0) / 1000; // 1 June, 09:00 UTC
    await mine(t);
    const day = Math.floor(t / DAY);
    // the MONTH voucher goes first, then the NIGHT one signed against the pot of 10,000: both pass
    await draw(MONTH, monthOf(t) - 1, RAT(1000));
    await draw(NIGHT, day - 1, RAT(1000));
    expect(await pot.pot()).to.equal(RAT(8000));
  });

  it('L2: pauseFor keeps the rest of the freeze credit for a later incident; an early unpause gives it back', async () => {
    const { pot, guardian, bob } = await deploy();
    await expect(pot.connect(bob).pauseFor(H)).to.be.revertedWithCustomError(pot, 'NotGuardian');
    await expect(pot.connect(guardian).pauseFor(60)).to.be.revertedWithCustomError(pot, 'NoFreezeCredit');
    await pot.connect(guardian).pauseFor(DAY);
    expect(Number(await pot.pausedUntil()) - (await now())).to.equal(DAY);
    await mine(Number(await pot.pausedUntil()));
    expect(Number(await pot.freezeCreditNow())).to.equal(3 * DAY); // three days left for the next one
    await pot.connect(guardian).pauseFor(2 * DAY);
    await pot.unpause(); // the owner ends it at once: almost two days back
    expect(Number(await pot.freezeCreditNow())).to.be.within(3 * DAY - 2, 3 * DAY);
  });

  it('L3: an owner offer lapses after its window, and the owner can withdraw it', async () => {
    const { pot, bob, alice } = await deploy();
    const move = (to) => new ethers.Interface(['function transferOwnership(address)']).encodeFunctionData('transferOwnership', [to]);
    await pot.schedule(move(bob.address));
    await mine((await now()) + 3 * DAY);
    await pot.execute(move(bob.address));
    expect(Number(await pot.ownerOfferUntil())).to.be.greaterThan(await now());
    await mine(Number(await pot.ownerOfferUntil()) + 1);
    await expect(pot.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(pot, 'Expired');
    // a new offer, withdrawn before it is taken
    await pot.schedule(move(alice.address));
    await mine((await now()) + 3 * DAY);
    await pot.execute(move(alice.address));
    await expect(pot.connect(bob).cancelOwnerOffer()).to.be.revertedWithCustomError(pot, 'OwnableUnauthorizedAccount');
    await expect(pot.cancelOwnerOffer()).to.emit(pot, 'OwnerOfferCancelled');
    expect(await pot.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(pot.connect(alice).acceptOwnership()).to.be.reverted;
  });

  it('its delays are set at deploy, never above the real ones; a shorter one is a TEST pot for good', async () => {
    const [, game, guardian, alice] = await ethers.getSigners();
    const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
    const F = await ethers.getContractFactory('RatRacePot');
    const real = (await deployPot(rat, game, guardian)).pot;
    expect(await real.testMode()).to.equal(false);
    expect([await real.TIMELOCK(), await real.TIMELOCK_LONG(), await real.EXECUTION_WINDOW(), await real.PAUSE_MAX(), await real.PAUSE_PERIOD(), await real.MIN_PAUSE()])
      .to.deep.equal([3n * 86400n, 14n * 86400n, 14n * 86400n, 4n * 86400n, 30n * 86400n, 3600n]);
    // refused: a zero, above the real one, the long under the short, a pause shorter than a new signer's wait, a refill faster than it
    const bad = [
      { ...REAL_POT, executionWindow: 0 },
      { ...REAL_POT, timelock: 3 * DAY + 1 },
      { ...REAL_POT, pausePeriod: 30 * DAY + 1 },
      { ...REAL_POT, timelock: 600, timelockLong: 300, pauseMax: 600 },
      { ...REAL_POT, timelock: 600, timelockLong: 900, pauseMax: 300 },
      { ...REAL_POT, pauseMax: 600, pausePeriod: 300, timelock: 300, timelockLong: 300 },
      // a test keeps the real margins: a pause outlasts a new signer's
      // wait by the wait itself (or a day), its refill is slower than itself
      { timelock: 600, timelockLong: 600, executionWindow: 900, pauseMax: 1199, pausePeriod: 3600 },
      { timelock: 300, timelockLong: 600, executionWindow: 900, pauseMax: 600, pausePeriod: 600 },
    ];
    for (const t of bad) await expect(deployPot(rat, game, guardian, [1000, 1000], null, t)).to.be.revertedWithCustomError(F, 'BadTimings');
    // a TEST pot: minutes, and it says so; it never draws to a real distributor, a real pot never to a TEST one
    const TEST = { timelock: 300, timelockLong: 600, executionWindow: 900, pauseMax: 600, pausePeriod: 1800 };
    await expect(deployPot(rat, game, guardian, [1000, 1000], null, TEST, false)).to.be.revertedWithCustomError(F, 'BadDistributor');
    await expect(deployPot(rat, game, guardian, [1000, 1000], null, REAL_POT, true)).to.be.revertedWithCustomError(F, 'BadDistributor');
    const { pot } = await deployPot(rat, game, guardian, [1000, 1000], null, TEST);
    expect(await pot.testMode()).to.equal(true);
    expect((await pot.status()).testMode).to.equal(true);
    expect(await pot.MIN_PAUSE()).to.equal(600n, 'a pause credit under an hour: the whole credit is the least pause');
    expect(await pot.freezeCreditNow()).to.equal(600n);
    // a raise of the rates waits 5 minutes, then lapses 15 minutes after
    const up = ADMIN.encodeFunctionData('setRates', [2000, 2000]);
    await pot.schedule(up);
    await expect(pot.execute(up)).to.be.revertedWithCustomError(pot, 'NotReady');
    await mine((await now()) + 300);
    await pot.execute(up);
    expect(await pot.nightBps()).to.equal(2000n);
    // a new guardian waits 10 minutes
    const fire = ADMIN.encodeFunctionData('setGuardian', [alice.address]);
    await pot.schedule(fire);
    await mine((await now()) + 400);
    await expect(pot.execute(fire)).to.be.revertedWithCustomError(pot, 'NotReady');
    await mine((await now()) + 200);
    await pot.execute(fire);
    expect(await pot.guardian()).to.equal(alice.address);
    // the pause: 10 minutes of credit at most, and it outlasts a new signer's 5-minute wait: the
    // guardian freezes a stolen key's draws for as long as the owner needs to replace it
    const swap = ADMIN.encodeFunctionData('setSigner', [alice.address]);
    await pot.connect(alice).pause();
    const until = Number(await pot.pausedUntil());
    expect(until - (await now())).to.equal(600);
    await pot.schedule(swap);
    await mine((await now()) + 300);
    await pot.execute(swap);
    expect(await pot.signer()).to.equal(alice.address);
    expect(await pot.paused()).to.equal(true, 'the new signer is in before the pause ends');
  });
});
