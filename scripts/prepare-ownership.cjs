// Exports transactions for the hardware wallet and the future Safe. Read-only.
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');
const { buildOwnershipPlan } = require('./lib/ownership-plan.cjs');

async function main() {
  const dir = path.join(__dirname, '../deployments');
  const read = (file) => {
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) throw new Error(`Missing ${file}: deploy the game contracts first`);
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (data.network !== network.name) throw new Error(`Wrong network in ${file}`);
    return data;
  };
  const vaults = read(`${network.name}.json`);
  const distributor = read(`distributor-${network.name}.json`);
  const skins = read(`skins-${network.name}.json`);
  if (new Set([vaults.chainId, distributor.chainId, skins.chainId]).size !== 1) throw new Error('Deployment chain IDs differ');
  const address = process.env.OWNERSHIP_TARGET_ADDRESS || process.env.OWNER_ADDRESS;
  const kind = process.env.OWNERSHIP_TARGET_KIND || process.env.OWNER_KIND;
  if (!address || !kind) throw new Error('Set OWNERSHIP_TARGET_ADDRESS/KIND or OWNER_ADDRESS/KIND');
  const plan = await buildOwnershipPlan(ethers.provider, [
    { name: 'USDC vault', address: vaults.address }, { name: 'RAT vault', address: vaults.rat.address },
    { name: 'RAT distributor', address: distributor.address }, { name: 'NFT skins', address: skins.address },
  ], address, kind, vaults.chainId);
  const file = path.join(dir, `ownership-${network.name}.plan.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');
  if (plan.safeImport) fs.writeFileSync(path.join(dir, `ownership-${network.name}.safe-accept.json`), JSON.stringify(plan.safeImport, null, 2) + '\n');
  console.log(JSON.stringify({ chainId: plan.chainId, target: plan.target, states: plan.states,
    proposalCount: plan.proposals.length, acceptanceCount: plan.acceptances.length,
    file, transactionsSent: 0 }, null, 2));
}
main().catch((error) => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
