const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFixture, TERM, DURATION, USDC } = require("./fixtures");

/**
 * The liquidity layer: idle pool cash routed into an external ERC-4626
 * venue, float yield skimmed to the treasury, protocol-owned liquidity
 * seeded from the ProtocolTreasury, and faucet onboarding.
 */
async function liquidityFixture() {
  const ctx = await loadFixture(deployFixture);
  const { owner, usdc, market } = ctx;

  const vault = await ethers.deployContract("MockYieldVault", [usdc]);
  await market.connect(owner).setReserveVault(vault);

  const protocolTreasury = await ethers.deployContract("ProtocolTreasury", [owner.address]);
  const faucet = await ethers.deployContract("Faucet", [
    usdc,
    ctx.tbill,
    ctx.credit,
    USDC(100_000),
    USDC(50_000),
    ethers.parseUnits("25000", 18),
  ]);

  return { ...ctx, vault, protocolTreasury, faucet };
}

describe("RepoMarket — external reserve vault (ERC-4626)", function () {
  it("parks deposits in the vault and holds no local cash", async function () {
    const { market, usdc, vault, lenderA } = await liquidityFixture();
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000));

    expect(await usdc.balanceOf(market)).to.equal(0n);
    expect(await vault.convertToAssets(await vault.balanceOf(market))).to.equal(USDC(1_000_000));

    const [cash] = await market.getPool(TERM.OVERNIGHT);
    expect(cash).to.equal(USDC(1_000_000)); // accounting unchanged
  });

  it("pulls from the vault for borrows and withdrawals, pushes back on repay", async function () {
    const { market, usdc, vault, lenderA, borrower, tbill } = await liquidityFixture();
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000));

    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(500_000), USDC(400_000));
    expect(await vault.convertToAssets(await vault.balanceOf(market))).to.equal(USDC(600_000));
    expect(await usdc.balanceOf(borrower.address)).to.be.gte(USDC(400_000));

    const repo = await market.getRepo(0);
    await time.setNextBlockTimestamp(BigInt(repo.openedAt) + DURATION[TERM.OVERNIGHT]);
    await market.connect(borrower).closeRepo(0);
    // principal + pool's interest cut came back into the vault
    expect(await vault.convertToAssets(await vault.balanceOf(market))).to.be.gt(USDC(1_000_000));

    const shares = await market.sharesOf(TERM.OVERNIGHT, lenderA.address);
    const balBefore = await usdc.balanceOf(lenderA.address);
    await market.connect(lenderA).withdraw(TERM.OVERNIGHT, shares);
    expect((await usdc.balanceOf(lenderA.address)) - balBefore).to.be.gt(USDC(1_000_000));
  });

  it("skims vault yield to the treasury without touching lender claims", async function () {
    const { market, usdc, vault, treasury, lenderA } = await liquidityFixture();
    await market.connect(lenderA).deposit(TERM.MONTHLY, USDC(2_000_000));

    // The venue earns 1% on the float.
    await usdc.mint(vault, USDC(20_000));

    const lenderBefore = await market.balanceOfAssets(TERM.MONTHLY, lenderA.address);
    const treasuryBefore = await usdc.balanceOf(treasury.address);

    await market.skim();

    expect((await usdc.balanceOf(treasury.address)) - treasuryBefore).to.be.closeTo(USDC(20_000), 2n);
    expect(await market.balanceOfAssets(TERM.MONTHLY, lenderA.address)).to.equal(lenderBefore);

    // Nothing left to skim; lenders can still exit in full.
    await market.skim();
    const shares = await market.sharesOf(TERM.MONTHLY, lenderA.address);
    await market.connect(lenderA).withdraw(TERM.MONTHLY, shares);
  });

  it("migrates between venues and back to local custody, funds intact", async function () {
    const { market, usdc, vault, owner, lenderA } = await liquidityFixture();
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(500_000));

    const vault2 = await ethers.deployContract("MockYieldVault", [usdc]);
    await market.connect(owner).setReserveVault(vault2);
    expect(await vault.balanceOf(market)).to.equal(0n);
    expect(await vault2.convertToAssets(await vault2.balanceOf(market))).to.equal(USDC(500_000));

    // Back to local custody.
    await market.connect(owner).setReserveVault(ethers.ZeroAddress);
    expect(await usdc.balanceOf(market)).to.equal(USDC(500_000));

    const shares = await market.sharesOf(TERM.OVERNIGHT, lenderA.address);
    await market.connect(lenderA).withdraw(TERM.OVERNIGHT, shares);
  });

  it("rejects a vault whose asset isn't the market's cash", async function () {
    const { market, owner, credit } = await liquidityFixture();
    const wrongVault = await ethers.deployContract("MockYieldVault", [credit]);
    await expect(market.connect(owner).setReserveVault(wrongVault)).to.be.revertedWithCustomError(
      market,
      "InvalidParams"
    );
  });

  it("only the owner can set the vault; skim is permissionless", async function () {
    const { market, other, usdc, vault } = await liquidityFixture();
    await expect(market.connect(other).setReserveVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      market,
      "OwnableUnauthorizedAccount"
    );
    await usdc.mint(vault, USDC(1));
    await market.connect(other).skim(); // anyone; proceeds go to treasury
  });
});

describe("ProtocolTreasury — protocol-owned liquidity", function () {
  it("seeds a term pool and exits it with earnings", async function () {
    const { market, usdc, owner, protocolTreasury, borrower, tbill } = await liquidityFixture();
    await usdc.mint(protocolTreasury, USDC(3_000_000));

    await protocolTreasury.connect(owner).seedPool(market, TERM.OVERNIGHT, USDC(3_000_000));
    const [cash] = await market.getPool(TERM.OVERNIGHT);
    expect(cash).to.equal(USDC(3_000_000));

    // A borrower pays interest into the seeded pool.
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1_500_000), USDC(1_000_000));
    const repo = await market.getRepo(0);
    await time.setNextBlockTimestamp(BigInt(repo.openedAt) + DURATION[TERM.OVERNIGHT]);
    await market.connect(borrower).closeRepo(0);

    const shares = await market.sharesOf(TERM.OVERNIGHT, await protocolTreasury.getAddress());
    await protocolTreasury.connect(owner).exitPool(market, TERM.OVERNIGHT, shares);
    expect(await usdc.balanceOf(protocolTreasury)).to.be.gt(USDC(3_000_000));
  });

  it("gates seeding, exiting and sweeping to the owner", async function () {
    const { market, usdc, other, protocolTreasury } = await liquidityFixture();
    await expect(
      protocolTreasury.connect(other).seedPool(market, TERM.OVERNIGHT, 1)
    ).to.be.revertedWithCustomError(protocolTreasury, "OwnableUnauthorizedAccount");
    await expect(
      protocolTreasury.connect(other).sweep(usdc, other.address, 1)
    ).to.be.revertedWithCustomError(protocolTreasury, "OwnableUnauthorizedAccount");
  });
});

describe("Faucet — testnet onboarding", function () {
  it("dispenses starter balances once per cooldown", async function () {
    const { faucet, usdc, tbill, credit, other } = await liquidityFixture();

    await faucet.connect(other).claim();
    expect(await usdc.balanceOf(other.address)).to.equal(USDC(100_000));
    expect(await tbill.balanceOf(other.address)).to.equal(USDC(50_000));
    expect(await credit.balanceOf(other.address)).to.equal(ethers.parseUnits("25000", 18));

    await expect(faucet.connect(other).claim()).to.be.revertedWithCustomError(faucet, "CooldownActive");
    await time.increase(86401);
    await faucet.connect(other).claim();
    expect(await usdc.balanceOf(other.address)).to.equal(USDC(200_000));
  });
});

describe("Integration — cash sourced and parked fully on-chain", function () {
  it("faucet → lend (cash parks in venue) → borrow → repay → exit with yield", async function () {
    const { market, usdc, tbill, vault, faucet, other, borrower, lenderA } = await liquidityFixture();

    // Fresh user self-onboards from the faucet and lends.
    await faucet.connect(other).claim();
    await usdc.connect(other).approve(market, ethers.MaxUint256);
    await market.connect(other).deposit(TERM.OVERNIGHT, USDC(100_000));
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(400_000));

    // All cash sits in the external venue, not the market.
    expect(await usdc.balanceOf(market)).to.equal(0n);
    expect(await vault.convertToAssets(await vault.balanceOf(market))).to.equal(USDC(500_000));

    // A desk finances T-bills; cash is recalled from the venue on demand.
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(400_000), USDC(350_000));
    const repo = await market.getRepo(0);
    await time.setNextBlockTimestamp(BigInt(repo.openedAt) + DURATION[TERM.OVERNIGHT]);
    await market.connect(borrower).closeRepo(0);

    // The fresh user exits with principal + their pro-rata interest share.
    const shares = await market.sharesOf(TERM.OVERNIGHT, other.address);
    const before = await usdc.balanceOf(other.address);
    await market.connect(other).withdraw(TERM.OVERNIGHT, shares);
    expect((await usdc.balanceOf(other.address)) - before).to.be.gt(USDC(100_000));
  });
});
