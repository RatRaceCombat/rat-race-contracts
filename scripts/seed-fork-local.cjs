// Prefund only an explicitly verified disposable HyperEVM fork.
const assert = require('node:assert/strict');
const { ethers, network } = require('hardhat');
const vaults = require('../deployments/localhost.json');
const distributor = require('../deployments/distributor-localhost.json');
const RAT_ADDRESS = '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca';
const SYSTEM = '0x20000000000000000000000000000000000000fd';
const RAT = (n) => ethers.parseUnits(String(n), 18);

async function main() {
  assert.equal(network.name, 'localhost');
  assert.equal((await ethers.provider.getNetwork()).chainId, 31337n);
  const metadata = await ethers.provider.send('hardhat_metadata', []);
  assert.equal(metadata.forkedNetwork?.chainId, 999);
  assert.equal(vaults.rat.token.address.toLowerCase(), RAT_ADDRESS);
  assert.equal(distributor.rat.address.toLowerCase(), RAT_ADDRESS);
  const rat = await ethers.getContractAt([
    'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)',
    'function approve(address,uint256) returns(bool)',
  ], RAT_ADDRESS);
  const wallets = (await ethers.getSigners()).slice(6, 9);
  assert.ok(await rat.balanceOf(SYSTEM) >= RAT(3000000), 'Fork RAT reserve is too small');
  await ethers.provider.send('hardhat_setBalance', [SYSTEM, ethers.toBeHex(ethers.parseEther('10'))]);
  await ethers.provider.send('hardhat_impersonateAccount', [SYSTEM]);
  try {
    const donor = rat.connect(await ethers.getSigner(SYSTEM));
    await (await donor.transfer(distributor.address, RAT(1000000))).wait();
    await (await donor.transfer(vaults.rat.address, RAT(500000))).wait();
    for (const wallet of wallets) await (await donor.transfer(wallet.address, RAT(500000))).wait();
  } finally {
    await ethers.provider.send('hardhat_stopImpersonatingAccount', [SYSTEM]);
  }
  const usdc = await ethers.getContractAt('MockUSDC', vaults.token.address);
  const ratVault = await ethers.getContractAt('RatRaceVault', vaults.rat.address);
  for (const [index, wallet] of wallets.entries()) {
    await (await usdc.mint(wallet.address, ethers.parseUnits('10000', 6))).wait();
    await (await rat.connect(wallet).approve(vaults.rat.address, RAT(250000))).wait();
    await (await ratVault.connect(wallet).deposit(250000)).wait();
    console.log(`Fork Wallet ${index + 1}: ${wallet.address}, 250000 RAT deposited in game, 250000 RAT + 10000 test USDC in wallet`);
  }
  console.log(`HyperEVM fork ready at upstream block ${metadata.forkedNetwork.forkBlockNumber}`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
