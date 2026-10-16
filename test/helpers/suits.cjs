// The suits are two contracts since 2026-10-14: the permanent
// collection (RatRaceSuits) and a replaceable shop (RatRaceSkins), one of its minters. shopWith() takes the
// shop's arguments as they were before the split, (owner, usdc, treasury, buyback, buybackBps, minter,
// royaltyBps, rat, rewards, quoteSigner, claimSigner, split), deploys a collection owned by `owner` (its
// royalty to the treasury, TEST when the pot is), then the shop on it, and makes the shop a minter.
const { ethers } = require('hardhat');

const DAY = 86400;

async function testModeOf(address) {
  if ((await ethers.provider.getCode(address)) === '0x') return false;
  const c = new ethers.Contract(address, ['function testMode() view returns (bool)'], ethers.provider);
  return c.testMode().catch(() => false);
}

/** The signer of an address among the test accounts. */
async function signerOf(address) {
  for (const s of await ethers.getSigners()) if (s.address.toLowerCase() === String(address).toLowerCase()) return s;
  throw new Error(`no test signer for ${address}`);
}

/** A collection: (owner, royalty receiver, royalty bps, test). */
async function deploySuits(owner, royaltyReceiver, royaltyBps = 500, test = false, notice = 3 * DAY, window = 14 * DAY, firstMinter = ethers.ZeroAddress) {
  return (await ethers.getContractFactory('RatRaceSuits')).deploy(owner, royaltyReceiver, royaltyBps, notice, window, test, firstMinter);
}

/** The shop on a new collection, from the shop's arguments of before the split. Returns the shop with `.suits`. */
async function shopWith(args, signer) {
  const [owner, usdc, treasury, buyback, buybackBps, minter, royaltyBps, rat, rewards, quoteSigner, claimSigner, split] = args;
  const suits = await deploySuits(owner, treasury, royaltyBps, await testModeOf(rewards));
  const F = await ethers.getContractFactory('RatRaceSkins', signer);
  const shop = await F.deploy(owner, await suits.getAddress(), usdc, treasury, buyback, buybackBps, minter, rat, rewards, quoteSigner, claimSigner, split);
  await suits.connect(await signerOf(owner)).bootstrapMinter(await shop.getAddress());
  shop.suits = suits;
  return shop;
}

module.exports = { deploySuits, shopWith, signerOf, testModeOf };
