// Deploys RatPoolLock: liquidity of the RAT/WHYPE 0.30% pool on HyperSwap, locked PERMANENT (the project's) or with
// a public 14-day NOTICE (the founders' own), its fees to whoever locked it, and writes
// deployments/pool-lock-<network>.json. Nothing to fund: positions come in with safeTransferFrom and their mode.
//
//   npx hardhat --config hardhat.config.cjs run scripts/deploy-pool-lock.cjs --network hyperevm
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY   required on public networks (only pays the gas: the lock has no admin)
//   POOL_LOCK_DELAY_SEC, POOL_LOCK_WINDOW_SEC: only with TEST=1 (a TEST lock, manifest pool-lock-<network>-test.json);
//                          the real ones are 14 days and 7 days, never above them
// The pool is read from HyperSwap and checked: WHYPE / RAT, 0.30%, the positions contract's factory.
// To lock a position: ALWAYS the positions contract's safeTransferFrom(owner, lock, id, abi.encode(uint8(mode))),
// mode 1 PERMANENT or 2 NOTICE, simulated before signing. A plain transferFrom strands the position here for good,
// with no holder and no fees.

const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

const HYPEREVM = {
  positions: '0x6eDA206207c09e5428F281761DdC0D300851fBC8', // HyperSwap V3 positions (NonfungiblePositionManager)
  factory: '0xB1c0fa0B789320044A6F623cFe5eBda9562602E3',
  whype: '0x5555555555555555555555555555555555555555',
  rat: '0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA',
  pool: '0xD892FE85fa9ED0f20d5466e8dCcC2e1D871d9404', // RAT/WHYPE 0.30%
  fee: 3000,
};

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('No deployment account configured');
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 999) throw new Error(`RatPoolLock is for HyperEVM mainnet (999), not ${chainId}`);
  const c = HYPEREVM;
  const nfpm = new ethers.Contract(c.positions, ['function factory() view returns (address)', 'function WETH9() view returns (address)'], ethers.provider);
  if ((await nfpm.factory()) !== c.factory || (await nfpm.WETH9()) !== c.whype) throw new Error('the positions contract is not HyperSwap V3 on WHYPE');
  const factory = new ethers.Contract(c.factory, ['function getPool(address,address,uint24) view returns (address)'], ethers.provider);
  if ((await factory.getPool(c.whype, c.rat, c.fee)) !== c.pool) throw new Error('the RAT/WHYPE 0.30% pool is not where expected');
  const test = process.env.TEST === '1', suffix = test ? '-test' : '';
  const REAL = { delay: 14 * 86400, window: 7 * 86400 };
  const keys = ['POOL_LOCK_DELAY_SEC', 'POOL_LOCK_WINDOW_SEC'];
  if (!test && keys.some((k) => process.env[k])) throw new Error(`${keys.join(', ')} are for a TEST lock only (TEST=1)`);
  const num = (k, d) => { const v = Number(process.env[k] ?? d); if (!Number.isInteger(v) || v <= 0 || v > d) throw new Error(`${k} must be a whole number over 0, at most the real ${d}`); return v; };
  const set = { delay: num('POOL_LOCK_DELAY_SEC', REAL.delay), window: num('POOL_LOCK_WINDOW_SEC', REAL.window) };
  if (test !== (set.delay < REAL.delay || set.window < REAL.window)) throw new Error('TEST=1: shorten at least one duration of the lock');
  console.log(`${test ? 'TEST POOL LOCK: ' : ''}unlock delay ${set.delay} s, window ${set.window} s`);
  const L = await ethers.getContractFactory('RatPoolLock');
  const lock = await L.deploy(c.positions, c.whype, c.rat, c.fee, set.delay, set.window);
  const receipt = await (await lock.waitForDeployment()).deploymentTransaction().wait();
  const address = await lock.getAddress();
  if ((await lock.positionManager()) !== c.positions || (await lock.token0()) !== c.whype || (await lock.token1()) !== c.rat || (await lock.testMode()) !== test) throw new Error(`pool lock ${address} does not hold the expected settings`);
  const out = { network: network.name, chainId, address, deployBlock: receipt.blockNumber, positions: c.positions, pool: c.pool, token0: c.whype, token1: c.rat, fee: c.fee, settings: set, test };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `pool-lock-${network.name}${suffix}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`RatPoolLock at ${address} (block ${receipt.blockNumber}). Next: verify the source; lock positions with safeTransferFrom(owner, lock, id, abi.encode(uint8 mode)), 1 PERMANENT, 2 NOTICE.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { main, HYPEREVM };
