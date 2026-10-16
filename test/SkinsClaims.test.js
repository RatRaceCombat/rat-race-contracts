// Suits bought with in-game RAT: the game reserves copies on chain, the player claims them later
// with a backend voucher once a wallet is linked.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { shopWith } = require('./helpers/suits.cjs'); // the shop on a permanent collection (RatRaceSuits)

const USDC = (n) => BigInt(Math.round(n * 1e6));
const RAT = (n) => ethers.parseEther(String(n));
const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
const CLAIM_TYPE = 'Claim(address to,uint256 id,uint256 amount,bytes32 claimId,uint256 deadline)';
const CLAIM_TYPES = { Claim: [
  { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' },
  { name: 'claimId', type: 'bytes32' }, { name: 'deadline', type: 'uint256' },
] };

async function deploy() {
  const [owner, treasury, buyback, minter, signer, alice, bob, relayer, rewards, claimer] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  const rat = await (await ethers.getContractFactory('MockRAT')).deploy();
  const skins = await shopWith([
    owner.address, await usdc.getAddress(), treasury.address, buyback.address, 5000, minter.address,
    500, await rat.getAddress(), rewards.address, signer.address, claimer.address, [500, 500]
  ]);
  await skins.setMinRatPrices([8, 13, 14], [1n, 1n, 1n]); // (the owner's RAT floors: a RAT sale needs one)
  await skins.configureEdition(8, 1000, USDC(15), true, true); // Cop
  await skins.configureEdition(13, 3, USDC(35), true, true); // a small edition to sell out
  await skins.configureEdition(14, 100, USDC(50), false, false); // sales closed
  for (const s of [alice, bob]) await usdc.mint(s.address, USDC(1000));
  await rat.mint(alice.address, RAT(10000));
  const domain = { name: 'RatRaceSkins', version: '1', chainId: 31337, verifyingContract: await skins.getAddress() };
  const voucher = async (extra = {}, by = claimer, d = domain) => {
    const v = { to: alice.address, id: 14, amount: 1n, claimId: ethers.hexlify(ethers.randomBytes(32)), deadline: (await now()) + 3600n, ...extra };
    return [v.to, v.id, v.amount, v.claimId, v.deadline, await by.signTypedData(d, CLAIM_TYPES, v)];
  };
  return { skins, usdc, rat, owner, treasury, buyback, minter, signer, claimer, alice, bob, relayer, rewards, domain, voucher };
}

describe('RatRaceSkins: game reservations and claims', () => {
  it('the minter reserves copies in batches, within each cap, atomically', async () => {
    const { skins, minter, alice } = await deploy();
    await expect(skins.connect(alice).reserveGame([8], [1])).to.be.revertedWithCustomError(skins, 'Unauthorized');
    await expect(skins.connect(minter).reserveGame([8, 14], [1])).to.be.revertedWithCustomError(skins, 'LengthMismatch');
    await expect(skins.connect(minter).reserveGame([99], [1])).to.be.revertedWithCustomError(skins, 'UnknownEdition');
    await expect(skins.connect(minter).reserveGame([8], [0])).to.be.revertedWithCustomError(skins, 'BadAmount');
    await expect(skins.connect(minter).reserveGame([8, 14], [5, 2]))
      .to.emit(skins, 'GameReserved').withArgs(8, 5, 5)
      .and.to.emit(skins, 'GameReserved').withArgs(14, 2, 2);
    await expect(skins.connect(minter).reserveGame([8], [3])).to.emit(skins, 'GameReserved').withArgs(8, 3, 8);
    expect(await skins.reserved(8)).to.equal(8n);
    expect(await skins.remaining(8)).to.equal(992n);
    // a reservation that would pass the cap fails, and the whole batch with it
    await expect(skins.connect(minter).reserveGame([14, 13], [1, 4])).to.be.revertedWithCustomError(skins, 'SoldOut');
    expect(await skins.reserved(14)).to.equal(2n);
    await skins.connect(minter).reserveGame([13], [3]); // exactly the cap: works while sales are open or closed
    expect(await skins.remaining(13)).to.equal(0n);
    await expect(skins.connect(minter).reserveGame([13], [1])).to.be.revertedWithCustomError(skins, 'SoldOut');
    // the cap can never go below minted + reserved
    await expect(skins.configureEdition(14, 1, USDC(50), false, false)).to.be.revertedWithCustomError(skins, 'SupplyCanOnlyGoDown');
    await expect(skins.configureEdition(14, 1, USDC(50), false, false)).to.be.revertedWithCustomError(skins, 'SupplyCanOnlyGoDown');
    await skins.configureEdition(14, 2, USDC(50), false, false);
    expect(await skins.remaining(14)).to.equal(0n);
  });

  it('a wallet purchase never takes a reserved copy (sold out with reservations)', async () => {
    const { skins, usdc, rat, minter, signer, alice, bob, domain } = await deploy();
    await usdc.connect(alice).approve(await skins.getAddress(), USDC(1000));
    await usdc.connect(bob).approve(await skins.getAddress(), USDC(1000));
    await skins.connect(alice).buyUsdc(13, ethers.MaxUint256); // 1 minted
    await skins.connect(minter).reserveGame([13], [2]); // 2 reserved: the edition of 3 is gone
    expect(await skins.remaining(13)).to.equal(0n);
    await expect(skins.connect(bob).buyUsdc(13, ethers.MaxUint256)).to.be.revertedWithCustomError(skins, 'SoldOut');
    await expect(skins.connect(bob).buyUsdc(13, USDC(35))).to.be.revertedWithCustomError(skins, 'SoldOut');
    const { RAT_QUOTE_TYPES } = await import('../shared/skins-chain.js');
    const q = { player: alice.address, id: 13, amount: RAT(1000), referrer: ethers.ZeroAddress, orderId: ethers.hexlify(ethers.randomBytes(32)),
      deadline: (await now()) + 300n, version: await skins.quoteVersion() };
    await rat.connect(alice).approve(await skins.getAddress(), q.amount);
    await expect(skins.connect(alice).buyRat(q, await signer.signTypedData(domain, RAT_QUOTE_TYPES, q))).to.be.revertedWithCustomError(skins, 'SoldOut');
    expect(await rat.balanceOf(alice.address)).to.equal(RAT(10000));
    // a refunded game sale gives its copy back to the wallet sale
    await skins.connect(minter).releaseGame([13], [1]);
    await skins.connect(bob).buyUsdc(13, ethers.MaxUint256);
    expect(await skins.suits.balanceOf(bob.address, 13)).to.equal(1n);
    expect((await skins.editions(13)).minted).to.equal(2n);
    expect(await skins.reserved(13)).to.equal(1n);
    await expect(skins.connect(bob).buyUsdc(13, ethers.MaxUint256)).to.be.revertedWithCustomError(skins, 'SoldOut');
  });

  it('anybody sends the voucher, the suit goes to its wallet, even with sales closed', async () => {
    const { skins, minter, alice, relayer, voucher } = await deploy();
    await skins.connect(minter).reserveGame([14], [3]);
    const v = await voucher({ amount: 2n });
    const gas0 = await ethers.provider.getBalance(alice.address);
    await expect(skins.connect(relayer).claim(...v))
      .to.emit(skins, 'Claimed').withArgs(v[3], alice.address, 14, 2)
      .and.to.emit(skins.suits, 'TransferSingle').withArgs(await skins.getAddress(), ethers.ZeroAddress, alice.address, 14, 2); // (the shop mints in the collection)
    expect(await skins.suits.balanceOf(alice.address, 14)).to.equal(2n);
    expect(await ethers.provider.getBalance(alice.address)).to.equal(gas0); // the claimant paid no gas
    expect(await skins.reserved(14)).to.equal(1n);
    expect(await skins.minted(14)).to.equal(2n);
    expect((await skins.editions(14)).minted).to.equal(2n);
    expect(await skins.remaining(14)).to.equal(97n);
    expect(await skins.claimUsed(v[3])).to.equal(true);
    // the player can send it too
    const own = await voucher();
    await skins.connect(alice).claim(...own);
    expect(await skins.suits.balanceOf(alice.address, 14)).to.equal(3n);
    expect(await skins.reserved(14)).to.equal(0n);
  });

  it('a claimId mints once, whatever voucher carries it', async () => {
    const { skins, minter, alice, bob, voucher } = await deploy();
    await skins.connect(minter).reserveGame([14], [3]);
    const v = await voucher();
    await skins.connect(bob).claim(...v);
    await expect(skins.connect(bob).claim(...v)).to.be.revertedWithCustomError(skins, 'ClaimAlreadyUsed');
    const again = await voucher({ to: bob.address, claimId: v[3] }); // re-issued to another wallet
    await expect(skins.connect(bob).claim(...again)).to.be.revertedWithCustomError(skins, 'ClaimAlreadyUsed');
    expect(await skins.reserved(14)).to.equal(2n);
    expect(await skins.suits.balanceOf(bob.address, 14)).to.equal(0n);
  });

  it('refuses expired, forged, altered and cross-domain vouchers', async () => {
    const { skins, minter, alice, bob, owner, rewards, signer, claimer, domain, voucher } = await deploy();
    await skins.connect(minter).reserveGame([14], [5]);
    const expired = await voucher({ deadline: (await now()) - 1n });
    await expect(skins.claim(...expired)).to.be.revertedWithCustomError(skins, 'BadClaim');
    const late = await voucher({ deadline: (await now()) + 60n });
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(late[4]) + 1]);
    await expect(skins.claim(...late)).to.be.revertedWithCustomError(skins, 'BadClaim'); // one second too late
    const edge = await voucher({ deadline: (await now()) + 60n });
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(edge[4])]);
    await skins.claim(...edge); // valid up to its deadline second, included
    for (const v of [
      await voucher({}, bob), // wrong signer
      await voucher({}, minter), // the minter cannot sign claims
      await voucher({}, signer), // the quote signer: never a claim signer (the review's M1)
      await voucher({}, claimer, { ...domain, chainId: 999 }),
      await voucher({}, claimer, { ...domain, verifyingContract: bob.address }),
      await voucher({}, claimer, { ...domain, name: 'RatRaceDistributor' }),
      await voucher({}, claimer, { ...domain, version: '2' }),
    ]) await expect(skins.claim(...v)).to.be.revertedWithCustomError(skins, 'BadClaim');
    const v = await voucher();
    await expect(skins.claim(bob.address, ...v.slice(1))).to.be.revertedWithCustomError(skins, 'BadClaim'); // other wallet
    await expect(skins.claim(v[0], 8, ...v.slice(2))).to.be.revertedWithCustomError(skins, 'BadClaim'); // other edition
    await expect(skins.claim(v[0], v[1], 2n, ...v.slice(3))).to.be.revertedWithCustomError(skins, 'BadClaim'); // more copies
    await expect(skins.claim(...v.slice(0, 4), v[4] + 1n, v[5])).to.be.revertedWithCustomError(skins, 'BadClaim'); // longer life
    // a new claim signer voids every voucher of the old one (the server signs them again, same claimId)
    await expect(skins.connect(owner).setClaimSigner(signer.address)).to.be.revertedWithCustomError(skins, 'SameKey');
    await skins.connect(owner).setClaimSigner(bob.address);
    await expect(skins.claim(...v)).to.be.revertedWithCustomError(skins, 'BadClaim');
    await skins.claim(...(await voucher({ claimId: v[3] }, bob)));
    expect(await skins.suits.balanceOf(alice.address, 14)).to.equal(2n);
  });

  it('never claims more than the game reserved, nor zero copies', async () => {
    const { skins, usdc, minter, alice, voucher } = await deploy();
    await expect(skins.claim(...(await voucher()))).to.be.revertedWithCustomError(skins, 'NotReserved'); // nothing reserved
    await skins.connect(minter).reserveGame([14, 8], [1, 1]);
    await expect(skins.claim(...(await voucher({ amount: 2n })))).to.be.revertedWithCustomError(skins, 'NotReserved');
    await expect(skins.claim(...(await voucher({ amount: 0n })))).to.be.revertedWithCustomError(skins, 'BadClaim');
    // a receiver that refuses ERC-1155 tokens: nothing is consumed, the voucher stays usable elsewhere
    const v = await voucher({ to: await usdc.getAddress() });
    await expect(skins.claim(...v)).to.be.revertedWithCustomError(skins.suits, 'ERC1155InvalidReceiver');
    expect(await skins.claimUsed(v[3])).to.equal(false);
    expect(await skins.reserved(14)).to.equal(1n);
    await skins.claim(...(await voucher({ claimId: v[3] })));
    await expect(skins.claim(...(await voucher()))).to.be.revertedWithCustomError(skins, 'NotReserved');
    expect(await skins.suits.balanceOf(alice.address, 14)).to.equal(1n);
    expect(await skins.reserved(8)).to.equal(1n);
  });

  it('pausing stops claims and reservations, never releases or transfers', async () => {
    const { skins, owner, minter, alice, bob, voucher } = await deploy();
    await skins.connect(minter).reserveGame([14], [3]);
    await skins.claim(...(await voucher()));
    const v = await voucher();
    await skins.connect(owner).pause();
    await expect(skins.claim(...v)).to.be.revertedWithCustomError(skins, 'EnforcedPause');
    await expect(skins.connect(minter).reserveGame([14], [1])).to.be.revertedWithCustomError(skins, 'EnforcedPause');
    await expect(skins.connect(minter).releaseGame([14], [1])).to.emit(skins, 'GameReleased').withArgs(14, 1, 1);
    await skins.suits.connect(alice).safeTransferFrom(alice.address, bob.address, 14, 1, '0x');
    expect(await skins.suits.balanceOf(bob.address, 14)).to.equal(1n);
    await skins.connect(owner).unpause();
    await skins.claim(...v);
    expect(await skins.suits.balanceOf(alice.address, 14)).to.equal(1n);
    expect(await skins.reserved(14)).to.equal(0n);
  });

  it('a refund releases a reservation, never below zero, only by the minter', async () => {
    const { skins, minter, alice, voucher } = await deploy();
    await skins.connect(minter).reserveGame([14, 8], [2, 1]);
    await expect(skins.connect(alice).releaseGame([14], [1])).to.be.revertedWithCustomError(skins, 'Unauthorized');
    await expect(skins.connect(minter).releaseGame([14], [1, 1])).to.be.revertedWithCustomError(skins, 'LengthMismatch');
    await expect(skins.connect(minter).releaseGame([14], [0])).to.be.revertedWithCustomError(skins, 'BadAmount');
    await expect(skins.connect(minter).releaseGame([14], [3])).to.be.revertedWithCustomError(skins, 'NotReserved');
    await expect(skins.connect(minter).releaseGame([8, 14], [1, 3])).to.be.revertedWithCustomError(skins, 'NotReserved'); // all or nothing
    expect(await skins.reserved(8)).to.equal(1n);
    await expect(skins.connect(minter).releaseGame([14, 8], [1, 1]))
      .to.emit(skins, 'GameReleased').withArgs(14, 1, 1)
      .and.to.emit(skins, 'GameReleased').withArgs(8, 1, 0);
    expect(await skins.remaining(14)).to.equal(99n);
    await skins.claim(...(await voucher()));
    await expect(skins.connect(minter).releaseGame([14], [1])).to.be.revertedWithCustomError(skins, 'NotReserved'); // claimed copies stay minted
    expect(await skins.minted(14)).to.equal(1n);
  });

  it('exposes the voucher domain, type and the views the server reads', async () => {
    const { skins, signer, claimer, domain, voucher } = await deploy();
    const d = await skins.eip712Domain();
    expect(d.name).to.equal('RatRaceSkins');
    expect(d.version).to.equal('1');
    expect(d.chainId).to.equal(31337n);
    expect(d.verifyingContract).to.equal(await skins.getAddress());
    expect(await skins.CLAIM_TYPEHASH()).to.equal(ethers.id(CLAIM_TYPE));
    expect(ethers.TypedDataEncoder.from(CLAIM_TYPES).encodeType('Claim')).to.equal(CLAIM_TYPE);
    expect(await skins.quoteSigner()).to.equal(signer.address);
    expect(await skins.claimSigner()).to.equal(claimer.address); // its own key since the review of 2026-10-13
    const v = await voucher();
    const digest = ethers.TypedDataEncoder.hash(domain, CLAIM_TYPES, { to: v[0], id: v[1], amount: v[2], claimId: v[3], deadline: v[4] });
    expect(ethers.recoverAddress(digest, v[5])).to.equal(claimer.address);
    expect(await skins.reserved(14)).to.equal(0n);
    expect(await skins.minted(14)).to.equal(0n);
    expect(await skins.claimUsed(v[3])).to.equal(false);
  });

  it('the state-changing functions are exactly these (the minter only reserves and releases)', async () => {
    const { skins } = await deploy();
    const writes = skins.interface.fragments
      .filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))
      .map((f) => f.name)
      .sort();
    expect(writes).to.deep.equal([
      'acceptOwnership',
      'buyRat', 'buyUsdc', // wallet sales (buy(id) without a price bound is gone: the review's L2; no gasless purchase since 2026-10-14)
      'claim', // anybody, with the backend's voucher
      'configureEdition', 'pause', // owner
      'releaseGame', // minter
      'reserveGame', // minter
      'revokeClaim', // minter or owner
      // (the holders' transfers, the metadata and the royalties: in the permanent collection since 2026-10-14)
      'setClaimSigner', 'setMinRatPrices', 'setMinter', 'setPayment', 'setQuoteSigner', // owner (the pot fixed at deploy)
      'transferOwnership', 'unpause',
    ]);
  });
});
