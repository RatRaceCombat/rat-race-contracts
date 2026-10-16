// Read-only mainnet verification and deterministic Safe 2/3 deployment preparation.
// Uses the official Safe deployment registry; no private keys or transactions.
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const root = path.resolve(__dirname, '..');
const registry = 'https://raw.githubusercontent.com/safe-global/safe-deployments/main/src/assets/v1.4.1/';

async function main() {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'deployments/wallets-hyperevm.json'), 'utf8'));
  if (inventory.safe.source === 'user-existing-safe') throw new Error('Use the user\'s existing Safe; creating a replacement plan is disabled');
  const provider = new ethers.JsonRpcProvider('https://rpc.hyperliquid.xyz/evm', undefined, { batchMaxCount: 1 });
  if ((await provider.getNetwork()).chainId !== 999n) throw new Error('Expected HyperEVM mainnet (999)');
  const contracts = {};
  for (const [role, name] of Object.entries({ singleton: 'safe_l2', factory: 'safe_proxy_factory', fallbackHandler: 'compatibility_fallback_handler' })) {
    const source = registry + name + '.json';
    const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Cannot read official Safe registry for ${role}`);
    const asset = await response.json();
    const deploymentName = asset.networkAddresses['999'];
    if (typeof deploymentName !== 'string') throw new Error(`Ambiguous Safe deployment for ${role}`);
    const deployment = asset.deployments[deploymentName];
    const bytecode = await provider.getCode(deployment.address);
    if (bytecode === '0x' || ethers.keccak256(bytecode) !== deployment.codeHash) throw new Error(`Safe registry bytecode mismatch: ${role}`);
    contracts[role] = { address: ethers.getAddress(deployment.address), codeHash: deployment.codeHash, source };
  }
  const owners = inventory.safe.owners.map(ethers.getAddress);
  if (owners.length !== 3 || new Set(owners).size !== 3 || inventory.safe.threshold !== 2) throw new Error('Expected three distinct Safe owners and threshold 2');
  const safeAbi = new ethers.Interface(['function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)']);
  const initializer = safeAbi.encodeFunctionData('setup', [owners, 2, ethers.ZeroAddress, '0x',
    contracts.fallbackHandler.address, ethers.ZeroAddress, 0, ethers.ZeroAddress]);
  const factory = new ethers.Contract(contracts.factory.address, [
    'function proxyCreationCode() view returns (bytes)',
    'function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns (address proxy)',
  ], provider);
  const saltNonce = BigInt(ethers.id('RRC-HyperEVM-owner-' + inventory.createdAt));
  const deploymentCode = ethers.concat([await factory.proxyCreationCode(), ethers.zeroPadValue(contracts.singleton.address, 32)]);
  const salt = ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [ethers.keccak256(initializer), saltNonce]));
  const address = ethers.getCreate2Address(contracts.factory.address, salt, ethers.keccak256(deploymentCode));
  if (await provider.getCode(address) !== '0x') throw new Error('Predicted Safe already deployed; inspect it before updating the plan');
  const plan = { chainId: 999, version: '1.4.1', verifiedAt: new Date().toISOString(),
    status: 'not-deployed', address, owners, threshold: 2, saltNonce: saltNonce.toString(), initializer,
    contracts, transaction: { to: contracts.factory.address, value: '0',
      data: factory.interface.encodeFunctionData('createProxyWithNonce', [contracts.singleton.address, initializer, saltNonce]) } };
  fs.writeFileSync(path.join(root, 'deployments/safe-hyperevm.plan.json'), JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify({ address, owners, threshold: 2, contracts,
    status: 'not-deployed', transactionsSent: 0 }, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
