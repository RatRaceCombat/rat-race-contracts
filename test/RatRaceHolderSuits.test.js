// RatRaceHolderSuits: the Vault minter. A suit earned by staking (RatRaceHolds says so) is minted as a Vault
// copy (1,000,000 + the suit's id) in the permanent collection, to the staker, once; nothing lapses; the owner
// only sets a month's lineup, once, with Vault editions; the copies stay put until the Vault switch.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deploySuits } = require('./helpers/suits.cjs');

const RAT = (n) => ethers.parseUnits(String(n), 18);
const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
const mine = async (t) => { await ethers.provider.send('evm_setNextBlockTimestamp', [t]); await ethers.provider.send('evm_mine', []); };
const MONTH = 1800; // a TEST staking month: 30 minutes
const at = (d) => Math.round((MONTH * d) / 30); // day d of a TEST month
const VAULT = 1_000_000n;

/** A TEST staking contract (0.1% amounts, 30-minute months), a TEST collection and the Vault minter on them. */
async function deploy() {
  const [owner, alice, bob, keeper] = await ethers.getSigners();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const p = {
    monthSec: MONTH,
    tiers: [RAT(5), RAT(25), RAT(50), RAT(100)],
    unlockByCount: [[at(30), 0, 0, 0], [at(14), at(30), 0, 0], [at(14), at(21), at(30), 0], [at(7), at(14), at(21), at(30)]],
    bonusMonths: 3,
    bonusBps: 1000,
    opensNotice: 60,
  };
  const holds = await (await ethers.getContractFactory('RatRaceHolds')).deploy(await rat.getAddress(), owner.address, p);
  const suits = await deploySuits(owner.address, owner.address, 500, true, 600, 3600);
  const minter = await (await ethers.getContractFactory('RatRaceHolderSuits')).deploy(owner.address, await holds.getAddress(), await suits.getAddress());
  await suits.bootstrapMinter(await minter.getAddress());
  // month 1's suits (Purple Suit, Space Intern, Showgirl, Green Candle): Vault editions first
  const lineup = [6n, 12n, 17n, 37n];
  await suits.markVault(lineup.map((id) => VAULT + id));
  const opens = (await now()) + 120;
  await holds.setOpens(opens);
  for (const s of [alice, bob]) {
    await rat.mint(s.address, RAT(1000));
    await rat.connect(s).approve(await holds.getAddress(), ethers.MaxUint256);
  }
  return { rat, holds, suits, minter, owner, alice, bob, keeper, lineup, opens };
}

describe('RatRaceHolderSuits (the Vault minter)', () => {
  it('mints what the staking contract says was earned, to the staker, once, any time after', async () => {
    const { holds, suits, minter, alice, keeper, lineup, opens } = await deploy();
    await holds.connect(alice).stake(RAT(50)); // 3 suits a month: days 14, 21, 30
    await expect(minter.claim(alice.address, 0, 1, 0)).to.be.revertedWithCustomError(minter, 'NoLineup');
    await minter.setLineup(1, lineup);
    await expect(minter.setLineup(1, lineup)).to.be.revertedWithCustomError(minter, 'AlreadySet');
    expect(await minter.lineupOf(1)).to.deep.equal(lineup);
    // day 13 of month 1: nothing yet; day 14: the first suit, claimed by anybody for alice
    await mine(opens + at(13));
    await expect(minter.claim(alice.address, 0, 1, 0)).to.be.revertedWithCustomError(minter, 'NotEarned');
    await mine(opens + at(14));
    expect(await minter.claimable(alice.address, 0, 1, 0)).to.equal(true);
    await expect(minter.connect(keeper).claim(alice.address, 0, 1, 0)).to.emit(minter, 'VaultClaimed').withArgs(alice.address, 0, 1, 0, VAULT + 6n, keeper.address);
    expect(await suits.balanceOf(alice.address, VAULT + 6n)).to.equal(1n);
    await expect(minter.claim(alice.address, 0, 1, 0)).to.be.revertedWithCustomError(minter, 'AlreadyClaimed');
    // the 4th suit (Green Candle) is the 100,000 RAT stakes' only
    await mine(opens + 3 * MONTH);
    await expect(minter.claim(alice.address, 0, 1, 3)).to.be.revertedWithCustomError(minter, 'NotEarned');
    // months later: slots 1 and 2 of month 1, at once (nothing lapses)
    await minter.claimMany(alice.address, 0, [1, 1], [1, 2]);
    expect([await suits.balanceOf(alice.address, VAULT + 12n), await suits.balanceOf(alice.address, VAULT + 17n)]).to.deep.equal([1n, 1n]);
    await expect(minter.claim(alice.address, 0, 1, 4)).to.be.revertedWithCustomError(minter, 'BadSlot');
  });

  it('a Vault copy stays with its staker until the collection opens Vault transfers', async () => {
    const { holds, suits, minter, alice, bob, lineup, opens } = await deploy();
    await holds.connect(alice).stake(RAT(5)); // 1 suit: day 30
    await minter.setLineup(1, lineup);
    await mine(opens + at(30));
    await minter.claim(alice.address, 0, 1, 0);
    await expect(suits.connect(alice).safeTransferFrom(alice.address, bob.address, VAULT + 6n, 1, '0x')).to.be.revertedWithCustomError(suits, 'Soulbound');
  });

  it('the lineup takes Vault editions only; the owner never mints; a TEST minter never pairs with a real collection', async () => {
    const { holds, minter, owner, alice } = await deploy();
    await expect(minter.setLineup(2, [7n, 13n, 23n, 38n])).to.be.revertedWithCustomError(minter, 'NotVault');
    await expect(minter.connect(alice).setLineup(2, [6n, 12n, 17n, 37n])).to.be.revertedWithCustomError(minter, 'OwnableUnauthorizedAccount');
    const writes = minter.interface.fragments.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability)).map((f) => f.name).sort();
    expect(writes).to.deep.equal(['acceptOwnership', 'claim', 'claimMany', 'setLineup', 'transferOwnership']);
    await expect(minter.renounceOwnership()).to.be.revertedWithCustomError(minter, 'NoRenounce');
    const real = await deploySuits(owner.address, owner.address);
    const F = await ethers.getContractFactory('RatRaceHolderSuits');
    await expect(F.deploy(owner.address, await holds.getAddress(), await real.getAddress())).to.be.revertedWithCustomError(F, 'BadCollection');
  });
});
