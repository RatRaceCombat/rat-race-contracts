// FoundersSaleLock: the founders' 400,000 RAT for sale only reach their ladder account as the market reaches
// each level of the published grid. One rule: a level opens once HyperCore's best bid now is within 10% under it,
// at most 2,000 RAT an hour (the rate cap, refilled evenly) and 10,000 RAT a day; the admin can move the ladder
// account or hand its role on, each 3 days in public, and take the rest back to itself 30 days after a public
// announcement (2026-10-16), then 7 days to apply it or it lapses. Every level reads one by one.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { REAL_SALE } = require('./helpers/timings.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const BBO = '0x000000000000000000000000000000000000080e';
const REAL_RAT = '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca';
const ASSET = 10157; // 10000 + the RAT/USDC spot index
const DAY = 86400;
const HOUR = 3600;
const REAL = { ...REAL_SALE };
const px6 = (usd) => Math.round(usd * 1e6); // HyperCore spot price units for RAT (6 decimals)
const wait = async (s) => { await ethers.provider.send('evm_increaseTime', [s]); await ethers.provider.send('evm_mine', []); };

async function deploy(grid = REAL, { fund = RAT(400000), realRat = true, asset = ASSET, decimals = 6 } = {}) {
  const [admin, ladder, anyone, next, other] = await ethers.getSigners();
  // the real RAT's address with a mint-able token there, so a lock can be the real one (testMode false)
  const mock = await (await ethers.getContractFactory('MockRAT')).deploy();
  let ratAddress = await mock.getAddress();
  if (realRat) {
    await network.provider.send('hardhat_setCode', [REAL_RAT, await ethers.provider.getCode(ratAddress)]);
    ratAddress = REAL_RAT;
  }
  const rat = await ethers.getContractAt('MockRAT', ratAddress);
  const bboCode = await (await (await ethers.getContractFactory('MockBbo')).deploy()).getAddress();
  await network.provider.send('hardhat_setCode', [BBO, await ethers.provider.getCode(bboCode)]);
  const bbo = await ethers.getContractAt('MockBbo', BBO);
  const lock = await (await ethers.getContractFactory('FoundersSaleLock')).deploy(ratAddress, ladder.address, admin.address, asset, decimals, grid);
  if (fund) await rat.mint(await lock.getAddress(), fund);
  const price = (usd) => bbo.set(ASSET, px6(usd), px6(usd * 1.002) + 1); // a bid and an ask just above
  return { lock, rat, bbo, price, admin, ladder, anyone, next, other };
}

describe('FoundersSaleLock (the founders\' sale, released by the market: one rule)', () => {
  let snapshot;
  beforeEach(async () => { snapshot = await ethers.provider.send('evm_snapshot', []); });
  afterEach(async () => { await ethers.provider.send('evm_revert', [snapshot]); });

  it('the real lock: testMode false only with the real grid, the real RAT, HyperCore\'s asset and its decimals', async () => {
    const { lock } = await deploy();
    expect(await lock.testMode()).to.equal(false);
    // 67% of the RAT even, 33% by price (2026-10-16): about 407 RAT on the first level, about 1,064 on the last,
    // about 120,000 up to $0.10
    expect(await lock.EVEN_BPS()).to.equal(6700n);
    expect(Number(ethers.formatUnits(await lock.levelSize(0), 18))).to.be.within(406, 408);
    expect(Number(ethers.formatUnits(await lock.levelSize(694), 18))).to.be.within(1063, 1065);
    expect(Number(await lock.levelPrice(0))).to.equal(2_500_000);
    expect(Number(await lock.levelPrice(694)) / 1e8).to.be.within(0.795, 0.805);
    expect([await lock.RATE_CAP(), await lock.RATE_WINDOW(), await lock.DAY_CAP()]).to.deep.equal([RAT(2000), BigInt(HOUR), RAT(10000)]);
    // a lock reading another token, asset or decimals says TEST
    expect(await (await deploy(REAL, { realRat: false })).lock.testMode()).to.equal(true);
    expect(await (await deploy(REAL, { decimals: 4 })).lock.testMode()).to.equal(true);
    expect(await (await deploy(REAL, { asset: 10158 })).lock.testMode()).to.equal(true);
  });

  it('a one-block spike opens the rate cap at most (2,000 RAT), never the day\'s 10,000', async () => {
    const { lock, rat, bbo, price, ladder, anyone } = await deploy();
    await price(0.10); // a spike: thin asks bought, a high bid for one block (~300 levels within 10%)
    await expect(lock.connect(anyone).release()).to.emit(lock, 'Released');
    expect(await rat.balanceOf(ladder.address)).to.equal(RAT(2000));
    // the cap is spent: right after, only its refill (2,000 an hour: a few RAT for a few seconds)
    await lock.release();
    expect(await rat.balanceOf(ladder.address)).to.be.below(RAT(2010));
    // no price, no release
    await bbo.set(ASSET, 0, 0);
    await expect(lock.release()).to.be.revertedWithCustomError(lock, 'NoCorePrice');
    // a book with bids and no asks, a squeeze, still reads; an ask under the bid does not
    await bbo.set(ASSET, px6(0.03), 0);
    expect(await lock.bidUsd8()).to.equal(3_000_000n);
    await bbo.set(ASSET, px6(0.03), px6(0.02));
    await expect(lock.bidUsd8()).to.be.revertedWithCustomError(lock, 'NoCorePrice');
  });

  it('the rate cap refills evenly over the hour, never above 2,000; spent in the same block it says so', async () => {
    const { lock, rat, price, ladder } = await deploy();
    await price(0.10);
    await network.provider.send('evm_setAutomine', [false]);
    const a = await lock.release();
    const b = await lock.release(); // same block: the cap is spent
    await network.provider.send('evm_mine', []);
    await network.provider.send('evm_setAutomine', [true]);
    expect((await a.wait()).status).to.equal(1);
    await expect(b.wait()).to.be.rejected;
    expect(await rat.balanceOf(ladder.address)).to.equal(RAT(2000));
    await wait(1800);
    const half = await lock.rateRoom();
    expect(half > RAT(990) && half < RAT(1010)).to.equal(true);
    await wait(7200);
    expect(await lock.rateRoom()).to.equal(RAT(2000));
    await lock.release();
    expect(await rat.balanceOf(ladder.address)).to.equal(RAT(4000));
  });

  it('a level opens once the bid now is within 10% under it; a level at a time, always to the ladder, whoever calls', async () => {
    const { lock, rat, price, ladder, anyone } = await deploy();
    await price(0.022727); // $0.025 is just over 10% above it
    await expect(lock.connect(anyone).release()).to.be.revertedWithCustomError(lock, 'NothingToRelease');
    await price(0.022728);
    const size = await lock.levelSize(0);
    await expect(lock.connect(anyone).release()).to.emit(lock, 'Released').withArgs(size, 2_272_800n, 1n, size, ladder.address);
    expect(await rat.balanceOf(ladder.address)).to.equal(size);
    expect(await rat.balanceOf(anyone.address)).to.equal(0n);
    await expect(lock.release()).to.be.revertedWithCustomError(lock, 'NothingToRelease'); // (once per level)
    await price(0.01); // the price falls back: what left stays left, nothing more opens
    await expect(lock.release()).to.be.revertedWithCustomError(lock, 'NothingToRelease');
  });

  it('at most 10,000 RAT a UTC day, whatever the price and the rate; the rest the next days', async () => {
    const { lock, rat, price, ladder } = await deploy();
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await wait(DAY - (now % DAY) + 60); // (the start of a UTC day)
    await price(0.10); // ~300 levels open at once
    for (let h = 0; h < 5; h++) {
      await lock.release(); // 2,000 an hour
      await wait(HOUR);
    }
    expect(await rat.balanceOf(ladder.address)).to.equal(RAT(10000));
    await expect(lock.release()).to.be.revertedWithCustomError(lock, 'DayCapReached'); // (the rate is full again, the day is not)
    await wait(DAY);
    await lock.release();
    expect(await rat.balanceOf(ladder.address)).to.equal(RAT(12000));
  });

  it('above the top level every RAT is open (the last level takes the rounding)', async () => {
    const { lock, rat, price, ladder } = await deploy({ ...REAL, dayCap: RAT(400000), rateCap: RAT(400000) }); // (a TEST lock, to see the end at once)
    await price(0.9);
    await lock.release();
    expect(await rat.balanceOf(ladder.address)).to.equal(RAT(400000));
  });

  it('a lock holding less than the levels open sends what it holds', async () => {
    const { lock, price } = await deploy(REAL, { fund: RAT(100) });
    await price(0.03);
    await lock.release();
    expect(await lock.released()).to.equal(RAT(100));
    await wait(HOUR);
    await expect(lock.release()).to.be.revertedWithCustomError(lock, 'NothingHeld'); // (the lock is empty)
  });

  it('a new ladder account: only the admin, 3 days in public, then 7 days to apply it or it lapses', async () => {
    const { lock, rat, price, admin, anyone, next } = await deploy();
    await expect(lock.connect(anyone).proposeLadder(anyone.address)).to.be.revertedWithCustomError(lock, 'OwnableUnauthorizedAccount');
    await expect(lock.connect(admin).proposeLadder(next.address)).to.emit(lock, 'LadderProposed');
    await expect(lock.connect(admin).applyLadder()).to.be.revertedWithCustomError(lock, 'NotReady');
    await wait(10 * DAY + 1);
    await expect(lock.connect(admin).applyLadder()).to.be.revertedWithCustomError(lock, 'Expired');
    await lock.connect(admin).cancelLadder();
    await lock.connect(admin).proposeLadder(next.address);
    await wait(2 * DAY);
    await expect(lock.connect(admin).applyLadder()).to.be.revertedWithCustomError(lock, 'NotReady');
    await wait(DAY);
    await expect(lock.connect(admin).applyLadder()).to.emit(lock, 'LadderChanged');
    await price(0.03);
    await lock.release();
    expect(await rat.balanceOf(next.address)).to.be.above(0n);
  });

  it('the emergency way back: only to the admin itself, 30 days after a public announcement, 7 days to apply it', async () => {
    const { lock, rat, price, admin, anyone } = await deploy();
    await expect(lock.connect(anyone).proposeRecovery()).to.be.revertedWithCustomError(lock, 'OwnableUnauthorizedAccount');
    await expect(lock.connect(admin).proposeRecovery()).to.emit(lock, 'RecoveryProposed');
    expect((await lock.status()).recoveryReadyAt).to.be.above(0n); // (the economy page shows the countdown)
    await wait(29 * DAY);
    await expect(lock.connect(admin).executeRecovery()).to.be.revertedWithCustomError(lock, 'NotReady');
    await price(0.03); // releases go on meanwhile
    await lock.release();
    const left = await rat.balanceOf(await lock.getAddress());
    await wait(DAY);
    const before = await rat.balanceOf(admin.address);
    await expect(lock.connect(admin).executeRecovery()).to.emit(lock, 'Recovered').withArgs(admin.address, left);
    expect(await rat.balanceOf(admin.address)).to.equal(before + left);
    await expect(lock.connect(admin).executeRecovery()).to.be.revertedWithCustomError(lock, 'NothingPending');
    // an announcement left past its window lapses
    await rat.mint(await lock.getAddress(), RAT(5));
    await lock.connect(admin).proposeRecovery();
    await wait(37 * DAY + 1);
    await expect(lock.connect(admin).executeRecovery()).to.be.revertedWithCustomError(lock, 'Expired');
  });

  it('a new admin waits 3 days in public, and the way back still waits its 30 days for whoever is admin then', async () => {
    const { lock, rat, admin, next } = await deploy();
    await expect(lock.connect(admin).transferOwnership(next.address)).to.emit(lock, 'AdminProposed');
    await expect(lock.connect(next).acceptOwnership()).to.be.revertedWithCustomError(lock, 'NotReady');
    // the owner announces a recovery meanwhile: it can only reach the admin of the day it applies, after 30 days
    await lock.connect(admin).proposeRecovery();
    await wait(3 * DAY);
    await lock.connect(next).acceptOwnership();
    expect(await lock.owner()).to.equal(next.address);
    await expect(lock.connect(next).executeRecovery()).to.be.revertedWithCustomError(lock, 'NotReady'); // (a new admin does not cut the 30 days)
    await wait(27 * DAY);
    await lock.connect(next).executeRecovery(); // (the admin named 3 days ahead in public, 30 days after the announcement)
    expect(await rat.balanceOf(next.address)).to.equal(RAT(400000));
    // a proposal left past its window lapses; address 0 cancels one
    await lock.connect(next).transferOwnership(admin.address);
    await wait(10 * DAY + 1);
    await expect(lock.connect(admin).acceptOwnership()).to.be.revertedWithCustomError(lock, 'Expired');
    await lock.connect(next).transferOwnership(ethers.ZeroAddress);
    expect(await lock.adminReadyAt()).to.equal(0n);
    await expect(lock.connect(next).renounceOwnership()).to.be.revertedWithCustomError(lock, 'NoRenounce');
  });

  it('a TEST grid says so; impossible grids are refused; the time rules are never longer than the real ones', async () => {
    const { lock } = await deploy({ ...REAL, floorUsd8: 400_000, total: RAT(400), dayCap: RAT(10), changeDelay: 600, recoveryDelay: 600, executionWindow: 3600, rateCap: RAT(2), rateWindow: 600 });
    expect(await lock.testMode()).to.equal(true);
    expect(await (await deploy({ ...REAL, recoveryDelay: 30 * DAY - 1 })).lock.testMode()).to.equal(true);
    expect(await (await deploy({ ...REAL, changeDelay: 3 * DAY - 1 })).lock.testMode()).to.equal(true);
    expect(await (await deploy({ ...REAL, rateCap: RAT(1999) })).lock.testMode()).to.equal(true);
    expect(await (await deploy({ ...REAL, rateWindow: 3599 })).lock.testMode()).to.equal(true);
    const F = await ethers.getContractFactory('FoundersSaleLock');
    const [a, l] = await ethers.getSigners();
    const make = (g) => F.deploy(REAL_RAT, l.address, a.address, ASSET, 6, g);
    for (const bad of [{ ...REAL, floorUsd8: 0 }, { ...REAL, stepBps: 0 }, { ...REAL, stepBps: 1001 }, { ...REAL, levels: 0 }, { ...REAL, levels: 1001 },
      { ...REAL, windowBps: 5001 }, { ...REAL, total: 0 }, { ...REAL, dayCap: 0 }, { ...REAL, dayCap: RAT(400001) }, { ...REAL, changeDelay: 0 },
      { ...REAL, changeDelay: 3 * DAY + 1 }, { ...REAL, recoveryDelay: 0 }, { ...REAL, recoveryDelay: 30 * DAY + 1 }, { ...REAL, executionWindow: 0 }, { ...REAL, executionWindow: 7 * DAY + 1 }, { ...REAL, rateCap: 0 },
      { ...REAL, rateCap: RAT(10001) }, { ...REAL, rateWindow: 59 }, { ...REAL, rateWindow: DAY + 1 }]) {
      await expect(make(bad)).to.be.revertedWithCustomError(lock, 'BadGrid');
    }
    await expect(F.deploy(REAL_RAT, l.address, a.address, 157, 6, REAL)).to.be.revertedWithCustomError(lock, 'BadGrid'); // (a spot asset is 10000 + index)
    await expect(F.deploy(REAL_RAT, ethers.ZeroAddress, a.address, ASSET, 6, REAL)).to.be.revertedWithCustomError(lock, 'ZeroAddress');
  });

  it('levels(): every level with its price, its RAT, what was released of it and whether the bid now opens it', async () => {
    const { lock, price } = await deploy();
    const all = await lock.levels(0, 1000); // (cut at the 695 levels)
    expect(all.length).to.equal(695);
    expect([all[0].priceUsd8, all[1].priceUsd8, all[694].priceUsd8]).to.deep.equal([await lock.levelPrice(0), await lock.levelPrice(1), await lock.levelPrice(694)]);
    expect(all.reduce((t, l) => t + l.size, 0n)).to.equal(RAT(400000)); // (the last level takes the rounding)
    expect(all.every((l, k) => k === 0 || l.size >= all[k - 1].size)).to.equal(true); // (each level holds at least the one below)
    expect([all[0].size, all[694].size]).to.deep.equal([await lock.levelSize(0), await lock.levelSize(694)]);
    const upTo10c = all.filter((l) => l.priceUsd8 <= 10_000_000n).reduce((t, l) => t + l.size, 0n);
    expect(Number(ethers.formatUnits(upTo10c, 18))).to.be.within(119000, 121000);
    expect(all.every((l) => !l.open && l.releasedRat === 0n)).to.equal(true);
    await price(0.0228); // the first level opens, then a release of 2,000 RAT: level 0 whole, level 1 whole, level 2 in part
    expect((await lock.levels(0, 2)).map((l) => l.open)).to.deep.equal([true, false]);
    await price(0.03);
    await lock.release();
    const page = await lock.levels(0, 12);
    expect(page.map((l) => l.index)).to.deep.equal([...Array(12).keys()].map(BigInt));
    let before = 0n; // levels are released in order: each one whole until the 2,000 RAT run out, then one in part
    for (const l of page) {
      const done = RAT(2000) > before ? RAT(2000) - before : 0n;
      expect(l.releasedRat).to.equal(done > l.size ? l.size : done);
      before += l.size;
    }
    expect(page.reduce((t, l) => t + l.releasedRat, 0n)).to.equal(RAT(2000));
    expect(page.every((l) => l.open)).to.equal(true);
    const tail = await lock.levels(690, 50);
    expect(tail.map((l) => l.index)).to.deep.equal([690n, 691n, 692n, 693n, 694n]);
    expect((await lock.levels(695, 1)).length).to.equal(0);
    await expect(lock.levelSize(695)).to.be.revertedWithCustomError(lock, 'BadGrid');
    expect([await lock.CHANGE_DELAY(), await lock.RECOVERY_DELAY()]).to.deep.equal([BigInt(3 * DAY), BigInt(30 * DAY)]);
  });

  it('status(): the bid now, the levels open, what a release would send and why less, the announcements and their window', async () => {
    const { lock, price, ladder, admin } = await deploy();
    await price(0.0228);
    let s = await lock.status();
    const size = await lock.levelSize(0);
    expect([s.levelsOpen, s.openLeft, s.releasableNow, s.held, s.bidUsd8]).to.deep.equal([1n, size, size, RAT(400000), 2_280_000n]);
    expect(s.nextLevelUsd8).to.equal(await lock.levelPrice(1));
    expect([s.ladder, s.admin, s.testMode, s.executionWindow, s.dayRoom, s.rateRoom]).to.deep.equal([ladder.address, admin.address, false, BigInt(7 * DAY), RAT(10000), RAT(2000)]);
    await price(0.03); // ~38 levels open: the rate cap is what holds the release back
    s = await lock.status();
    expect(s.openLeft > RAT(14000)).to.equal(true); // (about 38 levels of about 410 RAT)
    expect(s.releasableNow).to.equal(RAT(2000));
  });
});
