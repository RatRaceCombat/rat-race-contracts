// Deploys RatRacePot and writes
// deployments/pot-<network>.json.
//
// The pot and the distributor name each other, both for good: the distributor pays its potTotal to
// an immutable pot address, the pot draws only to an immutable distributor whose pot() must name it.
// So, from the same deployer and with no other transaction in between:
//   1. PREDICT=1 npx hardhat --config hardhat.config.cjs run scripts/deploy-pot.cjs --network hyperevm
//      prints the pot's address-to-be (the deployer's nonce + 1);
//   2. deploy the distributor with POT_ADDRESS set to it (scripts/deploy-distributor.cjs);
//   3. npx hardhat --config hardhat.config.cjs run scripts/deploy-pot.cjs --network hyperevm
//      checks the distributor names that address, then deploys the pot there.
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY   required on public networks (only pays the gas)
//   RAT_ADDRESS            RAT on HyperEVM (default 0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca)
//   OWNER_ADDRESS          the Rat Race Admin Safe 0x0db327e2b3804d4Fc835d65FE42695Ab35Fbe8e1 (lowers the rates, schedules raises and key changes). Required on mainnet
//   POT_SIGNER_ADDRESS     the address of the server's POT_SIGNER_KEY: signs the draws only, never funded,
//                          never the distributor's checkpoint key
//   GUARDIAN_ADDRESS       pauses the draws and cancels a raise of the rates (the Rat Race Guardian Safe 0x78441b7e161158a356672c3D34749bc4BDCD3a3a)
//   DISTRIBUTOR_ADDRESS    the distributor deployed at step 2
//   POT_NIGHT_BPS          the 9 PM Manager's share of the pot, bps (default 1000 = 10%, 100..3000)
//   POT_MONTH_BPS          the month's top 10 share of the pot, bps (default 1000 = 10%, 100..3000)
//   TEST=1, POT_TIMINGS    a TEST pot only: "timelock,timelockLong,executionWindow,pauseMax,pausePeriod" in seconds
//                          (the real ones: 3 d, 14 d, 14 d, 4 d, 30 d; never above them, at least one shorter); its
//                          distributor must be a TEST one, and the manifest is pot-<network>-test.json

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const { deploymentOwner } = require('./lib/owner.cjs');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [deployer] = signers;
  if (!deployer) throw new Error('No deployment account configured');
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  if (process.env.PREDICT) {
    // the distributor's deploy takes the current nonce, the pot the next one
    console.log(`The pot will be at ${ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 })} if the distributor is deployed next from ${deployer.address} (nonce ${nonce}).`);
    return;
  }
  const local = network.name === 'localhost' || network.name === 'hardhat';
  const mainnet = network.name === 'hyperevm';
  const need = (k, i) => {
    const v = env(k, local ? signers[i].address : null);
    if (!v) throw new Error(`${k} is required on ${network.name}`);
    return ethers.getAddress(v);
  };
  const administration = await deploymentOwner(ethers.provider, network.name, deployer.address);
  const owner = administration.address;
  const signer = need('POT_SIGNER_ADDRESS', 2);
  const guardian = need('GUARDIAN_ADDRESS', 3);
  const distributor = ethers.getAddress(env('DISTRIBUTOR_ADDRESS', ''));
  const rat = ethers.getAddress(env('RAT_ADDRESS', mainnet ? '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca' : ''));
  const night = Number(env('POT_NIGHT_BPS', 1000));
  const month = Number(env('POT_MONTH_BPS', 1000));

  // the checks the contract cannot make: its own key, and a distributor that names this very pot
  const dist = new ethers.Contract(distributor, ['function pot() view returns (address)', 'function signer() view returns (address)', 'function confirmPot()', 'function potLinked() view returns (bool)'], deployer);
  const here = ethers.getCreateAddress({ from: deployer.address, nonce });
  const named = await dist.pot().catch(() => null);
  if (!named || ethers.getAddress(named) !== here) throw new Error(`the distributor names the pot ${named}, this deploy would put it at ${here}: deploy the distributor with POT_ADDRESS=${here} first, then nothing else from ${deployer.address}`);
  const distSigner = await dist.signer().catch(() => null);
  if (distSigner && ethers.getAddress(distSigner) === signer) throw new Error('POT_SIGNER_ADDRESS is the distributor\'s checkpoint signer: the pot needs its own key');
  if (!local && new Set([owner, signer, guardian].map((a) => a.toLowerCase())).size < 3) throw new Error('owner, pot signer and guardian must be three different addresses');

  const REAL = [3 * 86400, 14 * 86400, 14 * 86400, 4 * 86400, 30 * 86400];
  const test = process.env.TEST === '1';
  if (!test && process.env.POT_TIMINGS) throw new Error('POT_TIMINGS is for a TEST pot only (TEST=1)');
  const t = env('POT_TIMINGS', REAL.join(',')).split(',').map(Number);
  if (t.length !== 5 || t.some((v, i) => !Number.isInteger(v) || v <= 0 || v > REAL[i])) throw new Error('POT_TIMINGS: five whole numbers of seconds, each over 0 and at most the real one');
  if (test && !t.some((v, i) => v < REAL[i])) throw new Error('TEST=1: POT_TIMINGS must shorten at least one delay');
  const timings = { timelock: t[0], timelockLong: t[1], executionWindow: t[2], pauseMax: t[3], pausePeriod: t[4] };
  if (test) console.log(`TEST POT (delays under the real ones): ${t.join(', ')} s`);
  const distMode = await new ethers.Contract(distributor, ['function testMode() view returns (bool)'], ethers.provider).testMode().catch(() => null);
  if ((distMode ?? false) !== test) throw new Error(test ? 'TEST=1: the distributor must be a TEST one' : 'the distributor is a TEST one (or answers no testMode): a real pot takes the real distributor');
  const P = await ethers.getContractFactory('RatRacePot');
  const pot = await P.deploy(owner, rat, distributor, signer, guardian, night, month, timings);
  const receipt = await (await pot.waitForDeployment()).deploymentTransaction().wait();
  const address = await pot.getAddress();
  if (address !== here) throw new Error(`the pot landed at ${address}, not ${here}`);
  console.log(`RatRacePot at ${address} (block ${receipt.blockNumber}), draws to ${distributor}`);
  if ((await pot.testMode()) !== test) throw new Error(`the pot's testMode() on chain is not ${test}: do not use it`);
  // the distributor pays the pot only once it saw the pot name it (anybody may confirm it)
  if (!(await dist.potLinked())) await (await dist.confirmPot()).wait();
  if (!(await dist.potLinked())) throw new Error('the distributor did not confirm the pot: check both addresses');
  console.log('Distributor confirmed the pot: its pot share is on.');
  const out = {
    network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId),
    address, deployBlock: receipt.blockNumber, rat, distributor,
    owner, pendingOwner: await pot.pendingOwner(), ownerKind: administration.kind, signer, guardian, nightBps: night, monthBps: month,
    test, timings,
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const name = `pot-${network.name}${test ? '-test' : ''}.json`;
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote deployments/${name}. Then set POT_ADDRESS, POT_SIGNER_ADDRESS and POT_DEPLOY_BLOCK on the game server (the key: the rat-race-pot-signer Worker).`);
}

// (run by hardhat run; the tests call main() themselves: test/DeployScripts.test.js)
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
module.exports = { main };
