// A live test of a TEST RatPoolLock on HyperEVM: the whole life of a NOTICE
// position with real tokens, at a tiny scale, before the real lock takes the pool's liquidity.
//   1. a tiny full-range RAT/WHYPE position minted on HyperSwap (a little HYPE wrapped, a little RAT);
//   2. locked in the TEST lock with safeTransferFrom and its mode (2, NOTICE): its holder is the sender;
//   3. its fees collected by the holder (zero is fine: the call itself is the test);
//   4. its unlock announced, the TEST delay waited, the position back to the holder;
//   5. the position emptied and its tokens back (decreaseLiquidity + collect), then burned.
// Every write is simulated (staticCall) before it is sent. Without LIVE=1 it only reads and prints the plan.
//
//   npx hardhat --config hardhat.config.cjs run scripts/pool-lock-live-test.cjs --network hyperevm
//   LIVE=1 npx hardhat --config hardhat.config.cjs run scripts/pool-lock-live-test.cjs --network hyperevm
//
// Needs deployments/pool-lock-hyperevm-test.json (TEST=1 scripts/deploy-pool-lock.cjs) and, on the deployer wallet,
// the HYPE of LIVE_HYPE (0.01 by default) plus gas, and the RAT of LIVE_RAT (100 by default).
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');

const C = {
  positions: '0x6eDA206207c09e5428F281761DdC0D300851fBC8',
  whype: '0x5555555555555555555555555555555555555555',
  rat: '0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA',
  fee: 3000,
};
const NFPM = [
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)',
  'function burn(uint256) payable',
  'function ownerOf(uint256) view returns (address)',
  'function safeTransferFrom(address,address,uint256,bytes)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function deposit() payable'];
const LOCK = [
  'function holder(uint256) view returns (address)', 'function mode(uint256) view returns (uint8)', 'function testMode() view returns (bool)',
  'function UNLOCK_DELAY() view returns (uint64)', 'function UNLOCK_WINDOW() view returns (uint64)', 'function unlockReadyAt(uint256) view returns (uint64)',
  'function collectFees(uint256) returns (uint256,uint256)', 'function announceUnlock(uint256)', 'function unlock(uint256)',
];
const MIN_TICK = -887220, MAX_TICK = 887220; // (full range, a multiple of the 0.30% pool's tick spacing, 60)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const live = process.env.LIVE === '1';
  const manifest = path.join(__dirname, '..', 'deployments', `pool-lock-${network.name}-test.json`);
  if (!fs.existsSync(manifest)) throw new Error(`no TEST lock: TEST=1 npx hardhat --config hardhat.config.cjs run scripts/deploy-pool-lock.cjs --network ${network.name}`);
  const { address: lockAddress } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const [me] = await ethers.getSigners();
  const lock = new ethers.Contract(lockAddress, LOCK, me);
  const nfpm = new ethers.Contract(C.positions, NFPM, me);
  const whype = new ethers.Contract(C.whype, ERC20, me), rat = new ethers.Contract(C.rat, ERC20, me);
  if (!(await lock.testMode())) throw new Error('this lock is not a TEST lock: the live test runs on a TEST lock only');
  const hypeIn = ethers.parseEther(process.env.LIVE_HYPE || '0.01'), ratIn = ethers.parseEther(process.env.LIVE_RAT || '100');
  const [hype, ratBal, delay, window] = await Promise.all([ethers.provider.getBalance(me.address), rat.balanceOf(me.address), lock.UNLOCK_DELAY(), lock.UNLOCK_WINDOW()]);
  console.log(`wallet ${me.address}: ${ethers.formatEther(hype)} HYPE, ${ethers.formatEther(ratBal)} RAT; TEST lock ${lockAddress}: delay ${delay} s, window ${window} s`);
  // (the whole test, 11 transactions, burned 0.00034 HYPE of gas on 2026-10-15: LIVE_GAS_HYPE keeps 0.005 by default)
  const gasIn = ethers.parseEther(process.env.LIVE_GAS_HYPE || '0.005');
  if (hype < hypeIn + gasIn) throw new Error(`not enough HYPE: ${ethers.formatEther(hypeIn)} for the position plus ${ethers.formatEther(gasIn)} of gas`);
  if (ratBal < ratIn) throw new Error(`not enough RAT: ${ethers.formatEther(ratIn)} needed`);
  if (!live) return console.log(`plan: wrap ${ethers.formatEther(hypeIn)} HYPE, mint a full-range position with up to ${ethers.formatEther(ratIn)} RAT, lock it (NOTICE), collect its fees, announce, wait ${delay} s, unlock, empty and burn it. LIVE=1 runs it.`);

  const send = async (label, contract, fn, args = [], overrides = {}) => {
    await contract[fn].staticCall(...args, overrides); // (simulated first: a revert stops here, nothing sent)
    const tx = await contract[fn](...args, overrides);
    const r = await tx.wait();
    console.log(`  ${label}: ${tx.hash} (block ${r.blockNumber})`);
    return r;
  };
  const deadline = () => Math.floor(Date.now() / 1000) + 600;
  // 1. a tiny full-range position (a rerun keeps the WHYPE an earlier run wrapped)
  const wrapped = await whype.balanceOf(me.address);
  if (wrapped < hypeIn) await send('wrap HYPE', whype, 'deposit', [], { value: hypeIn - wrapped });
  if ((await whype.allowance(me.address, C.positions)) < hypeIn) await send('approve WHYPE', whype, 'approve', [C.positions, hypeIn]);
  if ((await rat.allowance(me.address, C.positions)) < ratIn) await send('approve RAT', rat, 'approve', [C.positions, ratIn]);
  // (read again: another script on the same wallet may have spent RAT since the start, and the mint would say STF)
  if ((await rat.balanceOf(me.address)) < ratIn) throw new Error(`the wallet's RAT fell under ${ethers.formatEther(ratIn)} since the start: another run on this wallet?`);
  const params = { token0: C.whype, token1: C.rat, fee: C.fee, tickLower: MIN_TICK, tickUpper: MAX_TICK, amount0Desired: hypeIn, amount1Desired: ratIn, amount0Min: 0, amount1Min: 0, recipient: me.address, deadline: deadline() };
  const minted = await send('mint the position', nfpm, 'mint', [params]);
  const ev = minted.logs.map((l) => { try { return nfpm.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'IncreaseLiquidity');
  const id = ev.args.tokenId;
  console.log(`  position #${id}: liquidity ${ev.args.liquidity}, ${ethers.formatEther(ev.args.amount0)} WHYPE, ${ethers.formatEther(ev.args.amount1)} RAT`);
  // 2. locked with its mode (NOTICE): the sender is its holder
  await send('lock it (NOTICE)', nfpm, 'safeTransferFrom', [me.address, lockAddress, id, ethers.AbiCoder.defaultAbiCoder().encode(['uint8'], [2])]);
  const [holder, mode, owner] = await Promise.all([lock.holder(id), lock.mode(id), nfpm.ownerOf(id)]);
  if (holder !== me.address || Number(mode) !== 2 || owner !== lockAddress) throw new Error(`lock state wrong: holder ${holder}, mode ${mode}, owner ${owner}`);
  console.log('  locked: the lock owns it, the wallet is its holder, NOTICE');
  // 3. the fees, to the holder
  await send('collect its fees', lock, 'collectFees', [id]);
  // 4. the announced unlock, after the TEST delay
  await send('announce the unlock', lock, 'announceUnlock', [id]);
  const readyAt = Number(await lock.unlockReadyAt(id));
  for (;;) {
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    if (now >= readyAt) break;
    console.log(`  waiting ${readyAt - now} s for the TEST delay`);
    await sleep(Math.min(30, readyAt - now + 2) * 1000);
  }
  await send('unlock', lock, 'unlock', [id]);
  if ((await nfpm.ownerOf(id)) !== me.address) throw new Error('the position did not come back');
  console.log('  back: the wallet owns the position again');
  // 5. emptied, its tokens back, burned
  const liquidity = (await nfpm.positions(id))[7];
  await send('remove its liquidity', nfpm, 'decreaseLiquidity', [{ tokenId: id, liquidity, amount0Min: 0, amount1Min: 0, deadline: deadline() }]);
  const max = (1n << 128n) - 1n;
  await send('collect its tokens', nfpm, 'collect', [{ tokenId: id, recipient: me.address, amount0Max: max, amount1Max: max }]);
  await send('burn it', nfpm, 'burn', [id]);
  console.log('live test passed: locked, fees collected by its holder, unlocked after the announced delay, emptied and burned');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
