// The second live test of a TEST RatPoolLock on HyperEVM: everything the first
// one (pool-lock-live-test.cjs: a NOTICE position locked, its fees, its announced unlock, back) did not cover, at a
// tiny scale (about 4 RAT and 0.0005 WHYPE; the 3 RAT of the two positions that end PERMANENT stay locked for good):
//   - every refusal, simulated (staticCall: nothing sent, nothing spent): a position without a mode or with a wrong
//     one, a call that is not from the positions contract, a stranger's calls, an unlock not announced, too soon or
//     lapsed, an offer not made to the caller, a position without liquidity, a PERMANENT position's way out;
//   - an announced unlock cancelled; a holder offer withdrawn, then made again to another wallet, which accepts it,
//     collects the fees and hands the position back the same way;
//   - real fees: a 1 RAT swap through the pool, then collectFees pays the holder more than zero;
//   - an announced unlock ready (simulated), then lapsed after its window;
//   - a NOTICE position made PERMANENT, and a position locked PERMANENT from the start: no way out for either;
//   - a position emptied of its liquidity refused, then burned.
// The other wallet is a throwaway made by the script: its key in a file outside the repo (only its path printed), a
// little HYPE for its gas, sent back at the end. Every write is simulated before it is sent.
//
//   npx hardhat --config hardhat.config.cjs run scripts/pool-lock-live-test-2.cjs --network hyperevm           (reads, plan)
//   LIVE=1 npx hardhat --config hardhat.config.cjs run scripts/pool-lock-live-test-2.cjs --network hyperevm    (for real)
//   FORK_RPC_URL=https://rpc.hyperliquid.xyz/evm npx hardhat --config hardhat.config.cjs run scripts/pool-lock-live-test-2.cjs
//     (on a disposable fork: it deploys its own TEST lock, funds itself and moves time instead of waiting)
//
// Needs deployments/pool-lock-hyperevm-test.json (TEST=1 scripts/deploy-pool-lock.cjs) and, on the deployer wallet,
// 5 RAT and 0.002 HYPE (LIVE_GAS_HYPE) besides 0.0005 WHYPE or HYPE to wrap.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers, network } = require('hardhat');

const C = {
  positions: '0x6eDA206207c09e5428F281761DdC0D300851fBC8',
  router: '0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D', // (HyperSwap V3 SwapRouter, v1 exactInputSingle)
  whype: '0x5555555555555555555555555555555555555555',
  rat: '0xFdC42f844f3aa19F8Fc0b2d67d3276cf1eFdC4CA',
  fee: 3000,
  liquiditySafe: '0x818a9EF264Eb1710031822D35ef84e5c81fF0DD5', // (on a fork only: the RAT this test spends comes from it)
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
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function deposit() payable', 'function transfer(address,uint256) returns (bool)'];
const ROUTER = ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'];
const MIN_TICK = -887220, MAX_TICK = 887220; // (full range, a multiple of the 0.30% pool's tick spacing, 60)
const NOTICE = 2, PERMANENT = 1;
const modeData = (m) => ethers.AbiCoder.defaultAbiCoder().encode(['uint8'], [m]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the free RPCs' passing failures (2026-10-15: the public one's lagging node, Hypurrscan's 502, dRPC's internal error)
const transient = (e) => /invalid block height|bad gateway|\b50[234]\b|temporary|timed? ?out|econnreset|socket hang up|missing response|rate limit|\b429\b|internal error/i.test(`${e?.shortMessage || ''} ${e?.message || ''}`);
const READS = new Set(['eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_chainId', 'eth_getCode', 'eth_getLogs']);
const eq = (a, b) => a.toLowerCase() === b.toLowerCase();
const check = (ok, what) => { if (!ok) throw new Error(`wrong state: ${what}`); console.log(`  ok: ${what}`); };

async function main() {
  const fork = network.name === 'hardhat';
  // a read the RPC fails in passing is asked again (never a transaction: send() below checks the nonce first)
  const hh = network.provider, hhSend = hh.send.bind(hh);
  hh.send = async (method, params) => {
    for (let i = 1; ; i++) {
      try { return await hhSend(method, params); } catch (e) {
        if (i >= 4 || !READS.has(method) || !transient(e)) throw e;
        await sleep(2000 * i);
      }
    }
  };
  const live = process.env.LIVE === '1' || fork;
  const [me] = await ethers.getSigners();
  const nfpm = new ethers.Contract(C.positions, NFPM, me), router = new ethers.Contract(C.router, ROUTER, me);
  const whype = new ethers.Contract(C.whype, ERC20, me), rat = new ethers.Contract(C.rat, ERC20, me);

  let lock;
  if (fork) {
    // a disposable fork: a local block first (Hardhat knows no hardfork history for chain 999), its own TEST lock, RAT
    // from the Liquidity Safe's balance, HYPE set by Hardhat
    await network.provider.send('evm_mine', []);
    await network.provider.send('hardhat_setBalance', [me.address, ethers.toBeHex(ethers.parseEther('1'))]);
    await network.provider.send('hardhat_impersonateAccount', [C.liquiditySafe]);
    await network.provider.send('hardhat_setBalance', [C.liquiditySafe, ethers.toBeHex(ethers.parseEther('1'))]);
    await rat.connect(await ethers.getSigner(C.liquiditySafe)).transfer(me.address, ethers.parseEther('25'));
    lock = await (await ethers.getContractFactory('RatPoolLock', me)).deploy(C.positions, C.whype, C.rat, C.fee, 120, 900);
    await lock.waitForDeployment();
    console.log(`fork: TEST lock deployed at ${lock.target}`);
  } else {
    const manifest = path.join(__dirname, '..', 'deployments', `pool-lock-${network.name}-test.json`);
    if (!fs.existsSync(manifest)) throw new Error(`no TEST lock: TEST=1 npx hardhat --config hardhat.config.cjs run scripts/deploy-pool-lock.cjs --network ${network.name}`);
    lock = await ethers.getContractAt('RatPoolLock', JSON.parse(fs.readFileSync(manifest, 'utf8')).address, me);
  }
  if (!(await lock.testMode())) throw new Error('this lock is not a TEST lock: the live test runs on a TEST lock only');
  const [delay, window] = [Number(await lock.UNLOCK_DELAY()), Number(await lock.UNLOCK_WINDOW())];

  const ratIn = ethers.parseEther('2'), ratSmall = ethers.parseEther('1'), swapIn = ethers.parseEther('1');
  const ratNeed = ratIn + ratSmall * 2n + swapIn; // (A 2 RAT, C 1, D 1, the swap 1)
  const whypeNeed = ethers.parseEther(process.env.LIVE_WHYPE || '0.0005');
  const gasIn = ethers.parseEther(process.env.LIVE_GAS_HYPE || '0.002');
  const [hype, ratBal, wBal] = await Promise.all([ethers.provider.getBalance(me.address), rat.balanceOf(me.address), whype.balanceOf(me.address)]);
  const toWrap = wBal < whypeNeed ? whypeNeed - wBal : 0n;
  console.log(`wallet ${me.address}: ${ethers.formatEther(hype)} HYPE, ${ethers.formatEther(wBal)} WHYPE, ${ethers.formatEther(ratBal)} RAT; TEST lock ${lock.target}: delay ${delay} s, window ${window} s`);
  if (hype < toWrap + gasIn) throw new Error(`not enough HYPE: ${ethers.formatEther(toWrap)} to wrap plus ${ethers.formatEther(gasIn)} of gas`);
  if (ratBal < ratNeed) throw new Error(`not enough RAT: ${ethers.formatEther(ratNeed)} needed`);
  if (!live) return console.log(`plan: 3 tiny positions (2, 1 and 1 RAT), every refusal simulated, an unlock cancelled, a holder handed to a throwaway wallet and back, a 1 RAT swap for real fees, an unlock lapsed (${delay + window} s), a NOTICE position made PERMANENT, one locked PERMANENT, one without liquidity refused and burned. LIVE=1 runs it.`);

  // the other wallet: a throwaway, its key kept outside the repo until its HYPE is back
  // (LIVE_SPARE_KEY_FILE: an earlier run's throwaway wallet, when it still holds A's rights or HYPE)
  const spareFile = process.env.LIVE_SPARE_KEY_FILE || '';
  const spare = new ethers.Wallet(spareFile ? fs.readFileSync(spareFile, 'utf8').trim() : ethers.Wallet.createRandom().privateKey, ethers.provider);
  const keyFile = spareFile || path.join(os.tmpdir(), `rat-pool-lock-spare-${spare.address}.key`);
  if (!fork) {
    if (!spareFile) fs.writeFileSync(keyFile, spare.privateKey + '\n', { mode: 0o600 });
    console.log(`throwaway wallet ${spare.address} (its key: ${keyFile}, deleted at the end)`);
  }
  const stranger = ethers.Wallet.createRandom().address;

  // the lock's custom errors, wherever the provider put the revert data (ethers, Hardhat, or bubbled up by the
  // positions contract from onERC721Received)
  const revertName = (e) => {
    const hexes = [], seen = new Set();
    const walk = (o, d) => {
      if (!o || d > 5) return;
      if (typeof o === 'string') { for (const m of o.matchAll(/0x[0-9a-fA-F]{8,}/g)) hexes.push(m[0]); return; }
      if (typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      for (const k of ['data', 'error', 'info', 'cause', 'parent', 'message']) walk(o[k], d + 1);
    };
    walk(e, 0);
    for (const h of hexes) { try { const p = lock.interface.parseError(h); if (p) return p.name; } catch { /* not one of the lock's */ } }
    const custom = /custom error '(\w+)\(/.exec(e?.message || '');
    return e?.revert?.name || (custom && custom[1]) || e?.reason || e?.shortMessage || String(e?.message || e);
  };
  const refused = async (label, call, name, attempt = 1) => {
    try { await call(); } catch (e) {
      if (attempt < 4 && transient(e)) { await sleep(2000 * attempt); return refused(label, call, name, attempt + 1); }
      const got = revertName(e);
      if (got !== name) throw new Error(`${label}: refused with ${got}, ${name} expected`);
      return console.log(`  refused as it should: ${label} (${name})`);
    }
    throw new Error(`${label}: it went through, ${name} expected`);
  };
  // (a transaction an RPC took but never passed on waits for nothing: TX_WAIT_MS at most, 120 s; then LIVE_A resumes)
  const waitMs = Number(process.env.TX_WAIT_MS) || 120_000;
  const mined = async (tx, label) => {
    try {
      return await tx.wait(1, waitMs);
    } catch (e) {
      if (e.code !== 'TIMEOUT') throw e;
      throw new Error(`${label}: ${tx.hash} (nonce ${tx.nonce}) not mined after ${waitMs / 1000} s; rerun${A ? ` with LIVE_A=${A}` : ''}`);
    }
  };
  const send = async (label, contract, fn, args = [], overrides = {}) => {
    const from = await contract.runner.getAddress();
    for (let attempt = 1; ; attempt++) {
      const nonce = await ethers.provider.getTransactionCount(from, 'pending');
      try {
        await contract[fn].staticCall(...args, overrides); // (simulated first: a revert stops here, nothing sent)
        const tx = await contract[fn](...args, overrides);
        const r = await mined(tx, label);
        console.log(`  ${label}: ${tx.hash} (block ${r.blockNumber})`);
        return r;
      } catch (e) {
        if (attempt >= 4 || !transient(e)) throw e;
        await sleep(3000 * attempt);
        if ((await ethers.provider.getTransactionCount(from, 'pending')) !== nonce) throw e; // (it went out: a rerun picks it up)
        console.log(`  (${label}: the RPC failed in passing, ${e.shortMessage || e.message}; asked again)`);
      }
    }
  };
  let A = process.env.LIVE_A ? BigInt(process.env.LIVE_A) : null; // (a rerun: the position A an earlier run locked NOTICE)
  // the throwaway wallet's gas, topped up before each of its steps: HyperEVM's gas price jumps (0.1 to 3.8 gwei within
  // minutes, 2026-10-15); at least 0.0008 HYPE, its leftover sent back at the end
  const fundSpare = async () => {
    const price = (await ethers.provider.getFeeData()).gasPrice;
    const want = price * 1_600_000n > ethers.parseEther('0.0008') ? price * 1_600_000n : ethers.parseEther('0.0008');
    const has = await ethers.provider.getBalance(spare.address);
    if (has >= want) return;
    const tx = await me.sendTransaction({ to: spare.address, value: want - has });
    await mined(tx, 'HYPE for the throwaway wallet');
    console.log(`  HYPE for the throwaway wallet's gas (${ethers.formatEther(want - has)}): ${tx.hash}`);
  };
  const now = async () => (await ethers.provider.getBlock('latest')).timestamp;
  const waitUntil = async (ts, what) => {
    if (fork) {
      if ((await now()) < ts) { await network.provider.send('evm_setNextBlockTimestamp', [ts]); await network.provider.send('evm_mine', []); }
      return;
    }
    for (let t = await now(); t < ts; t = await now()) { console.log(`  waiting ${ts - t} s (${what})`); await sleep(Math.min(60, ts - t + 2) * 1000); }
  };
  const deadline = async () => (await now()) + 600;
  const as = (who) => lock.connect(ethers.provider); // (simulations from any address: { from } in the overrides)
  const mintPos = async (label, rIn) => {
    const params = { token0: C.whype, token1: C.rat, fee: C.fee, tickLower: MIN_TICK, tickUpper: MAX_TICK, amount0Desired: whypeNeed, amount1Desired: rIn, amount0Min: 0, amount1Min: 0, recipient: me.address, deadline: await deadline() };
    const r = await send(`mint ${label}`, nfpm, 'mint', [params]);
    const ev = r.logs.map((l) => { try { return nfpm.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'IncreaseLiquidity');
    console.log(`  position ${label} #${ev.args.tokenId}: liquidity ${ev.args.liquidity}, ${ethers.formatEther(ev.args.amount0)} WHYPE, ${ethers.formatEther(ev.args.amount1)} RAT`);
    return ev.args.tokenId;
  };

  // 0. the tokens: WHYPE, allowances
  if (toWrap > 0n) await send('wrap HYPE', whype, 'deposit', [], { value: toWrap });
  if ((await whype.allowance(me.address, C.positions)) < whypeNeed * 3n) await send('approve WHYPE', whype, 'approve', [C.positions, whypeNeed * 3n]);
  if ((await rat.allowance(me.address, C.positions)) < ratIn + ratSmall * 2n) await send('approve RAT', rat, 'approve', [C.positions, ratIn + ratSmall * 2n]);
  if ((await rat.allowance(me.address, C.router)) < swapIn) await send('approve RAT to the router', rat, 'approve', [C.router, swapIn]);

  // 1. how a position comes in (the refusals of a position without a mode: on D, step 8)
  console.log('1. coming in');
  await refused('a call that is not from the positions contract', () => as().onERC721Received.staticCall(me.address, me.address, 1, modeData(NOTICE), { from: me.address }), 'NotPositionManager');
  if (A == null) {
    A = await mintPos('A', ratIn);
    await send('lock A (NOTICE)', nfpm, 'safeTransferFrom', [me.address, lock.target, A, modeData(NOTICE)]);
  } else {
    console.log(`  A #${A}: locked by an earlier run`);
    if (eq(await lock.holder(A), spare.address)) { // (an earlier run stopped while the throwaway wallet held it)
      await fundSpare();
      if (!eq(await lock.pendingHolder(A), me.address)) await send('the throwaway wallet offers A back', lock.connect(spare), 'offerHolder', [A, me.address]);
      await send('the wallet accepts A back', lock, 'acceptHolder', [A]);
    }
    if ((await lock.unlockReadyAt(A)) !== 0n) await send(`cancel the earlier run's announcement`, lock, 'cancelUnlock', [A]);
  }
  check(eq(await lock.holder(A), me.address) && Number(await lock.mode(A)) === NOTICE && eq(await nfpm.ownerOf(A), lock.target), 'A is locked NOTICE, the wallet its holder');

  // 2. a stranger can do nothing
  console.log('2. a stranger');
  for (const [fn, args] of [['collectFees', [A]], ['announceUnlock', [A]], ['cancelUnlock', [A]], ['unlock', [A]], ['makePermanent', [A]], ['offerHolder', [A, stranger]]]) {
    await refused(`a stranger's ${fn}`, () => as().getFunction(fn).staticCall(...args, { from: stranger }), 'NotHolder');
  }
  await refused(`a stranger's acceptHolder (no offer)`, () => as().acceptHolder.staticCall(A, { from: stranger }), 'NotOffered');

  // 3. the announced unlock: not announced, too soon, cancelled
  console.log('3. the unlock\'s rules');
  await refused('an unlock never announced', () => lock.unlock.staticCall(A), 'NotAnnounced');
  await refused('a cancel with nothing announced', () => lock.cancelUnlock.staticCall(A), 'NotAnnounced');
  await send('announce the unlock', lock, 'announceUnlock', [A]);
  await refused('an unlock before its delay', () => lock.unlock.staticCall(A), 'TooSoon');
  await send('cancel it', lock, 'cancelUnlock', [A]);
  check((await lock.unlockReadyAt(A)) === 0n, 'cancelled: no unlock announced');
  await refused('an unlock after its cancel', () => lock.unlock.staticCall(A), 'NotAnnounced');
  await send('announce it again (this one will lapse)', lock, 'announceUnlock', [A]);
  const readyAt = Number(await lock.unlockReadyAt(A));

  // 4. the holder's rights, to another wallet and back
  console.log('4. the holder\'s rights');
  await send('offer them to the throwaway wallet', lock, 'offerHolder', [A, spare.address]);
  await send('withdraw the offer', lock, 'offerHolder', [A, ethers.ZeroAddress]);
  await refused('an accept after the offer was withdrawn', () => as().acceptHolder.staticCall(A, { from: spare.address }), 'NotOffered');
  await send('offer them again', lock, 'offerHolder', [A, spare.address]);
  await refused(`the holder's own accept (not offered to it)`, () => lock.acceptHolder.staticCall(A), 'NotOffered');
  await fundSpare();
  await send('the throwaway wallet accepts', lock.connect(spare), 'acceptHolder', [A]);
  check(eq(await lock.holder(A), spare.address) && (await lock.pendingHolder(A)) === ethers.ZeroAddress, 'the throwaway wallet is the holder, no offer left');
  check(Number(await lock.unlockReadyAt(A)) === readyAt, 'the announced unlock stays with the position');
  await refused(`the old holder's collectFees`, () => lock.collectFees.staticCall(A), 'NotHolder');
  await refused(`the old holder's announceUnlock`, () => lock.announceUnlock.staticCall(A), 'NotHolder');
  await refused(`the old holder's offerHolder`, () => lock.offerHolder.staticCall(A, me.address), 'NotHolder');

  // 5. real fees: a swap through the pool, then the holder collects them
  console.log('5. real fees');
  await send('swap 1 RAT for WHYPE through the pool', router, 'exactInputSingle', [{ tokenIn: C.rat, tokenOut: C.whype, fee: C.fee, recipient: me.address, deadline: await deadline(), amountIn: swapIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }]);
  await fundSpare();
  const ratBefore = await rat.balanceOf(spare.address);
  const collected = await send('the holder collects the fees', lock.connect(spare), 'collectFees', [A]);
  const fees = collected.logs.map((l) => { try { return lock.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'FeesCollected');
  console.log(`  fees: ${fees.args.amount0} wei of WHYPE, ${fees.args.amount1} wei of RAT, to ${fees.args.to}`);
  check(fees.args.amount1 > 0n && eq(fees.args.to, spare.address) && (await rat.balanceOf(spare.address)) - ratBefore === fees.args.amount1, 'more than zero RAT of fees, paid to the holder');

  // 6. the rights back to the wallet
  console.log('6. the rights back');
  await send('the throwaway wallet offers them back', lock.connect(spare), 'offerHolder', [A, me.address]);
  await send('the wallet accepts', lock, 'acceptHolder', [A]);
  check(eq(await lock.holder(A), me.address), 'the wallet is the holder again');

  // 7. the announced unlock: ready, then lapsed
  console.log('7. the window');
  await waitUntil(readyAt, 'the TEST delay');
  await lock.unlock.staticCall(A);
  console.log('  ok: the unlock is ready (simulated, not sent)');

  // 8. a position locked PERMANENT from the start; a position without liquidity (while the window runs)
  console.log('8. PERMANENT from the start, and a position without liquidity');
  const P = await mintPos('P', ratSmall);
  await send('lock P (PERMANENT)', nfpm, 'safeTransferFrom', [me.address, lock.target, P, modeData(PERMANENT)]);
  check(eq(await lock.holder(P), me.address) && Number(await lock.mode(P)) === PERMANENT && eq(await nfpm.ownerOf(P), lock.target), 'P is locked PERMANENT, the wallet its holder');
  await refused('announcing the unlock of a PERMANENT position', () => lock.announceUnlock.staticCall(P), 'Permanent');
  await refused('unlocking a PERMANENT position', () => lock.unlock.staticCall(P), 'Permanent');
  await refused('making a PERMANENT position PERMANENT', () => lock.makePermanent.staticCall(P), 'Permanent');
  await lock.collectFees.staticCall(P);
  console.log(`  ok: P's holder may still collect its fees (simulated)`);
  const D = await mintPos('D', ratSmall);
  await refused('a position sent without a mode', () => nfpm.safeTransferFrom.staticCall(me.address, lock.target, D, '0x'), 'NoMode');
  await refused('a position sent with mode 3', () => nfpm.safeTransferFrom.staticCall(me.address, lock.target, D, modeData(3)), 'NoMode');
  await refused('a position sent with mode 0', () => nfpm.safeTransferFrom.staticCall(me.address, lock.target, D, modeData(0)), 'NoMode');
  const liqD = (await nfpm.positions(D))[7];
  await send('empty D', nfpm, 'decreaseLiquidity', [{ tokenId: D, liquidity: liqD, amount0Min: 0, amount1Min: 0, deadline: await deadline() }]);
  await refused('a position without liquidity', () => nfpm.safeTransferFrom.staticCall(me.address, lock.target, D, modeData(NOTICE)), 'NoLiquidity');
  const max = (1n << 128n) - 1n;
  await send(`collect D's tokens`, nfpm, 'collect', [{ tokenId: D, recipient: me.address, amount0Max: max, amount1Max: max }]);
  await send('burn D', nfpm, 'burn', [D]);

  await waitUntil(readyAt + window, 'the TEST window');
  await refused('an unlock after its window', () => lock.unlock.staticCall(A), 'Lapsed');

  // 9. A made PERMANENT: no way out any more
  console.log('9. NOTICE made PERMANENT');
  await send('make A PERMANENT', lock, 'makePermanent', [A]);
  check(Number(await lock.mode(A)) === PERMANENT && (await lock.unlockReadyAt(A)) === 0n, 'A is PERMANENT, its announcement dropped');
  await refused('announcing the unlock of a position made PERMANENT', () => lock.announceUnlock.staticCall(A), 'Permanent');
  await refused('unlocking a position made PERMANENT', () => lock.unlock.staticCall(A), 'Permanent');
  await refused('making it PERMANENT twice', () => lock.makePermanent.staticCall(A), 'Permanent');
  check((await lock.lockedCount()) >= 2n && eq(await nfpm.ownerOf(A), lock.target) && eq(await nfpm.ownerOf(P), lock.target), 'A and P stay in the lock');

  // 10. the throwaway wallet's HYPE back
  const left = await ethers.provider.getBalance(spare.address);
  const price = (await ethers.provider.getFeeData()).gasPrice * 2n;
  if (left > price * 21_000n) {
    const back = await spare.sendTransaction({ to: me.address, value: left - price * 21_000n, gasLimit: 21_000n, gasPrice: price });
    await mined(back, 'the HYPE back from the throwaway wallet');
    console.log(`  the throwaway wallet's HYPE back: ${back.hash}`);
  }
  if (!fork) fs.rmSync(keyFile, { force: true });
  console.log(`live test 2 passed: every refusal, a cancel, a holder change both ways, real fees to the holder, a lapse, PERMANENT twice, a position without liquidity refused (A #${A} and P #${P} stay locked for good)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
