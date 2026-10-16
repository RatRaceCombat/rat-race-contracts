// Deploys the founders' vesting: two FoundersVesting,
// one per founder, and writes deployments/vesting-<network>.json.
//
//   npx hardhat --config hardhat.config.cjs run scripts/deploy-vesting.cjs --network hyperevm
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY   required on public networks (only pays the gas: it gets no right on the wallets)
//   FOUNDER_A_ADDRESS      first founder's wallet (the beneficiary). Required on public networks
//   FOUNDER_B_ADDRESS      second founder's wallet. Required on public networks
//   TEST=1                 a TEST vesting: VESTING_START (unix seconds) and VESTING_DURATION_SEC then apply; it says TEST
//                          loudly and asks for 300 RAT each, not 300,000. Without TEST=1 they are refused.
//
// The schedule: nothing before the launch, then linear over 365 days. The
// launch: VESTING_START (unix seconds) fixes it at deploy; without it each founder starts the 12 months once with
// begin(), 30 days ahead at least. The contract refuses a real start
// over a day in the past. No revoke, no upgrade, no admin; anyone may call
// release(RAT). After the deploy: send 300,000 RAT to each address, verify the source on the
// explorer (FoundersVesting on OpenZeppelin v5 VestingWallet) and publish both addresses.

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

const DURATION = 31536000; // 365 days, 12 months from the start (the launch: VESTING_START, or the founder's begin())
const PER_FOUNDER_RAT = 300000;

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  if (!deployer) throw new Error('No deployment account configured');
  const local = network.name === 'localhost' || network.name === 'hardhat';
  const founder = (k, i) => {
    const v = process.env[k] || (local ? signers[i].address : '');
    if (!v) throw new Error(`${k} is required on ${network.name}`);
    return ethers.getAddress(v);
  };
  const founders = [founder('FOUNDER_A_ADDRESS', 1), founder('FOUNDER_B_ADDRESS', 2)];
  if (founders[0] === founders[1]) throw new Error('the two founders need two different wallets');
  if (founders.includes(deployer.address) && !local) throw new Error('the deployer pays the gas only: use the founders\' own wallets');

  // the real schedule, or a TEST vesting's (TEST=1 only)
  const test = process.env.TEST === '1';
  const testKeys = ['VESTING_DURATION_SEC'];
  if (!test && testKeys.some((k) => process.env[k])) throw new Error(`${testKeys.join(', ')} are for a TEST vesting only (TEST=1)`);
  const num = (k, d) => {
    const v = Number(test ? process.env[k] ?? d : d);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${k} must be a whole number over 0`);
    return v;
  };
  // the start: the launch (VESTING_START, unix seconds; the contract refuses a real one over a day in the past), or 0:
  // the founder starts it with begin(), the RAT locked meanwhile
  const start = process.env.VESTING_START ? Number(process.env.VESTING_START) : 0;
  if (!Number.isInteger(start) || start < 0) throw new Error('VESTING_START must be a unix time in seconds (or unset: the founder starts it)');
  const duration = num('VESTING_DURATION_SEC', DURATION);
  const fund = test ? PER_FOUNDER_RAT / 1000 : PER_FOUNDER_RAT;
  // a TEST vesting says so on chain: the start or the duration differs from the real one
  if (test && duration === DURATION) throw new Error('TEST=1: change the duration (else it is the real vesting)');
  if (test) console.log(`TEST VESTING: start ${new Date(start * 1000).toISOString()}, ${duration} s, ${fund} RAT each`);
  const V = await ethers.getContractFactory('FoundersVesting');
  const wallets = [];
  for (const beneficiary of founders) {
    const w = await V.deploy(beneficiary, start, duration);
    const receipt = await (await w.waitForDeployment()).deploymentTransaction().wait();
    const address = await w.getAddress();
    if (Number(await w.startAtDeploy()) !== start || Number(await w.duration()) !== duration || (await w.owner()) !== beneficiary || (await w.testMode()) !== test) {
      throw new Error(`vesting wallet ${address} does not hold the expected schedule`);
    }
    console.log(`FoundersVesting for ${beneficiary} at ${address} (block ${receipt.blockNumber})`);
    wallets.push({ beneficiary, address, deployBlock: receipt.blockNumber, fundWithRat: fund });
  }
  const out = {
    network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), test,
    start, startUtc: start ? new Date(start * 1000).toISOString() : 'set by each founder (begin)', duration,
    endUtc: start ? new Date((start + duration) * 1000).toISOString() : null, wallets,
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const name = `vesting-${network.name}${test ? '-test' : ''}.json`;
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote deployments/${name}. Next: send ${fund.toLocaleString('en-US')} RAT to each wallet.`);
}

// (run by hardhat run; the tests call main() themselves: test/DeployScripts.test.js)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
