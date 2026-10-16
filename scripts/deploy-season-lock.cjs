// Deploys SeasonReserveLock: the 400,000 RAT of the seasons after the first, locked until the next
// season, only ever to the distributor, and writes
// deployments/season-lock-<network>.json. The backoffice deploys it too (Contracts, "Season reserve lock").
//
//   npx hardhat --config hardhat.config.cjs run scripts/deploy-season-lock.cjs --network hyperevm
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY     required on public networks (only pays the gas: it gets no right on the lock)
//   RAT_ADDRESS              the RAT token
//   DISTRIBUTOR_ADDRESS      the deployed RatRaceDistributor (its rat() must be RAT_ADDRESS)
//   SEASON_LOCK_ADMIN        the Rat Race Admin Safe (0x0db327e2b3804d4Fc835d65FE42695Ab35Fbe8e1): only starts the countdown (init), once
//   LOCK_COUNTDOWN_SEC, LOCK_BACKSTOP_SEC: the settings (default: the real ones, 182 days and 365 days).
//                            Only with TEST=1 (a TEST lock: at least one shorter, its distributor a TEST one, the
//                            manifest season-lock-<network>-test.json); never above the real ones
// After the deploy: send 400,000 RAT to it, verify the source, publish the address; at the launch of
// season 1 the admin calls init().

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  if (!deployer) throw new Error('No deployment account configured');
  const local = network.name === 'localhost' || network.name === 'hardhat';
  const need = (k, fallback) => {
    const v = process.env[k] || (local ? fallback : '');
    if (!v) throw new Error(`${k} is required on ${network.name}`);
    return ethers.getAddress(v);
  };
  const rat = need('RAT_ADDRESS');
  const distributor = need('DISTRIBUTOR_ADDRESS');
  const admin = need('SEASON_LOCK_ADMIN', signers[1]?.address);
  // the distributor this deployment recorded (launch-<net>.json from deploy-launch.cjs, or the
  // backoffice's distributor-<net>.json), a deployed contract, with that pot and its veto window
  const dir0 = path.join(__dirname, '..', 'deployments');
  const test = process.env.TEST === '1', suffix = test ? '-test' : '';
  const launchFile = path.join(dir0, `launch-${network.name}${suffix}.json`), distFile = path.join(dir0, `distributor-${network.name}${suffix}.json`);
  // (a TEST run of the backoffice writes deployments/test/distributor-<network>.json)
  const boTestFile = path.join(dir0, 'test', `distributor-${network.name}.json`);
  const recordedFile = [launchFile, distFile, ...(test ? [boTestFile] : [])].find((f) => fs.existsSync(f));
  const recorded = recordedFile ? JSON.parse(fs.readFileSync(recordedFile, 'utf8')) : null;
  if (!recorded && !local) throw new Error(`no deployments/launch-${network.name}${suffix}.json (or distributor-${network.name}${suffix}.json${test ? `, or test/distributor-${network.name}.json` : ''}) to check DISTRIBUTOR_ADDRESS against`);
  const recordedDist = recorded ? (recorded.distributor || recorded.address) : null;
  if (recordedDist && ethers.getAddress(recordedDist) !== distributor) throw new Error(`DISTRIBUTOR_ADDRESS is not the recorded distributor (${recordedDist})`);
  if ((await ethers.provider.getCode(distributor)) === '0x') throw new Error('DISTRIBUTOR_ADDRESS has no contract');
  const dist = new ethers.Contract(distributor, ['function rat() view returns (address)', 'function pot() view returns (address)', 'function MIN_DELAY() view returns (uint64)'], ethers.provider);
  if ((await dist.rat()) !== rat) throw new Error('the distributor pays another RAT');
  if (!local && (await dist.pot()) === ethers.ZeroAddress) throw new Error('the distributor has no pot: not a RatRaceDistributor of the launch');
  const recordedPot = recorded?.pot?.address || recorded?.pot; // (the backoffice records the pot as { address, ... })
  if (recordedPot && ethers.getAddress(await dist.pot()) !== ethers.getAddress(recordedPot)) throw new Error(`the distributor's pot is not the recorded pot (${recordedPot})`);
  await dist.MIN_DELAY(); // (a RatRaceDistributor of the review's round 2)
  // a TEST lock pays a TEST distributor, a real lock the real one (the contract refuses the rest too)
  const distMode = await new ethers.Contract(distributor, ['function testMode() view returns (bool)'], ethers.provider).testMode().catch(() => null);
  if (distMode !== test) throw new Error(test ? 'TEST=1: DISTRIBUTOR_ADDRESS must be the TEST distributor' : 'DISTRIBUTOR_ADDRESS is a TEST distributor: a real lock pays the real one');
  if (admin === deployer.address && !local) throw new Error('the deployer pays the gas only: the admin is the admin Safe');
  const REAL = { countdown: 182 * 86400, backstop: 365 * 86400 };
  // never above the real ones (a milliseconds-for-seconds slip would lock the RAT for centuries)
  const keys = ['LOCK_COUNTDOWN_SEC', 'LOCK_BACKSTOP_SEC'];
  if (!test && keys.some((k) => process.env[k])) throw new Error(`${keys.join(', ')} are for a TEST lock only (TEST=1)`);
  const num = (k, d) => { const v = Number(process.env[k] ?? d); if (!Number.isInteger(v) || v <= 0 || v > d) throw new Error(`${k} must be a whole number over 0, at most the real ${d}`); return v; };
  const set = { countdown: num('LOCK_COUNTDOWN_SEC', REAL.countdown), backstop: num('LOCK_BACKSTOP_SEC', REAL.backstop) };
  if (test !== Object.keys(REAL).some((k) => set[k] < REAL[k])) throw new Error('TEST=1: shorten at least one setting of the lock');
  console.log(`${test ? 'TEST LOCK (settings under the real ones): ' : ''}countdown ${set.countdown} s, backstop ${set.backstop} s`);
  const L = await ethers.getContractFactory('SeasonReserveLock');
  const lock = await L.deploy(rat, distributor, admin, set.countdown, set.backstop);
  const receipt = await (await lock.waitForDeployment()).deploymentTransaction().wait();
  const address = await lock.getAddress();
  if ((await lock.distributor()) !== distributor || (await lock.owner()) !== admin || (await lock.testMode()) !== test) throw new Error(`season lock ${address} does not hold the expected settings`);
  const out = { network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), address, deployBlock: receipt.blockNumber, rat, distributor, admin, settings: set, test, fundWithRat: test ? 400 : 400000 };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `season-lock-${network.name}${suffix}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`SeasonReserveLock at ${address} (block ${receipt.blockNumber}). Next: send ${out.fundWithRat.toLocaleString('en-US')} RAT to it; at season 1 the admin calls init().`);
}

// (run by hardhat run; the tests call main() themselves: test/DeployScripts.test.js)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
