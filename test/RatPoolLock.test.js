// RatPoolLock: liquidity of the RAT pool locked, its fees to whoever locked it; PERMANENT for
// good, or NOTICE: back to its holder only after a public announcement and 14 days, within 7 days. Against
// MockPositions (the positions contract as the lock uses it); HyperEVMForkPoolLock.test.js runs the real one.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const FEE = 3000;
const DAY = 86400;
const PERMANENT = 1, NOTICE = 2;
const modeData = (m) => ethers.AbiCoder.defaultAbiCoder().encode(['uint8'], [m]);
const later = async (sec) => { await network.provider.send('evm_increaseTime', [sec]); await network.provider.send('evm_mine', []); };

describe('RatPoolLock', () => {
  let positions, other, whype, rat, lock, safe, founder, stranger;
  beforeEach(async () => {
    [safe, founder, stranger] = await ethers.getSigners();
    positions = await (await ethers.getContractFactory('MockPositions')).deploy();
    other = await (await ethers.getContractFactory('MockPositions')).deploy();
    whype = await (await ethers.getContractFactory('MockRAT')).deploy();
    rat = await (await ethers.getContractFactory('MockRAT')).deploy();
    lock = await (await ethers.getContractFactory('RatPoolLock')).deploy(positions.target, whype.target, rat.target, FEE, 14 * DAY, 7 * DAY);
  });
  const mint = async (to, opts = {}) => {
    const id = await positions.nextId();
    await positions.mint(to, opts.token0 || whype.target, opts.token1 || rat.target, opts.fee ?? FEE, opts.liquidity ?? 1000n);
    return id;
  };
  const lockIt = (from, id, m = PERMANENT) => positions.connect(from)['safeTransferFrom(address,address,uint256,bytes)'](from.address, lock.target, id, modeData(m));
  const earn = async (id, a0, a1) => {
    await whype.mint(positions.target, a0);
    await rat.mint(positions.target, a1);
    await positions.accrue(id, a0, a1);
  };

  it('the real durations are 14 days and 7 days; other ones are a TEST lock', async () => {
    expect(await lock.testMode()).to.equal(false);
    expect(await lock.UNLOCK_DELAY()).to.equal(14n * 86400n);
    const t = await (await ethers.getContractFactory('RatPoolLock')).deploy(positions.target, whype.target, rat.target, FEE, 600, 3600);
    expect(await t.testMode()).to.equal(true);
    const F = await ethers.getContractFactory('RatPoolLock');
    await expect(F.deploy(positions.target, whype.target, rat.target, FEE, 0, 1)).to.be.revertedWithCustomError(lock, 'BadDurations');
    await expect(F.deploy(ethers.ZeroAddress, whype.target, rat.target, FEE, 1, 1)).to.be.revertedWithCustomError(lock, 'ZeroAddress');
  });

  it('locks a position sent with its mode: its sender is its holder', async () => {
    const id = await mint(safe.address);
    await expect(lockIt(safe, id, PERMANENT)).to.emit(lock, 'Locked').withArgs(id, safe.address, 1000n, PERMANENT);
    expect(await positions.ownerOf(id)).to.equal(lock.target);
    expect(await lock.holder(id)).to.equal(safe.address);
    expect(await lock.mode(id)).to.equal(PERMANENT);
    expect(await lock.lockedCount()).to.equal(1n);
  });

  it('refuses a position without a mode, of another pool, empty, or from another contract', async () => {
    const id = await mint(safe.address);
    await expect(positions.connect(safe)['safeTransferFrom(address,address,uint256)'](safe.address, lock.target, id)).to.be.revertedWithCustomError(lock, 'NoMode');
    await expect(lockIt(safe, id, 3)).to.be.revertedWithCustomError(lock, 'NoMode');
    // a mint straight to the lock carries no mode
    await expect(positions.mint(lock.target, whype.target, rat.target, FEE, 1n)).to.be.revertedWithCustomError(lock, 'NoMode');
    await expect(lockIt(safe, await mint(safe.address, { token0: rat.target, token1: whype.target }))).to.be.revertedWithCustomError(lock, 'WrongPool');
    await expect(lockIt(safe, await mint(safe.address, { fee: 10000 }))).to.be.revertedWithCustomError(lock, 'WrongPool');
    await expect(lockIt(safe, await mint(safe.address, { liquidity: 0n }))).to.be.revertedWithCustomError(lock, 'NoLiquidity');
    await other.mint(safe.address, whype.target, rat.target, FEE, 1000n);
    await expect(other['safeTransferFrom(address,address,uint256,bytes)'](safe.address, lock.target, 1n, modeData(PERMANENT))).to.be.revertedWithCustomError(lock, 'NotPositionManager');
    await expect(lock.onERC721Received(stranger.address, stranger.address, 1n, modeData(PERMANENT))).to.be.revertedWithCustomError(lock, 'NotPositionManager');
  });

  it('only the holder collects the fees, always to itself, and the liquidity stays', async () => {
    const id = await mint(safe.address);
    await lockIt(safe, id);
    await earn(id, 7n, 1234n);
    await expect(lock.connect(stranger).collectFees(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    await expect(lock.connect(safe).collectFees(id)).to.emit(lock, 'FeesCollected').withArgs(id, safe.address, 7n, 1234n);
    expect(await whype.balanceOf(safe.address)).to.equal(7n);
    expect(await rat.balanceOf(safe.address)).to.equal(1234n);
    expect((await positions.positions(id))[7]).to.equal(1000n);
    expect(await positions.ownerOf(id)).to.equal(lock.target);
  });

  it('a PERMANENT position never leaves, not even for who locked it', async () => {
    const id = await mint(safe.address);
    await lockIt(safe, id, PERMANENT);
    await expect(lock.connect(safe).announceUnlock(id)).to.be.revertedWithCustomError(lock, 'Permanent');
    await expect(lock.connect(safe).unlock(id)).to.be.revertedWithCustomError(lock, 'Permanent');
    await expect(lock.connect(safe).makePermanent(id)).to.be.revertedWithCustomError(lock, 'Permanent');
    await expect(positions.connect(safe).decreaseLiquidity(id, 1n)).to.be.revertedWith('Not approved');
    await expect(positions.connect(safe).burn(id)).to.be.revertedWith('Not approved');
    await expect(positions.connect(safe).transferFrom(lock.target, safe.address, id)).to.be.reverted;
    await expect(positions.connect(safe).collect({ tokenId: id, recipient: safe.address, amount0Max: 1n, amount1Max: 1n })).to.be.revertedWith('Not approved');
    // the lock's whole surface: the only way out is unlock (NOTICE positions, after the public wait)
    const fns = lock.interface.fragments.filter((f) => f.type === 'function').map((f) => f.name).sort();
    expect(fns).to.deep.equal(['NOTICE', 'PERMANENT', 'REAL_UNLOCK_DELAY', 'REAL_UNLOCK_WINDOW', 'UNLOCK_DELAY', 'UNLOCK_WINDOW', 'acceptHolder', 'announceUnlock', 'cancelUnlock', 'collectFees', 'fee', 'holder', 'lockedCount', 'lockedIds', 'makePermanent', 'mode', 'offerHolder', 'onERC721Received', 'pendingHolder', 'positionManager', 'testMode', 'token0', 'token1', 'unlock', 'unlockReadyAt']);
  });

  it('a NOTICE position goes back to its holder only after a public announcement and 14 days, within 7', async () => {
    const id = await mint(founder.address);
    await lockIt(founder, id, NOTICE);
    await expect(lock.connect(founder).unlock(id)).to.be.revertedWithCustomError(lock, 'NotAnnounced');
    await expect(lock.connect(stranger).announceUnlock(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    const tx = await lock.connect(founder).announceUnlock(id);
    const at = (await ethers.provider.getBlock(tx.blockNumber)).timestamp;
    await expect(tx).to.emit(lock, 'UnlockAnnounced').withArgs(id, founder.address, at + 14 * DAY);
    await later(14 * DAY - 60);
    await expect(lock.connect(founder).unlock(id)).to.be.revertedWithCustomError(lock, 'TooSoon');
    await later(120);
    await expect(lock.connect(stranger).unlock(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    await expect(lock.connect(founder).unlock(id)).to.emit(lock, 'Unlocked').withArgs(id, founder.address);
    expect(await positions.ownerOf(id)).to.equal(founder.address);
    expect(await lock.holder(id)).to.equal(ethers.ZeroAddress);
    expect(await lock.mode(id)).to.equal(0n);
  });

  it('an announced unlock lapses 7 days after it is ready, can be cancelled, and is dropped by makePermanent', async () => {
    const id = await mint(founder.address);
    await lockIt(founder, id, NOTICE);
    await lock.connect(founder).announceUnlock(id);
    await later(21 * DAY + 60);
    await expect(lock.connect(founder).unlock(id)).to.be.revertedWithCustomError(lock, 'Lapsed');
    // announced again: a new 14 days
    await lock.connect(founder).announceUnlock(id);
    await expect(lock.connect(founder).cancelUnlock(id)).to.emit(lock, 'UnlockCancelled').withArgs(id);
    await later(15 * DAY);
    await expect(lock.connect(founder).unlock(id)).to.be.revertedWithCustomError(lock, 'NotAnnounced');
    await expect(lock.connect(founder).cancelUnlock(id)).to.be.revertedWithCustomError(lock, 'NotAnnounced');
    // made permanent: for good
    await lock.connect(founder).announceUnlock(id);
    await expect(lock.connect(stranger).makePermanent(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    await expect(lock.connect(founder).makePermanent(id)).to.emit(lock, 'MadePermanent').withArgs(id);
    expect(await lock.unlockReadyAt(id)).to.equal(0n);
    await later(15 * DAY);
    await expect(lock.connect(founder).unlock(id)).to.be.revertedWithCustomError(lock, 'Permanent');
    await expect(lock.connect(founder).announceUnlock(id)).to.be.revertedWithCustomError(lock, 'Permanent');
  });

  it('the holder hands its rights over in two steps; a withdrawn or foreign offer does nothing', async () => {
    const id = await mint(safe.address);
    await lockIt(safe, id, NOTICE);
    await expect(lock.connect(stranger).offerHolder(id, stranger.address)).to.be.revertedWithCustomError(lock, 'NotHolder');
    await lock.connect(safe).offerHolder(id, founder.address);
    await expect(lock.connect(stranger).acceptHolder(id)).to.be.revertedWithCustomError(lock, 'NotOffered');
    await lock.connect(safe).offerHolder(id, ethers.ZeroAddress);
    await expect(lock.connect(founder).acceptHolder(id)).to.be.revertedWithCustomError(lock, 'NotOffered');
    await lock.connect(safe).offerHolder(id, founder.address);
    await expect(lock.connect(founder).acceptHolder(id)).to.emit(lock, 'HolderChanged').withArgs(id, safe.address, founder.address);
    await earn(id, 1n, 2n);
    await expect(lock.connect(safe).collectFees(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    await expect(lock.connect(safe).announceUnlock(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    await lock.connect(founder).collectFees(id);
    expect(await rat.balanceOf(founder.address)).to.equal(2n);
  });

  it('a position sent with a plain transferFrom is stuck with no holder (documented: use safeTransferFrom with a mode)', async () => {
    const id = await mint(safe.address);
    await positions.connect(safe).transferFrom(safe.address, lock.target, id);
    expect(await lock.holder(id)).to.equal(ethers.ZeroAddress);
    await expect(lock.connect(safe).collectFees(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
  });
});
