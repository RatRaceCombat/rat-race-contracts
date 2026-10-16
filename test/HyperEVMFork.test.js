const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const ADDRESS = '0xfdc42f844f3aa19f8fc0b2d67d3276cf1efdc4ca';
const SYSTEM = '0x20000000000000000000000000000000000000fd';
const RAT = (n) => ethers.parseUnits(String(n), 18);

(process.env.FORK_RPC_URL ? describe : describe.skip)('HyperEVM fork with the deployed RAT token', function () {
  this.timeout(120000);
  it('deposits, pays a signed withdrawal and burns real RAT bytecode', async () => {
    expect(network.name).to.equal('hardhat');
    expect((await ethers.provider.getNetwork()).chainId).to.equal(31337n);
    await network.provider.send('evm_mine', []); // (a local block first: Hardhat knows no hardfork history to run the forked block itself)
    expect(await ethers.provider.getCode(ADDRESS)).not.to.equal('0x');
    const [owner, signer, guardian, alice] = await ethers.getSigners();
    const rat = await ethers.getContractAt([
      'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)',
    ], ADDRESS);
    expect(await rat.symbol()).to.equal('RAT');
    expect(await rat.decimals()).to.equal(18n);
    expect(await rat.balanceOf(SYSTEM)).to.be.gte(RAT(100));
    // Impersonation changes only the disposable Hardhat fork.
    await network.provider.send('hardhat_setBalance', [SYSTEM, ethers.toBeHex(ethers.parseEther('10'))]);
    await network.provider.send('hardhat_impersonateAccount', [SYSTEM]);
    try {
      await rat.connect(await ethers.getSigner(SYSTEM)).transfer(alice.address, RAT(100));
    } finally {
      await network.provider.send('hardhat_stopImpersonatingAccount', [SYSTEM]);
    }
    const vault = await (await ethers.getContractFactory('RatRaceVault')).deploy({
      owner: owner.address, token: ADDRESS, signer: signer.address, cosigner: ethers.ZeroAddress,
      guardian: guardian.address, feeWallet: owner.address, gemPrice: RAT(1), depositFeeBps: 0,
      dailyLimitGems: 1000, globalDailyLimitGems: 1000, coSignThresholdGems: 0,
    });
    await rat.connect(alice).approve(await vault.getAddress(), RAT(100));
    await vault.connect(alice).deposit(100);
    expect(await rat.balanceOf(await vault.getAddress())).to.equal(RAT(100));
    const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
    const signature = await signer.signTypedData({ name: 'RatRaceVault', version: '1', chainId: 31337,
      verifyingContract: await vault.getAddress() }, { Withdraw: [
      { name: 'player', type: 'address' }, { name: 'gems', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    ] }, { player: alice.address, gems: 40, nonce: 1, deadline });
    await vault.connect(alice).withdraw(40, 1, deadline, signature, '0x');
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(40));
    const dead = '0x000000000000000000000000000000000000dEaD';
    const before = await rat.balanceOf(dead);
    await vault.burnTreasury(RAT(60));
    expect(await rat.balanceOf(dead)).to.equal(before + RAT(60));
    expect(await rat.balanceOf(await vault.getAddress())).to.equal(0n);
  });
});
