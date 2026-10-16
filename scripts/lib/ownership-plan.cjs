const { ethers } = require('ethers');
const { inspectOwner } = require('./owner.cjs');
const ownershipAbi = [
  'function owner() view returns(address)',
  'function pendingOwner() view returns(address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
];

async function buildOwnershipPlan(provider, contracts, targetAddress, targetKind, expectedChainId) {
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== Number(expectedChainId)) throw new Error('Ownership plan chain does not match deployments');
  const target = await inspectOwner(provider, targetAddress, targetKind);
  const addresses = contracts.map(({ address }) => ethers.getAddress(address));
  if (!addresses.length || new Set(addresses).size !== addresses.length) throw new Error('Select distinct deployed contracts');
  const states = [];
  const proposals = [];
  const acceptances = [];
  for (let i = 0; i < contracts.length; i++) {
    const { name } = contracts[i];
    const address = addresses[i];
    if (await provider.getCode(address) === '0x') throw new Error(`${name} is not deployed on this chain`);
    const contract = new ethers.Contract(address, ownershipAbi, provider);
    const owner = await contract.owner();
    const pendingOwner = await contract.pendingOwner();
    if (owner === ethers.ZeroAddress) throw new Error(`${name} ownership has been renounced`);
    const status = owner === target.address ? 'complete' : pendingOwner === target.address ? 'awaiting-acceptance' : 'needs-proposal';
    states.push({ name, address, owner, pendingOwner, status });
    if (status === 'needs-proposal') proposals.push({ name, from: owner, to: address, value: '0',
      chainId: ethers.toQuantity(chainId), data: contract.interface.encodeFunctionData('transferOwnership', [target.address]) });
    if (status !== 'complete') acceptances.push({ name, from: target.address, to: address, value: '0',
      chainId: ethers.toQuantity(chainId), data: contract.interface.encodeFunctionData('acceptOwnership'),
      ready: status === 'awaiting-acceptance' });
  }
  const createdAt = Date.now();
  const safeImport = target.kind === 'safe' ? { version: '1.0', chainId: String(chainId), createdAt,
    meta: { name: 'Rat Race Combat: accept contract ownership',
      description: 'Execute after every transferOwnership proposal has confirmed.', createdFromSafeAddress: target.address },
    transactions: acceptances.map(({ to, value, data }) => ({ to, value, data, contractMethod: null, contractInputsValues: null })) } : null;
  return { version: 1, chainId, createdAt, target, states, proposals, acceptances, safeImport, transactionsSent: 0 };
}

module.exports = { buildOwnershipPlan };
