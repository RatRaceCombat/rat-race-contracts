// Deploys RatRaceDistributor (RAT withdrawals: checkpoints signed by the game every 10 minutes, published
// and claimed by the players) and writes deployments/distributor-<network>.json. The launcher
// (deploy-launch.cjs: the distributor and the pot together, linked) is the one to use.
//
//   npx hardhat --config hardhat.config.cjs run scripts/deploy-distributor.cjs --network hyperevm
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY     required on public networks (only pays the gas)
//   RAT_ADDRESS              RAT on HyperEVM (default 0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca;
//                            a MockRAT is deployed on other networks)
//   OWNER_ADDRESS            Safe multisig: limits, signer, unpause. Required on mainnet: the Rat Race Admin Safe
//                            0x0db327e2b3804d4Fc835d65FE42695Ab35Fbe8e1
//   DISTRIBUTOR_SIGNER_ADDRESS address of the server's DISTRIBUTOR_SIGNER_KEY (checkpoints only)
//   SIGNER_ADDRESS           legacy fallback when a separate checkpoint signer is not configured
//   GUARDIAN_ADDRESS         can veto a pending checkpoint, cancel a scheduled change (never its own
//                            replacement), pause and veto within a freeze credit of 4 days that
//                            refills at 4 days per 30 open days (the Rat Race Guardian Safe 0x78441b7e161158a356672c3D34749bc4BDCD3a3a)
//   SENTINEL_ADDRESS         optional: the watcher bot's key, it can only pause and veto (same credit);
//                            never the checkpoint key; the owner or the guardian drop it at once
//   POT_ADDRESS              RatRacePot, the Big Cheese pot (fixed for good): its share of the fees goes there.
//                            Deploy order: deploy-pot.cjs PREDICT=1 prints its future address, then this, then
//                            deploy-pot.cjs (it checks the link)
//   V1_DISTRIBUTOR_DELAY_SEC  activation delay, the veto window (default 600 = 10 minutes, the least; a day at most)
//   MAX_STEP_WITHDRAW_RAT    max rise of the withdrawals per checkpoint (default 50000 RAT, at most OUTFLOW_CAP_RAT)
//   MAX_STEP_SETTLE_RAT      max rise of the burn per checkpoint (default 20000 RAT, at most BURN_CAP_RAT)
//   MAX_BOUNTY_RAT           max publisher bounty (default 50 RAT; the server draws 1..20)
//   OUTFLOW_CAP_RAT          RAT that may be published to leave, and paid to wallets, in any 24 h (withdrawals +
//                            bounties; at least 24,000, the daily floor)
//                            (default 50000 = 5% of the season reserve). Fixed for good at deploy
//   BURN_CAP_RAT             RAT that may be burned in any 24 h (default 20000: a stolen signer key could destroy
//                            at most that much of the reserve a day). Fixed for good at deploy
//
// Once deployed, a new signer or sentinel and any loosening of the limits wait 3 days in public, a new
// guardian and a sweep (only ever to the dead address) 14: schedule(call), then execute(call).
//
// After the deploy: send the RAT reserve to the contract (it must cover every in-game balance
// that can be withdrawn), then set on the game server DISTRIBUTOR_ADDRESS,
// DISTRIBUTOR_SIGNER_KEY and DISTRIBUTOR_DEPLOY_BLOCK.

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { deploymentOwner } = require('./lib/owner.cjs');
// the time rules: the real ones (testMode false); TEST=1 deploys a test (short ones: TEST_DIST,
// or DIST_TIMINGS as JSON) whose manifests end in -test.json, so a real deploy never reads a test address
const { REAL_DIST, TEST_DIST } = require('../test/helpers/timings.cjs');
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
  const signer = process.env.DISTRIBUTOR_SIGNER_ADDRESS
    ? ethers.getAddress(process.env.DISTRIBUTOR_SIGNER_ADDRESS) : need('SIGNER_ADDRESS', 1);
  const guardian = need('GUARDIAN_ADDRESS', 3);
  const pot = need('POT_ADDRESS', 5);
  if (new Set([owner, signer, guardian, pot].map((a) => a.toLowerCase())).size < 4 && !local) {
    throw new Error('owner, signer, guardian and pot must be four different addresses');
  }
  // the sentinel (optional): a watcher bot's key that can only pause and veto a checkpoint during its
  // delay; never the checkpoint key, and the owner or the guardian drop it at once
  const sentinel = env('SENTINEL_ADDRESS', '') ? ethers.getAddress(env('SENTINEL_ADDRESS')) : ethers.ZeroAddress;
  if (sentinel !== ethers.ZeroAddress && new Set([owner, signer, guardian, pot, sentinel].map((a) => a.toLowerCase())).size < 5) {
    throw new Error('the sentinel must be its own address (not the owner, a signer, the guardian or the pot)');
  }

  let rat = env('RAT_ADDRESS', mainnet ? '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca' : undefined);
  let mock = false;
  if (!rat) {
    const t = await (await ethers.getContractFactory('MockRAT')).deploy();
    await t.waitForDeployment();
    rat = await t.getAddress();
    mock = true;
    console.log(`MockRAT deployed at ${rat}`);
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
  if (process.env.DELAY_SEC !== undefined && process.env.V1_DISTRIBUTOR_DELAY_SEC === undefined) {
    console.warn('DELAY_SEC is ignored: the activation delay is V1_DISTRIBUTOR_DELAY_SEC (default 600)');
  }
  // the constructor refuses steps above the caps: say which one rather than a bare revert (and never
  // "fix" it by raising a cap, which can never be lowered again)
  if (stepW > outflowCap) throw new Error('MAX_STEP_WITHDRAW_RAT is above OUTFLOW_CAP_RAT: lower the step');
  if (bounty > outflowCap || stepS > burnCap) throw new Error('MAX_BOUNTY_RAT is above OUTFLOW_CAP_RAT or MAX_STEP_SETTLE_RAT above BURN_CAP_RAT: lower it');
  // the contract keeps at least 24,000 RAT a day possible: one step every max(delay, 10 minutes)
  if (stepW * 86400n < RAT(24000) * BigInt(Math.max(delay, 600))) throw new Error('MAX_STEP_WITHDRAW_RAT is too small for the delay: the withdrawals must allow 24,000 RAT a day');

  console.log(`Deploying RatRaceDistributor on ${network.name} from ${deployer.address}`);
  const D = await ethers.getContractFactory('RatRaceDistributor');
  const distTimings = timingsOf('DIST_TIMINGS', REAL_DIST, TEST_DIST);
  const d = await D.deploy(owner, rat, signer, guardian, sentinel, pot, { delay, maxStepWithdraw: stepW, maxStepSettle: stepS, maxBounty: bounty, outflowCap, burnCap }, distTimings);
  const receipt = await (await d.waitForDeployment()).deploymentTransaction().wait();
  const address = await d.getAddress();
  if ((await d.testMode()) !== TEST) throw new Error(`testMode on chain is ${await d.testMode()} but TEST=${TEST ? 1 : 0}: do not use this contract`);
  console.log(`RatRaceDistributor at ${address} (block ${receipt.blockNumber})`);

  const out = {
    profile: 'v1', network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    address,
    deployBlock: receipt.blockNumber,
    rat: { address: rat, mock },
    owner, pendingOwner: await d.pendingOwner(), ownerKind: administration.kind, signer, guardian, sentinel, pot,
    testMode: await d.testMode(), distTimings,
    delay, maxStepWithdraw: stepW.toString(), maxStepSettle: stepS.toString(), maxBounty: bounty.toString(),
    outflowCap: outflowCap.toString(), burnCap: burnCap.toString(),
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = `distributor-${network.name}${TEST ? '-test' : ''}.json`;
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
