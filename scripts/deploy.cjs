// Deploys the two RatRaceVault instances and writes deployments/<network>.json for the server:
//   - USDC vault: USDC <-> rGems (1 USDC = 10 rGems by default)
//   - RAT vault:  RAT rewards claims, RAT deposits for suits, burn of spent RAT
//
// Env (contracts/.env):
//   DEPLOYER_PRIVATE_KEY   required on public networks
//   USDC_ADDRESS           USDC on HyperEVM (a MockUSDC is deployed when unset, never on mainnet);
//                          on Arc the native USDC ERC-20 interface (0x3600...) is used by default
//   RAT_ADDRESS            RAT on HyperEVM (default 0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca;
//                          a MockRAT is deployed locally)
//   SIGNER_ADDRESS         backend voucher key (HSM/KMS)         — local: hardhat #1
//   COSIGNER_ADDRESS       independent risk/approval key        — local: hardhat #2
//   GUARDIAN_ADDRESS       circuit breaker (can only pause)     — local: hardhat #3
//   OWNER_ADDRESS          initial admin, assigned directly in the constructors
//   OWNER_KIND             trezor initially, or an already deployed 2-of-2 Safe
//                          Ownable2Step supports a later transfer to the Safe
//   FEE_WALLET             defaults to the deployer
//   GEM_PRICE_UNITS        USDC units per rGem (default 100000 = $0.10)
//   DEPOSIT_FEE_BPS        default 300 (3%)
//   USDC limits (rGems):   DAILY_LIMIT_GEMS (5000 = $500/player/day), GLOBAL_DAILY_LIMIT_GEMS
//                          (20000 = $2,000/day all players), COSIGN_THRESHOLD_GEMS (1000 = $100)
//   RAT limits (RAT):      RAT_DAILY_LIMIT (100000), RAT_GLOBAL_DAILY_LIMIT (2000000),
//                          RAT_COSIGN_THRESHOLD (50000)

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
  const local = network.name === 'localhost' || network.name === 'hardhat';
  if (!local) throw new Error('V2 vault deployment is disabled for this V1 release. Use deploy:distributor:mainnet and deploy:skins:mainnet, or the V1 wallet console.');
  const mainnet = network.name === 'hyperevm';
  const administration = await deploymentOwner(ethers.provider, network.name, deployer.address);
  const need = (k, localIdx) => {
    const v = env(k, local ? signers[localIdx].address : null);
    if (!v) throw new Error(`${k} is required on ${network.name}`);
    return v;
  };
  const signer = need('SIGNER_ADDRESS', 1);
  const cosigner = need('COSIGNER_ADDRESS', 2);
  const guardian = need('GUARDIAN_ADDRESS', 3);
  const feeWallet = env('FEE_WALLET', deployer.address);

  async function token(kind) {
    const arc = network.name.startsWith('arc');
    // RAT only exists on HyperEVM mainnet: a mock "test RAT" everywhere else
    const addr = kind === 'USDC'
      ? env('USDC_ADDRESS', arc ? '0x3600000000000000000000000000000000000000' : undefined)
      : env('RAT_ADDRESS', mainnet ? '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca' : undefined);
    if (addr) return { address: addr, mock: false };
    if (mainnet) throw new Error(`${kind}_ADDRESS is required on mainnet`);
    const Mock = await ethers.getContractFactory(kind === 'USDC' ? 'MockUSDC' : 'MockRAT');
    const t = await Mock.deploy();
    await t.waitForDeployment();
    console.log(`Mock${kind} deployed at ${await t.getAddress()}`);
    return { address: await t.getAddress(), mock: true };
  }

  async function deployVault(kind, t, p) {
    const erc20 = await ethers.getContractAt(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'], t.address);
    const [symbol, decimals] = [await erc20.symbol(), Number(await erc20.decimals())];
    const Vault = await ethers.getContractFactory('RatRaceVault');
    const cfg = {
      owner: administration.address, // Trezor initially; transferable later with Ownable2Step
      token: t.address,
      signer,
      cosigner,
      guardian,
      feeWallet,
      gemPrice: p.gemPrice(decimals),
      depositFeeBps: p.feeBps,
      dailyLimitGems: p.daily,
      globalDailyLimitGems: p.global,
      coSignThresholdGems: p.cosign,
    };
    const vault = await Vault.deploy(cfg);
    await vault.waitForDeployment();
    const address = await vault.getAddress();
    const receipt = await vault.deploymentTransaction().wait();
    // local dev: seed liquidity (USDC) / the RAT rewards pool
    if (t.mock && p.seed) {
      const seed = BigInt(p.seed) * 10n ** BigInt(decimals);
      const tok = await ethers.getContractAt(['function approve(address,uint256) returns (bool)', 'function mint(address,uint256)'], t.address);
      await (await tok.mint(deployer.address, seed)).wait();
      await (await tok.approve(address, seed)).wait();
      await (await vault.fund(seed)).wait();
    }
    console.log(`${kind} vault deployed at ${address}`);
    return {
      address,
      deployBlock: receipt.blockNumber,
      owner: await vault.owner(),
      pendingOwner: await vault.pendingOwner(),
      ownerKind: administration.kind,
      token: { address: t.address, symbol, decimals, mock: t.mock },
      gemPriceUnits: cfg.gemPrice.toString(),
      depositFeeBps: p.feeBps,
      dailyLimitGems: p.daily.toString(),
      globalDailyLimitGems: p.global.toString(),
      coSignThresholdGems: p.cosign.toString(),
    };
  }

  const usdc = await deployVault('USDC', await token('USDC'), {
    gemPrice: (d) => BigInt(env('GEM_PRICE_UNITS', (10n ** BigInt(d) / 10n).toString())),
    feeBps: Number(env('DEPOSIT_FEE_BPS', 300)),
    daily: BigInt(env('DAILY_LIMIT_GEMS', 5000)),
    global: BigInt(env('GLOBAL_DAILY_LIMIT_GEMS', 20000)),
    cosign: BigInt(env('COSIGN_THRESHOLD_GEMS', 1000)),
    seed: 5000,
  });
  const rat = await deployVault('RAT', await token('RAT'), {
    gemPrice: (d) => 10n ** BigInt(d), // 1 in-game unit = 1 RAT
    feeBps: 0,
    daily: BigInt(env('RAT_DAILY_LIMIT', 100000)),
    global: BigInt(env('RAT_GLOBAL_DAILY_LIMIT', 2000000)),
    cosign: BigInt(env('RAT_COSIGN_THRESHOLD', 50000)),
    seed: 1000000,
  });

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    signer,
    cosigner,
    guardian,
    feeWallet,
    // USDC vault (kept at the top level for older readers)
    ...usdc,
    rat,
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log('Deployment written:', JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
