// Deploys RatRaceDistributor and RatRacePot together, linked, in one transaction (RatRaceLaunch; the
// user, 2026-10-13: "the pot and the distributor are always deployed together, so they are linked"),
// and writes deployments/launch-<network>.json.
//
//   npx hardhat --config hardhat.config.cjs run scripts/deploy-launch.cjs --network hyperevm
//
// About 8M gas: over HyperEVM's 2M small blocks, so the deploying address must use big blocks
// (market-maker/token-info page, "Big blocks"). Env (contracts/.env), as deploy-distributor.cjs plus:
//   POT_SIGNER_ADDRESS       the game's draw key for the pot (POT_SIGNER_KEY on the server), never the checkpoint key
//   POT_NIGHT_BPS            the 9 PM Manager's share of the pot a day (default 1000 = 10%)
//   POT_MONTH_BPS            the month's top 10's share of the pot (default 1000 = 10%)
// The guardian guards both. Nothing else to do after it: the link is confirmed in the same transaction.
// Then: send the RAT reserve to the distributor, set DISTRIBUTOR_ADDRESS, POT_ADDRESS and their deploy
// block on the game server, verify both sources on the explorer (their
// constructor arguments are in the JSON written here).

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { deploymentOwner } = require('./lib/owner.cjs');
// the time rules: the real ones (testMode false); TEST=1 deploys a test (short ones: TEST_DIST / TEST_POT,
// or DIST_TIMINGS / POT_TIMINGS as JSON) whose manifests end in -test.json, so a real deploy never reads a test address
const { REAL_DIST, REAL_POT, TEST_DIST, TEST_POT } = require('../test/helpers/timings.cjs');
const isTest = () => process.env.TEST === '1'; // (read when main() runs: the tests call it again and again)
/** A time rules env var: JSON with the named fields, or the numbers in the fields' order, comma separated. */
const parseTimings = (text, real) => {
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const keys = Object.keys(real);
  const v = text.split(',').map((x) => Number(x.trim()));
  if (v.length !== keys.length || v.some((x) => !Number.isFinite(x))) throw new Error(`${keys.length} numbers expected: ${keys.join(', ')}`);
  return Object.fromEntries(keys.map((k, i) => [k, v[i]]));
};
const timingsOf = (name, real, test) => {
  const TEST = isTest();
  if (process.env[name] && !TEST) throw new Error(`${name} shortens the time rules: only with TEST=1 (a test deployment)`);
  const t = TEST ? { ...test, ...(process.env[name] ? parseTimings(process.env[name], real) : {}) } : { ...real };
  if (Object.keys(t).some((k) => !(k in real))) throw new Error(`${name}: unknown field (${Object.keys(real).join(', ')})`);
  if (TEST && !Object.keys(real).some((k) => t[k] < real[k])) throw new Error(`TEST=1 but ${name} keeps every real value: that would be a real deployment`);
  if (TEST) console.warn(`TEST deployment: ${name} ${JSON.stringify(t)} (testMode() will be true)`);
  return t;
};

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

async function main() {
  const TEST = isTest();
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  if (!deployer) throw new Error('No deployment account configured');
  const local = network.name === 'localhost' || network.name === 'hardhat';
  const mainnet = network.name === 'hyperevm';
  const need = (k, localIdx) => {
    const v = env(k, local ? signers[localIdx].address : null);
    if (!v) throw new Error(`${k} is required on ${network.name}`);
    return ethers.getAddress(v);
  };
  const administration = await deploymentOwner(ethers.provider, network.name, deployer.address);
  const owner = administration.address;
  const signer = process.env.DISTRIBUTOR_SIGNER_ADDRESS ? ethers.getAddress(process.env.DISTRIBUTOR_SIGNER_ADDRESS) : need('SIGNER_ADDRESS', 1);
  const guardian = need('GUARDIAN_ADDRESS', 3);
  const potSigner = need('POT_SIGNER_ADDRESS', 4);
  if (new Set([owner, signer, guardian, potSigner].map((a) => a.toLowerCase())).size < 4 && !local) {
    throw new Error('owner, checkpoint signer, guardian and pot signer must be four different addresses');
  }
  // the sentinel (optional): a watcher bot's key that can only pause and veto a checkpoint during its
  // delay; never the checkpoint key nor the pot key, and the owner or the guardian drop it at once
  const sentinel = env('SENTINEL_ADDRESS', '') ? ethers.getAddress(env('SENTINEL_ADDRESS')) : ethers.ZeroAddress;
  if (sentinel !== ethers.ZeroAddress && new Set([owner, signer, guardian, potSigner, sentinel].map((a) => a.toLowerCase())).size < 5) {
    throw new Error('the sentinel must be its own address (not the owner, a signer, the guardian)');
  }

  let rat = env('RAT_ADDRESS', mainnet ? '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca' : undefined);
  let mock = false;
  if (!rat) {
    const t = await (await ethers.getContractFactory('MockRAT')).deploy();
    await t.waitForDeployment();
    rat = await t.getAddress();
    mock = true;
  }
  const RAT = (n) => ethers.parseUnits(String(n), 18);
  const delay = Number(env('V1_DISTRIBUTOR_DELAY_SEC', 600));
  // every checkpoint waits the delay: the veto window (10 minutes to a day, RatRaceDistributor MIN_DELAY / MAX_DELAY)
  if (!(delay >= 600 && delay <= 86400)) throw new Error('V1_DISTRIBUTOR_DELAY_SEC must be 600 (10 minutes) to 86400 (a day)');

  const stepW = RAT(env('MAX_STEP_WITHDRAW_RAT', 50000));
  const stepS = RAT(env('MAX_STEP_SETTLE_RAT', 20000));
  const bounty = RAT(env('MAX_BOUNTY_RAT', 50));
  const outflowCap = RAT(env('OUTFLOW_CAP_RAT', 50000));
  const burnCap = RAT(env('BURN_CAP_RAT', 20000));
  const nightBps = Number(env('POT_NIGHT_BPS', 1000));
  const monthBps = Number(env('POT_MONTH_BPS', 1000));
  if (stepW > outflowCap) throw new Error('MAX_STEP_WITHDRAW_RAT is above OUTFLOW_CAP_RAT: lower the step');
  if (bounty > outflowCap || stepS > burnCap) throw new Error('MAX_BOUNTY_RAT is above OUTFLOW_CAP_RAT or MAX_STEP_SETTLE_RAT above BURN_CAP_RAT: lower it');
  // one checkpoint every max(delay, 10 minutes) must allow 24,000 RAT a day
  if (stepW * 86400n < RAT(24000) * BigInt(Math.max(delay, 600))) throw new Error('MAX_STEP_WITHDRAW_RAT is too small for the delay: the withdrawals must allow 24,000 RAT a day');
  if (mainnet && !(await ethers.provider.send('eth_usingBigBlocks', [deployer.address]))) {
    throw new Error(`${deployer.address} is not on big blocks: switch it first (about 8M gas, over the 2M small blocks)`);
  }

  const distTimings = timingsOf('DIST_TIMINGS', REAL_DIST, TEST_DIST);
  const potTimings = timingsOf('POT_TIMINGS', REAL_POT, TEST_POT);
  const params = { owner, rat, signer, guardian, sentinel, distTimings, potTimings, delay, maxStepWithdraw: stepW, maxStepSettle: stepS, maxBounty: bounty, outflowCap, burnCap, potSigner, nightBps, monthBps };
  console.log(`Deploying RatRaceLaunch (distributor + pot) on ${network.name} from ${deployer.address}`);
  const L = await ethers.getContractFactory('RatRaceLaunch');
  const launcher = await L.deploy(params);
  const receipt = await (await launcher.waitForDeployment()).deploymentTransaction().wait();
  const distributor = await launcher.distributor();
  const pot = await launcher.pot();
  const d = await ethers.getContractAt('RatRaceDistributor', distributor);
  if (!(await d.potLinked())) throw new Error('the pot is not linked: this should never happen');
  const q = await ethers.getContractAt('RatRacePot', pot);
  const modes = [await launcher.testMode(), await d.testMode(), await q.testMode()];
  if (modes.some((m) => m !== TEST)) throw new Error(`testMode on chain ${modes} but TEST=${TEST ? 1 : 0}: do not use these contracts`);
  console.log(`RatRaceDistributor ${distributor}, RatRacePot ${pot}, linked (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)`);

  const out = {
    network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId),
    launcher: await launcher.getAddress(), deployBlock: receipt.blockNumber, distributor, pot,
    rat: { address: rat, mock }, owner, ownerKind: administration.kind, signer, guardian, sentinel, potSigner,
    testMode: await d.testMode(), distTimings, potTimings,
    delay, maxStepWithdraw: stepW.toString(), maxStepSettle: stepS.toString(), maxBounty: bounty.toString(),
    outflowCap: outflowCap.toString(), burnCap: burnCap.toString(), nightBps, monthBps,
    // the explorers verify each by its constructor arguments
    constructorArgs: {
      distributor: [owner, rat, signer, guardian, sentinel, pot, [delay, stepW.toString(), stepS.toString(), bounty.toString(), outflowCap.toString(), burnCap.toString()], Object.values(distTimings)],
      pot: [owner, rat, distributor, potSigner, guardian, nightBps, monthBps, Object.values(potTimings)],
    },
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = `launch-${network.name}${TEST ? '-test' : ''}.json`;
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote deployments/${file}`);
  return { file, ...out };
}

// (run by hardhat run; the tests call main() themselves: test/DeployLaunch.test.js)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
