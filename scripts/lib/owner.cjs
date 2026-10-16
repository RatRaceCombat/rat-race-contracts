const { ethers } = require('ethers');

async function inspectOwner(provider, address, kind) {
  address = ethers.getAddress(address);
  if (address === ethers.ZeroAddress) throw new Error('Owner cannot be the zero address');
  if (!['trezor', 'safe', 'address'].includes(kind)) throw new Error('OWNER_KIND must be trezor or safe');
  const deployed = await provider.getCode(address) !== '0x';
  const result = { address, kind, contractDeployed: deployed };
  if (kind === 'trezor' && deployed) throw new Error('Trezor owner must be its EVM signer address, not a contract');
  if (kind === 'safe') {
    if (!deployed) throw new Error('Target Safe is not deployed on this chain');
    const safe = new ethers.Contract(address, ['function getThreshold() view returns(uint256)', 'function getOwners() view returns(address[])'], provider);
    result.threshold = Number(await safe.getThreshold());
    result.owners = Array.from(await safe.getOwners()).map(ethers.getAddress);
    // at least two signatures
    if (result.threshold < 2 || result.owners.length < result.threshold || new Set(result.owners).size !== result.owners.length) {
      throw new Error('The project Safe must need at least two signatures from distinct owners');
    }
  }
  return result;
}

async function deploymentOwner(provider, networkName, deployerAddress, env = process.env) {
  const local = ['hardhat', 'localhost'].includes(networkName);
  const address = env.OWNER_ADDRESS || (local ? deployerAddress : '');
  if (!address) throw new Error(`OWNER_ADDRESS is required on ${networkName}`);
  const kind = env.OWNER_KIND || (networkName === 'hyperevm' ? '' : 'address');
  if (networkName === 'hyperevm' && !['trezor', 'safe'].includes(kind)) throw new Error('Mainnet OWNER_KIND must be trezor or safe');
  return inspectOwner(provider, address, kind);
}

module.exports = { inspectOwner, deploymentOwner };
