// Read-only deployment checks. Never prints private keys or sends a transaction.
const { ethers, network } = require('hardhat');
const { deploymentOwner } = require('./lib/owner.cjs');

async function main() {
  const chain = await ethers.provider.getNetwork();
  const expected = { hyperevmTestnet: 998n, hyperevm: 999n, localhost: 31337n, hardhat: 31337n }[network.name];
  if (!expected || chain.chainId !== expected) throw new Error('Unexpected deployment chain');
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('No deployment account configured');
  const balance = await ethers.provider.getBalance(deployer.address);
  const roles = {};
  const missing = [];
  for (const name of ['OWNER_ADDRESS', 'SIGNER_ADDRESS', 'DISTRIBUTOR_SIGNER_ADDRESS', 'COSIGNER_ADDRESS', 'GUARDIAN_ADDRESS', 'TEAM_ADDRESS', 'BUYBACK_ADDRESS', 'MINTER_ADDRESS']) {
    if (process.env[name]) roles[name] = ethers.getAddress(process.env[name]);
    else missing.push(name);
  }
  const ownerContractDeployed = !!roles.OWNER_ADDRESS && await ethers.provider.getCode(roles.OWNER_ADDRESS) !== '0x';
  const administration = missing.includes('OWNER_ADDRESS') ? null
    : await deploymentOwner(ethers.provider, network.name, deployer.address);
  console.log(JSON.stringify({ network: network.name, chainId: Number(chain.chainId), deployer: deployer.address,
    gasBalance: ethers.formatEther(balance), roles, missing, ownerContractDeployed, administration }, null, 2));
  if (balance === 0n) throw new Error('Deployer has no gas funds');
  if (missing.length) throw new Error(`Missing public roles: ${missing.join(', ')}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
