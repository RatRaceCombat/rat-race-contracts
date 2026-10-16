// SeasonReserveLock: the RAT for the seasons after the first, locked until the next season, only ever
// to the distributor: 182 days after the admin's init, or a year after the deploy
// whatever happened. (The "distributor ran dry" path and its keeper are gone.)
const { expect } = require('chai');
const { ethers } = require('hardhat');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const DAY = 86400;
const mine = async (t) => { await ethers.provider.send('evm_setNextBlockTimestamp', [t]); await ethers.provider.send('evm_mine', []); };
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
// the real lock's settings: 182 days, 365 days
const REAL = [182 * DAY, 365 * DAY];

async function deploy() {
  const [deployer, admin, alice, newAdmin] = await ethers.getSigners();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const dist = await (await ethers.getContractFactory('OwedMock')).deploy(await rat.getAddress());
  const L = await ethers.getContractFactory('SeasonReserveLock');
  const lock = await L.deploy(await rat.getAddress(), await dist.getAddress(), admin.address, ...REAL);
  const deployedAt = await now();
  await rat.mint(await lock.getAddress(), RAT(400000));
  return { rat, dist, lock, L, deployer, admin, alice, newAdmin, deployedAt };
}

describe('SeasonReserveLock (the 400,000 RAT of the next seasons)', () => {
  let snapshot;
  beforeEach(async () => { snapshot = await ethers.provider.send('evm_snapshot', []); });
  afterEach(async () => { await ethers.provider.send('evm_revert', [snapshot]); });

  it('nothing leaves before its time; the only way out is the distributor', async () => {
    const { rat, dist, lock, L, alice } = await deploy();
    await expect(lock.connect(alice).release()).to.be.revertedWithCustomError(L, 'NotOpen');
    const writes = lock.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
    expect(writes).to.deep.equal(['acceptOwnership', 'init', 'release', 'transferOwnership']);
    await expect(lock.renounceOwnership()).to.be.revertedWithCustomError(L, 'NoRenounce');
    // a distributor of another RAT, a wallet, the zero address: refused at deploy
    const other = await (await ethers.getContractFactory('MockRAT')).deploy();
    await expect(L.deploy(await other.getAddress(), await dist.getAddress(), alice.address, ...REAL)).to.be.revertedWithCustomError(L, 'BadDistributor');
    await expect(L.deploy(await rat.getAddress(), alice.address, alice.address, ...REAL)).to.be.revertedWithCustomError(L, 'BadDistributor');
    await expect(L.deploy(await rat.getAddress(), ethers.ZeroAddress, alice.address, ...REAL)).to.be.revertedWithCustomError(L, 'ZeroAddress');
    expect(await rat.balanceOf(await lock.getAddress())).to.equal(RAT(400000));
  });

  it('the countdown: the admin starts it once at season 1; 182 days later anybody sends it all to the distributor', async () => {
    const { rat, dist, lock, L, admin, alice } = await deploy();
    await expect(lock.connect(alice).init()).to.be.revertedWithCustomError(L, 'OwnableUnauthorizedAccount');
    await expect(lock.connect(admin).init()).to.emit(lock, 'Started');
    await expect(lock.connect(admin).init()).to.be.revertedWithCustomError(L, 'AlreadyStarted');
    const started = Number(await lock.startedAt());
    await mine(started + 182 * DAY - 60);
    await expect(lock.connect(alice).release()).to.be.revertedWithCustomError(L, 'NotOpen');
    await mine(started + 182 * DAY);
    const before = await rat.balanceOf(await dist.getAddress());
    await expect(lock.connect(alice).release()).to.emit(lock, 'Released').withArgs(RAT(400000), 1);
    expect(await rat.balanceOf(await dist.getAddress())).to.equal(before + RAT(400000));
    expect(await rat.balanceOf(alice.address)).to.equal(0n);
    // open for good: RAT sent later go the same way
    await expect(lock.release()).to.be.revertedWithCustomError(L, 'NothingToRelease');
    await rat.mint(await lock.getAddress(), RAT(5));
    await expect(lock.release()).to.emit(lock, 'Released').withArgs(RAT(5), 4);
  });

  it('the backstop: a year after the deploy, whatever happened, even without init', async () => {
    const { lock, L, deployedAt } = await deploy();
    await mine(deployedAt + 365 * DAY - 60);
    await expect(lock.release()).to.be.revertedWithCustomError(L, 'NotOpen');
    await mine(deployedAt + 365 * DAY);
    await expect(lock.release()).to.emit(lock, 'Released').withArgs(RAT(400000), 3);
  });

  it('the admin role moves in two steps; status() reads everything', async () => {
    const { rat, dist, lock, admin, newAdmin, deployedAt } = await deploy();
    await lock.connect(admin).transferOwnership(newAdmin.address);
    await lock.connect(newAdmin).acceptOwnership();
    expect(await lock.owner()).to.equal(newAdmin.address);
    await lock.connect(newAdmin).init();
    const s = await lock.status();
    expect(s.balance).to.equal(RAT(400000));
    expect(Number(s.unlockAt) - Number(s.startedAt)).to.equal(182 * DAY);
    expect(Number(s.backstopAt)).to.equal(deployedAt + 365 * DAY);
    expect([s.countdown, s.backstop, s.testMode]).to.deep.equal([BigInt(182 * DAY), BigInt(365 * DAY), false]);
    expect([s.openNow, s.opened, s.admin, s.pendingAdmin, s.distributor, s.rat]).to.deep.equal([false, false, newAdmin.address, ethers.ZeroAddress, await dist.getAddress(), await rat.getAddress()]);
  });

  it('the settings are deploy values: a TEST lock of minutes opens in minutes; the rules hold for any values', async () => {
    const [, admin] = await ethers.getSigners();
    const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
    const dist = await (await ethers.getContractFactory('OwedMock')).deploy(await rat.getAddress());
    const L = await ethers.getContractFactory('SeasonReserveLock');
    const r = await rat.getAddress(), d = await dist.getAddress();
    for (const bad of [[0, 900], [600, 599]]) await expect(L.deploy(r, d, admin.address, ...bad)).to.be.revertedWithCustomError(L, 'BadSettings');
    // never above the real lock
    for (const i of [0, 1]) {
      const over = [...REAL];
      over[i] += 1;
      await expect(L.deploy(r, d, admin.address, ...over)).to.be.revertedWithCustomError(L, 'BadSettings');
    }
    expect(await (await L.deploy(r, d, admin.address, ...REAL)).testMode()).to.equal(false);
    // a TEST lock never pays the real distributor, a real lock never a TEST one
    await expect(L.deploy(r, d, admin.address, 600, 900)).to.be.revertedWithCustomError(L, 'BadDistributor');
    await dist.setTestMode(true);
    await expect(L.deploy(r, d, admin.address, ...REAL)).to.be.revertedWithCustomError(L, 'BadDistributor');
    const test = await L.deploy(r, d, admin.address, 600, 900); // 10 minutes, 15 minutes
    expect([await test.testMode(), (await test.status()).testMode]).to.deep.equal([true, true]);
    await rat.mint(await test.getAddress(), RAT(400));
    await test.connect(admin).init();
    await mine(Number(await test.startedAt()) + 600);
    await expect(test.release()).to.emit(test, 'Released').withArgs(RAT(400), 1);
  });
});
