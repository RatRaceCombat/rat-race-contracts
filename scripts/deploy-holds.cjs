// Deploys the staking of 2026-10-14: RatRaceHolds (RAT staked by the month for the Vault
// suits, the 3-month bonus out of a pool nobody can take out) and its Vault minter RatRaceHolderSuits (the
// suits a stake earned, minted in the permanent collection as Vault copies), and writes
// deployments/holds-<network>.json. The backoffice deploys them too (Contracts, "RAT staking" and "Vault suits
// minter"), and builds the opening batch (Staking opening).
//
//   npx hardhat --config hardhat.config.cjs run scripts/deploy-holds.cjs --network hyperevm
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY   required on public networks (only pays the gas: it gets no right on either contract)
//   RAT_ADDRESS            RAT on HyperEVM (a MockRAT is deployed on a local network without it)
//   SUITS_ADDRESS          the permanent collection (RatRaceSuits): the Vault copies are minted there
//   HOLDS_ADMIN            the Rat Race Admin Safe (0x0db327e2b3804d4Fc835d65FE42695Ab35Fbe8e1): only sets the opening, once, at least 3 days ahead
//   HOLDER_SUITS_OWNER     the same Safe: only sets each month's 4 suits, once (default: HOLDS_ADMIN)
//   TEST=1                 a TEST staking: half-hour months (a day of the month is a minute), the tiers at 0.1%,
//                          10 minutes of notice; its collection a TEST one; the manifest holds-<network>-test.json
//
// After the deploy, one Safe batch (the backoffice's Staking opening): the lineup suits' Vault editions marked in
// the collection (markVault), the Vault minter made its minter (bootstrapMinter while no copy exists, else
// announceMinter then addMinter after the notice), months 1 to 4's suits (setLineup), then setOpens. Then the
// bonus pool (a plain RAT transfer, or fund()), the source verified, the addresses on the game server.

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

const DAY = 86400;
const DAYS = [[30], [14, 30], [14, 21, 30], [7, 14, 21, 30]]; // when each of a month's suits comes, by how many
/** The rules: the real ones (the contract's realParams()), or the TEST ones (a day of the month is a minute). */
function rules(ethers, test) {
  const unit = test ? 60 : DAY;
  return {
    monthSec: 30 * unit,
    tiers: (test ? [5, 25, 50, 100] : [5000, 25000, 50000, 100000]).map((n) => ethers.parseUnits(String(n), 18)),
    unlockByCount: DAYS.map((r) => [0, 1, 2, 3].map((i) => (r[i] == null ? 0 : r[i] * unit))),
    bonusMonths: 3,
    bonusBps: 1000,
    opensNotice: test ? 600 : 3 * DAY,
  };
}
const text = (p) => ({ monthSec: String(p.monthSec), tiers: [...p.tiers].map(String), unlockByCount: [...p.unlockByCount].map((r) => [...r].map(String)),
  bonusMonths: String(p.bonusMonths), bonusBps: String(p.bonusBps), opensNotice: String(p.opensNotice) });

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  if (!deployer) throw new Error('No deployment account configured');
  const local = network.name === 'localhost' || network.name === 'hardhat';
  const test = process.env.TEST === '1', suffix = test ? '-test' : '';
  const need = (k, fallback) => {
    const v = process.env[k] || (local ? fallback : '');
    if (!v) throw new Error(`${k} is required on ${network.name}`);
    return ethers.getAddress(v);
  };
  let rat = process.env.RAT_ADDRESS;
  if (!rat && local) {
    const t = await (await ethers.getContractFactory('MockRAT')).deploy();
    rat = await (await t.waitForDeployment()).getAddress();
    console.log(`MockRAT deployed at ${rat}`);
  }
  rat = need('RAT_ADDRESS', rat);
  const suits = need('SUITS_ADDRESS');
  const admin = need('HOLDS_ADMIN', signers[1]?.address);
  const owner = process.env.HOLDER_SUITS_OWNER ? ethers.getAddress(process.env.HOLDER_SUITS_OWNER) : admin;
  if (!local && [admin, owner].includes(deployer.address)) throw new Error('the deployer pays the gas only: the admin and the minter\'s owner are the Safe');
  // the collection: a deployed RatRaceSuits of the same kind (the Vault minter's constructor refuses the rest too)
  if ((await ethers.provider.getCode(suits)) === '0x') throw new Error('SUITS_ADDRESS has no contract');
  const collection = new ethers.Contract(suits, ['function testMode() view returns (bool)', 'function isMinter(address) view returns (bool)'], ethers.provider);
  const suitsMode = await collection.testMode().catch(() => null);
  await collection.isMinter(ethers.ZeroAddress);
  if (suitsMode !== test) throw new Error(test ? 'TEST=1: SUITS_ADDRESS must be the TEST collection' : 'SUITS_ADDRESS is a TEST collection (or none): a real staking mints in the real one');
  const params = rules(ethers, test);
  console.log(`${test ? 'TEST STAKING (half-hour months, the tiers at 0.1%): ' : ''}months of ${params.monthSec} s, tiers ${params.tiers.map((t) => ethers.formatUnits(t, 18)).join(' / ')} RAT, notice ${params.opensNotice} s`);

  const H = await ethers.getContractFactory('RatRaceHolds');
  const holds = await H.deploy(rat, admin, params);
  const hReceipt = await (await holds.waitForDeployment()).deploymentTransaction().wait();
  const address = await holds.getAddress();
  if ((await holds.rat()) !== rat || (await holds.owner()) !== admin || (await holds.testMode()) !== test
    || JSON.stringify(text(await holds.params())) !== JSON.stringify(text(params))) throw new Error(`staking ${address} does not hold the expected settings`);

  const M = await ethers.getContractFactory('RatRaceHolderSuits');
  const minter = await M.deploy(owner, address, suits);
  const mReceipt = await (await minter.waitForDeployment()).deploymentTransaction().wait();
  const minterAddress = await minter.getAddress();
  if ((await minter.holds()) !== address || (await minter.suits()) !== suits || (await minter.owner()) !== owner || (await minter.testMode()) !== test) throw new Error(`Vault minter ${minterAddress} does not hold the expected settings`);

  const out = {
    network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), test,
    address, deployBlock: hReceipt.blockNumber, rat, admin, params: text(params),
    holderSuits: { address: minterAddress, deployBlock: mReceipt.blockNumber, owner, suits },
    // (the bonus pool: 100,000 RAT from the later seasons' reserve, split between this pool and the game's)
    fundBonusPoolWithRat: test ? 100 : 'up to 100000',
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `holds-${network.name}${suffix}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`RatRaceHolds at ${address} (block ${hReceipt.blockNumber}), its Vault minter at ${minterAddress} (block ${mReceipt.blockNumber}).`);
  console.log('Next, one Safe batch (the backoffice\'s Staking opening): markVault, the minter in the collection, months 1 to 4\'s suits, setOpens; then the bonus pool.');
}

// (run by hardhat run; the tests call main() themselves: test/DeployScripts.test.js)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main, rules };
