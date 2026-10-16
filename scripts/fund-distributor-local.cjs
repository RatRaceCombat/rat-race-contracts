// Local chain only: mint 1M test RAT into the local distributor (tools/dist_e2e.mjs)
const hre = require('hardhat');
const d = require('../deployments/distributor-localhost.json');
(async () => {
  const rat = await hre.ethers.getContractAt('MockRAT', d.rat.address);
  await (await rat.mint(d.address, hre.ethers.parseUnits('1000000', 18))).wait();
  console.log('reserve', hre.ethers.formatUnits(await rat.balanceOf(d.address), 18));
})();
