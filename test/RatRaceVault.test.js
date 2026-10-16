const { expect } = require('chai');
const { ethers } = require('hardhat');

const GEM_PRICE = 100_000n; // 0.10 USDC (6 decimals) per rGem
const FEE_BPS = 300n;
const USDC = (n) => BigInt(Math.round(n * 1e6));

async function deploy(opts = {}) {
  const [owner, signer, feeWallet, alice, bob, cosigner, guardian] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  const Vault = await ethers.getContractFactory('RatRaceVault');
  const vault = await Vault.deploy({
    owner: owner.address,
    token: await usdc.getAddress(),
    signer: signer.address,
    cosigner: cosigner.address,
    guardian: guardian.address,
    feeWallet: feeWallet.address,
    gemPrice: GEM_PRICE,
    depositFeeBps: FEE_BPS,
    dailyLimitGems: 1000n,
    globalDailyLimitGems: opts.global ?? 3000n,
    coSignThresholdGems: opts.cosignAt ?? 2000n,
  });
  await vault.waitForDeployment();
  const va = await vault.getAddress();
  for (const s of [owner, alice, bob]) await usdc.mint(s.address, USDC(1000));
  // withdrawal liquidity
  await usdc.connect(owner).approve(va, USDC(500));
  await vault.connect(owner).fund(USDC(500));
  return { vault, usdc, va, owner, signer, feeWallet, alice, bob, cosigner, guardian };
}

async function voucher(vault, signer, player, gems, nonce, deadline, domainOverrides = {}) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'RatRaceVault', version: '1', chainId, verifyingContract: await vault.getAddress(), ...domainOverrides };
  const types = {
    Withdraw: [
      { name: 'player', type: 'address' },
      { name: 'gems', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  return signer.signTypedData(domain, types, { player, gems, nonce, deadline });
}

async function permit(usdc, owner, spender, value, deadline) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: await usdc.name(), version: '1', chainId, verifyingContract: await usdc.getAddress() };
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const sig = await owner.signTypedData(domain, types, { owner: owner.address, spender, value, nonce: await usdc.nonces(owner.address), deadline });
  return ethers.Signature.from(sig);
}

async function now() {
  return BigInt((await ethers.provider.getBlock('latest')).timestamp);
}

describe('RatRaceVault (USDC)', () => {
  it('quotes and accepts deposits, forwarding the fee', async () => {
    const { vault, usdc, va, alice, feeWallet } = await deploy();
    const [total, fee] = await vault.quoteDeposit(100n);
    expect(fee).to.equal((100n * GEM_PRICE * FEE_BPS) / 10000n);
    await usdc.connect(alice).approve(va, total);
    const before = await usdc.balanceOf(va);
    await expect(vault.connect(alice).deposit(100n))
      .to.emit(vault, 'Deposited')
      .withArgs(alice.address, 100n, total, fee);
    expect(await usdc.balanceOf(feeWallet.address)).to.equal(fee);
    expect((await usdc.balanceOf(va)) - before).to.equal(100n * GEM_PRICE);
  });

  it('deposits in one transaction with an EIP-2612 permit', async () => {
    const { vault, usdc, va, alice } = await deploy();
    const [total, fee] = await vault.quoteDeposit(30n);
    const deadline = (await now()) + 600n;
    const { v, r, s } = await permit(usdc, alice, va, total, deadline);
    await expect(vault.connect(alice).depositWithPermit(30n, deadline, v, r, s))
      .to.emit(vault, 'Deposited')
      .withArgs(alice.address, 30n, total, fee);
    expect(await usdc.allowance(alice.address, va)).to.equal(0n);
  });

  it('gasless: a relayer submits the player permit, the player is credited and pays no gas', async () => {
    const { vault, usdc, va, alice, bob } = await deploy();
    const [total, fee] = await vault.quoteDeposit(40n);
    const deadline = (await now()) + 600n;
    const { v, r, s } = await permit(usdc, alice, va, total, deadline);
    const gasBefore = await ethers.provider.getBalance(alice.address);
    // the relayer cannot change the amount: the permit only authorizes quoteDeposit(40)
    await expect(vault.connect(bob).depositWithPermitFor(alice.address, 50n, deadline, v, r, s)).to.be.reverted;
    await expect(vault.connect(bob).depositWithPermitFor(alice.address, 40n, deadline, v, r, s))
      .to.emit(vault, 'Deposited')
      .withArgs(alice.address, 40n, total, fee);
    expect(await ethers.provider.getBalance(alice.address)).to.equal(gasBefore);
    // nor replay it, nor spend an older allowance without a fresh permit
    await expect(vault.connect(bob).depositWithPermitFor(alice.address, 40n, deadline, v, r, s)).to.be.reverted;
    await usdc.connect(alice).approve(va, total);
    await expect(vault.connect(bob).depositWithPermitFor(alice.address, 40n, deadline, v, r, s)).to.be.reverted;
  });

  it('gasless: anyone can relay a voucher but the tokens always go to the player', async () => {
    const { vault, usdc, signer, alice, bob } = await deploy();
    const deadline = (await now()) + 600n;
    const sig = await voucher(vault, signer, alice.address, 50n, 9n, deadline);
    const [a0, b0] = [await usdc.balanceOf(alice.address), await usdc.balanceOf(bob.address)];
    await expect(vault.connect(bob).withdrawFor(bob.address, 50n, 9n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'InvalidSignature');
    await vault.connect(bob).withdrawFor(alice.address, 50n, 9n, deadline, sig, '0x');
    expect((await usdc.balanceOf(alice.address)) - a0).to.equal(50n * GEM_PRICE);
    expect(await usdc.balanceOf(bob.address)).to.equal(b0);
    await expect(vault.connect(alice).withdraw(50n, 9n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'NonceUsed');
  });

  it('rejects deposits without allowance or with a bad amount', async () => {
    const { vault, usdc, alice } = await deploy();
    await expect(vault.connect(alice).deposit(10n)).to.be.revertedWithCustomError(usdc, 'ERC20InsufficientAllowance');
    await expect(vault.connect(alice).deposit(0n)).to.be.revertedWithCustomError(vault, 'InvalidGemCount');
  });

  it('pays a valid voucher once', async () => {
    const { vault, usdc, signer, alice } = await deploy();
    const deadline = (await now()) + 600n;
    const sig = await voucher(vault, signer, alice.address, 50n, 7n, deadline);
    const before = await usdc.balanceOf(alice.address);
    await vault.connect(alice).withdraw(50n, 7n, deadline, sig, '0x');
    expect((await usdc.balanceOf(alice.address)) - before).to.equal(50n * GEM_PRICE);
    await expect(vault.connect(alice).withdraw(50n, 7n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'NonceUsed');
  });

  it('rejects vouchers for another player, forged, or expired', async () => {
    const { vault, signer, alice, bob } = await deploy();
    const deadline = (await now()) + 600n;
    const sig = await voucher(vault, signer, alice.address, 50n, 1n, deadline);
    await expect(vault.connect(bob).withdraw(50n, 1n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'InvalidSignature');
    const forged = await voucher(vault, bob, bob.address, 50n, 2n, deadline);
    await expect(vault.connect(bob).withdraw(50n, 2n, deadline, forged, '0x')).to.be.revertedWithCustomError(vault, 'InvalidSignature');
    const old = (await now()) - 1n;
    const expired = await voucher(vault, signer, alice.address, 50n, 3n, old);
    await expect(vault.connect(alice).withdraw(50n, 3n, old, expired, '0x')).to.be.revertedWithCustomError(vault, 'VoucherExpired');
  });

  it('enforces the daily limit', async () => {
    const { vault, signer, alice } = await deploy();
    const deadline = (await now()) + 600n;
    await vault.connect(alice).withdraw(900n, 1n, deadline, await voucher(vault, signer, alice.address, 900n, 1n, deadline), '0x');
    expect(await vault.remainingDailyGems(alice.address)).to.equal(100n);
    const sig = await voucher(vault, signer, alice.address, 200n, 2n, deadline);
    await expect(vault.connect(alice).withdraw(200n, 2n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'DailyLimitExceeded');
  });

  it('lets the signer cancel a voucher and the owner pause', async () => {
    const { vault, usdc, va, signer, owner, alice } = await deploy();
    const deadline = (await now()) + 600n;
    const sig = await voucher(vault, signer, alice.address, 10n, 9n, deadline);
    await vault.connect(signer).cancelNonce(9n);
    await expect(vault.connect(alice).withdraw(10n, 9n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'NonceUsed');
    await vault.connect(owner).pause();
    await usdc.connect(alice).approve(va, USDC(1));
    await expect(vault.connect(alice).deposit(1n)).to.be.revertedWithCustomError(vault, 'EnforcedPause');
    await expect(vault.connect(alice).cancelNonce(1n)).to.be.revertedWithCustomError(vault, 'Unauthorized');
  });

  it('works with smart-contract wallets', async () => {
    const { vault, usdc, va, signer, owner } = await deploy();
    const wallet = await (await ethers.getContractFactory('SmartWalletMock')).deploy();
    const walletAddr = await wallet.getAddress();
    await usdc.connect(owner).transfer(walletAddr, USDC(10));
    const [total] = await vault.quoteDeposit(5n);
    await expect(wallet.doDeposit(await usdc.getAddress(), va, total, 5n))
      .to.emit(vault, 'Deposited')
      .withArgs(walletAddr, 5n, total, total - 5n * GEM_PRICE);
    const deadline = (await now()) + 600n;
    const sig = await voucher(vault, signer, walletAddr, 5n, 11n, deadline);
    const before = await usdc.balanceOf(walletAddr);
    await wallet.doWithdraw(va, 5n, 11n, deadline, sig);
    expect((await usdc.balanceOf(walletAddr)) - before).to.equal(5n * GEM_PRICE);
  });

  it('tracks funding and lets only the owner move treasury', async () => {
    const { vault, usdc, va, owner, alice } = await deploy();
    await usdc.connect(alice).approve(va, 123n);
    await expect(vault.connect(alice).fund(123n)).to.emit(vault, 'Funded').withArgs(alice.address, 123n);
    await expect(vault.connect(alice).withdrawTreasury(alice.address, 1n)).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    await expect(vault.connect(owner).withdrawTreasury(owner.address, 1n)).to.emit(vault, 'TreasuryWithdrawn');
  });
});

describe('RatRaceVault security layers', () => {
  it('withdrawal signatures cannot cross chains or contracts', async () => {
    const { vault, signer, alice, bob } = await deploy();
    const deadline = (await now()) + 600n;
    for (const domain of [{ chainId: 999 }, { verifyingContract: bob.address }]) {
      const signature = await voucher(vault, signer, alice.address, 10n, 99n, deadline, domain);
      await expect(vault.connect(alice).withdraw(10n, 99n, deadline, signature, '0x')).to.be.revertedWithCustomError(vault, 'InvalidSignature');
    }
    expect(await vault.usedNonces(99n)).to.equal(false);
  });

  it('lowering daily caps below consumption rejects cleanly and resets the next UTC day', async () => {
    const { vault, signer, alice } = await deploy();
    const deadline = (await now()) + 172800n;
    const withdraw = async (gems, nonce) => vault.connect(alice).withdraw(gems, nonce, deadline,
      await voucher(vault, signer, alice.address, gems, nonce, deadline), '0x');
    await withdraw(100n, 1n);
    await vault.setDailyLimits(50n, 3000n);
    await expect(withdraw(1n, 2n)).to.be.revertedWithCustomError(vault, 'DailyLimitExceeded').withArgs(0n);
    await vault.setDailyLimits(1000n, 50n);
    await expect(withdraw(1n, 2n)).to.be.revertedWithCustomError(vault, 'GlobalLimitExceeded').withArgs(0n);
    expect(await vault.usedNonces(2n)).to.equal(false);
    await ethers.provider.send('evm_increaseTime', [86400]);
    await ethers.provider.send('evm_mine', []);
    await withdraw(1n, 2n);
    expect(await vault.remainingGlobalGems()).to.equal(49n);
  });

  it('large withdrawals need the independent cosigner', async () => {
    const { vault, signer, cosigner, alice } = await deploy({ cosignAt: 500n });
    const deadline = (await now()) + 600n;
    const sig = await voucher(vault, signer, alice.address, 600n, 1n, deadline);
    await expect(vault.connect(alice).withdraw(600n, 1n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'CosignatureRequired');
    const fake = await voucher(vault, signer, alice.address, 600n, 1n, deadline); // same key twice
    await expect(vault.connect(alice).withdraw(600n, 1n, deadline, sig, fake)).to.be.revertedWithCustomError(vault, 'InvalidSignature');
    const co = await voucher(vault, cosigner, alice.address, 600n, 1n, deadline);
    await expect(vault.connect(alice).withdraw(600n, 1n, deadline, sig, co)).to.emit(vault, 'Withdrawn');
    // small ones do not
    const small = await voucher(vault, signer, alice.address, 100n, 2n, deadline);
    await expect(vault.connect(alice).withdraw(100n, 2n, deadline, small, '0x')).to.emit(vault, 'Withdrawn');
  });

  it('a global daily cap bounds the damage of a stolen signer key', async () => {
    const { vault, signer, alice, bob, owner } = await deploy({ global: 1500n });
    const deadline = (await now()) + 600n;
    await vault.connect(alice).withdraw(900n, 1n, deadline, await voucher(vault, signer, alice.address, 900n, 1n, deadline), '0x');
    expect(await vault.remainingGlobalGems()).to.equal(600n);
    const sig = await voucher(vault, signer, bob.address, 700n, 2n, deadline);
    await expect(vault.connect(bob).withdraw(700n, 2n, deadline, sig, '0x')).to.be.revertedWithCustomError(vault, 'GlobalLimitExceeded');
    await expect(vault.connect(alice).setDailyLimits(1, 1)).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    await vault.connect(owner).setDailyLimits(1000n, 5000n);
    await expect(vault.connect(bob).withdraw(700n, 2n, deadline, sig, '0x')).to.emit(vault, 'Withdrawn');
  });

  it('the guardian can freeze the vault but neither resume it nor touch funds', async () => {
    const { vault, usdc, va, guardian, owner, alice } = await deploy();
    await vault.connect(guardian).pause();
    await usdc.connect(alice).approve(va, USDC(10));
    await expect(vault.connect(alice).deposit(1n)).to.be.revertedWithCustomError(vault, 'EnforcedPause');
    await expect(vault.connect(guardian).unpause()).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    await expect(vault.connect(guardian).withdrawTreasury(guardian.address, 1n)).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    await expect(vault.connect(alice).pause()).to.be.revertedWithCustomError(vault, 'Unauthorized');
    await vault.connect(owner).unpause();
    await expect(vault.connect(alice).deposit(1n)).to.emit(vault, 'Deposited');
  });

  it('signer and cosigner must be different keys', async () => {
    const { vault, signer, owner } = await deploy();
    await expect(vault.connect(owner).setCosigner(signer.address, 1n)).to.be.revertedWithCustomError(vault, 'SameKey');
  });

  it('burns the RAT spent on suits (owner only)', async () => {
    const { vault, usdc, owner, alice } = await deploy();
    const dead = '0x000000000000000000000000000000000000dEaD';
    await expect(vault.connect(alice).burnTreasury(1n)).to.be.revertedWithCustomError(vault, 'OwnableUnauthorizedAccount');
    await expect(vault.connect(owner).burnTreasury(USDC(5))).to.emit(vault, 'Burned').withArgs(USDC(5));
    expect(await usdc.balanceOf(dead)).to.equal(USDC(5));
  });

  it('refuses fee-on-transfer tokens (deposits must arrive in full)', async () => {
    const [owner, signer, feeWallet, alice] = await ethers.getSigners();
    const fee = await (await ethers.getContractFactory('FeeTokenMock')).deploy();
    const vault = await (await ethers.getContractFactory('RatRaceVault')).deploy({
      owner: owner.address, token: await fee.getAddress(), signer: signer.address, cosigner: ethers.ZeroAddress, guardian: owner.address,
      feeWallet: feeWallet.address, gemPrice: 10n ** 18n, depositFeeBps: 0, dailyLimitGems: 0, globalDailyLimitGems: 0, coSignThresholdGems: 0,
    });
    await fee.transfer(alice.address, 10n ** 21n);
    await fee.connect(alice).approve(await vault.getAddress(), 10n ** 21n);
    await expect(vault.connect(alice).deposit(5n)).to.be.revertedWithCustomError(vault, 'UnsupportedToken');
  });
});
