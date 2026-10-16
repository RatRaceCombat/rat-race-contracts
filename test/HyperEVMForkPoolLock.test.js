// RatPoolLock against the real HyperSwap V3 contracts on a fork of HyperEVM mainnet (the RAT/WHYPE 0.30% pool):
// a full-range position locked, fees made by real swaps and collected by its holder only, no way to take the
// liquidity out, a NOTICE position back after its 14 days, a position of another pool refused. Disposable fork only.
// FORK_RPC_URL=https://rpc.hyperliquid.xyz/evm npx hardhat --config hardhat.config.cjs test test/HyperEVMForkPoolLock.test.js
const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const RAT = '0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA';
const WHYPE = '0x5555555555555555555555555555555555555555';
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const NFPM = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';
const ROUTER = '0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D';
const LIQUIDITY_SAFE = '0x818a9EF264Eb1710031822D35ef84e5c81fF0DD5'; // (only as a source of RAT and USDC on the fork)
const TICK = 887220;
const DAY = 86400;
const modeData = (m) => ethers.AbiCoder.defaultAbiCoder().encode(['uint8'], [m]);

(process.env.FORK_RPC_URL ? describe : describe.skip)('RatPoolLock on a HyperEVM fork with the real HyperSwap', function () {
  this.timeout(300000);
  let lp, trader, stranger, nfpm, router, rat, whype, usdc, lock;
  const deadline = () => 2n ** 40n;
  const mintPos = async (who, token0, token1, a0, a1) => {
    await (await ethers.getContractAt(['function approve(address,uint256)'], token0)).connect(who).approve(NFPM, a0);
    await (await ethers.getContractAt(['function approve(address,uint256)'], token1)).connect(who).approve(NFPM, a1);
    await nfpm.connect(who).mint({ token0, token1, fee: 3000, tickLower: -TICK, tickUpper: TICK, amount0Desired: a0, amount1Desired: a1, amount0Min: 0, amount1Min: 0, recipient: who.address, deadline: deadline() });
    return nfpm.tokenOfOwnerByIndex(who.address, (await nfpm.balanceOf(who.address)) - 1n);
  };

  before(async () => {
    await network.provider.send('evm_mine', []); // (a local block first: Hardhat knows no hardfork history for chain 999)
    [lp, trader, stranger] = await ethers.getSigners();
    nfpm = await ethers.getContractAt([
      'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256,uint128,uint256,uint256)',
      'function balanceOf(address) view returns (uint256)', 'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)', 'function ownerOf(uint256) view returns (address)',
      'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128 liquidity,uint256,uint256,uint128,uint128)',
      'function safeTransferFrom(address,address,uint256,bytes)', 'function transferFrom(address,address,uint256)',
      'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256,uint256)',
    ], NFPM);
    router = await ethers.getContractAt(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'], ROUTER);
    const erc = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)', 'function deposit() payable'];
    rat = await ethers.getContractAt(erc, RAT);
    whype = await ethers.getContractAt(erc, WHYPE);
    usdc = await ethers.getContractAt(erc, USDC);
    // fork-only funding: RAT and USDC from the Liquidity Safe's balance, HYPE set by Hardhat
    await network.provider.send('hardhat_impersonateAccount', [LIQUIDITY_SAFE]);
    await network.provider.send('hardhat_setBalance', [LIQUIDITY_SAFE, ethers.toBeHex(ethers.parseEther('1'))]);
    const safe = await ethers.getSigner(LIQUIDITY_SAFE);
    for (const w of [lp, trader]) {
      await network.provider.send('hardhat_setBalance', [w.address, ethers.toBeHex(ethers.parseEther('100'))]);
      await rat.connect(safe).transfer(w.address, ethers.parseUnits('60000', 18));
      await whype.connect(w).deposit({ value: ethers.parseEther('10') });
    }
    await usdc.connect(safe).transfer(lp.address, 20n * 10n ** 6n);
    lock = await (await ethers.getContractFactory('RatPoolLock')).deploy(NFPM, WHYPE, RAT, 3000, 14 * DAY, 7 * DAY);
    expect(await lock.testMode()).to.equal(false);
  });

  it('locks a real full-range position for good; only its holder collects the fees of real swaps', async () => {
    const id = await mintPos(lp, WHYPE, RAT, ethers.parseEther('2'), ethers.parseUnits('40000', 18));
    const liq = (await nfpm.positions(id)).liquidity;
    await expect(nfpm.connect(lp).safeTransferFrom(lp.address, lock.target, id, modeData(1))).to.emit(lock, 'Locked').withArgs(id, lp.address, liq, 1);
    expect(await nfpm.ownerOf(id)).to.equal(lock.target);
    // real swaps through the pool, both ways: the position earns its share of the 0.30%
    await whype.connect(trader).approve(ROUTER, ethers.MaxUint256);
    await rat.connect(trader).approve(ROUTER, ethers.MaxUint256);
    for (let i = 0; i < 3; i++) {
      await router.connect(trader).exactInputSingle({ tokenIn: WHYPE, tokenOut: RAT, fee: 3000, recipient: trader.address, deadline: deadline(), amountIn: ethers.parseEther('1'), amountOutMinimum: 0, sqrtPriceLimitX96: 0 });
      await router.connect(trader).exactInputSingle({ tokenIn: RAT, tokenOut: WHYPE, fee: 3000, recipient: trader.address, deadline: deadline(), amountIn: ethers.parseUnits('15000', 18), amountOutMinimum: 0, sqrtPriceLimitX96: 0 });
    }
    await expect(lock.connect(stranger).collectFees(id)).to.be.revertedWithCustomError(lock, 'NotHolder');
    const [w0, r0] = [await whype.balanceOf(lp.address), await rat.balanceOf(lp.address)];
    await lock.connect(lp).collectFees(id);
    const [w1, r1] = [await whype.balanceOf(lp.address), await rat.balanceOf(lp.address)];
    expect(w1).to.be.gt(w0);
    expect(r1).to.be.gt(r0);
    // the liquidity is where it was, and nothing takes it out, not even its holder
    expect((await nfpm.positions(id)).liquidity).to.equal(liq);
    await expect(nfpm.connect(lp).decreaseLiquidity({ tokenId: id, liquidity: liq, amount0Min: 0, amount1Min: 0, deadline: deadline() })).to.be.reverted;
    await expect(nfpm.connect(lp).transferFrom(lock.target, lp.address, id)).to.be.reverted;
    await expect(lock.connect(lp).announceUnlock(id)).to.be.revertedWithCustomError(lock, 'Permanent');
  });

  it('a NOTICE position comes back to its holder after the announced 14 days', async () => {
    const id = await mintPos(lp, WHYPE, RAT, ethers.parseEther('0.5'), ethers.parseUnits('10000', 18));
    await nfpm.connect(lp).safeTransferFrom(lp.address, lock.target, id, modeData(2));
    await lock.connect(lp).announceUnlock(id);
    await expect(lock.connect(lp).unlock(id)).to.be.revertedWithCustomError(lock, 'TooSoon');
    await network.provider.send('evm_increaseTime', [14 * DAY + 60]);
    await network.provider.send('evm_mine', []);
    await lock.connect(lp).unlock(id);
    expect(await nfpm.ownerOf(id)).to.equal(lp.address);
  });

  it('refuses a position of another pool (USDC/WHYPE)', async () => {
    const id = await mintPos(lp, WHYPE, USDC, ethers.parseEther('0.2'), 10n * 10n ** 6n); // (token0 is the lower address: WHYPE)
    await expect(nfpm.connect(lp).safeTransferFrom(lp.address, lock.target, id, modeData(1))).to.be.revertedWithCustomError(lock, 'WrongPool');
    expect(await nfpm.ownerOf(id)).to.equal(lp.address);
  });
});
