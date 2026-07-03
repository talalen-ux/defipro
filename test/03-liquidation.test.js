const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  deployFixture,
  TERM,
  DURATION,
  interestFor,
  BPS,
  USDC,
  WAD,
} = require("./fixtures");

describe("RepoMarket — liquidation", function () {
  async function openedRepoFixture() {
    const ctx = await loadFixture(deployFixture);
    const { market, lenderA, borrower, credit } = ctx;
    await market.connect(lenderA).deposit(TERM.MONTHLY, USDC(1_000_000));
    // 100,000 tCRED at $0.98 = $98,000 value; borrow 80,000 (advance max 83,300).
    await market.connect(borrower).openRepo(TERM.MONTHLY, credit, WAD(100_000), USDC(80_000));
    return ctx;
  }

  it("is not liquidatable while healthy and within term", async function () {
    const { market, liquidator } = await openedRepoFixture();
    expect(await market.isLiquidatable(0)).to.equal(false);
    await expect(market.connect(liquidator).liquidate(0)).to.be.revertedWithCustomError(
      market,
      "NotLiquidatable"
    );
  });

  it("liquidates on margin breach after a price drop, borrower keeps the remainder", async function () {
    const { market, usdc, credit, creditFeed, borrower, liquidator } = await openedRepoFixture();

    // Maintenance is 92%: debt 80k becomes liquidatable when collateral
    // value < 80k/0.92 ≈ 86,956. Drop tCRED to $0.85 => value 85,000.
    await creditFeed.setPrice(WAD("0.85"));
    expect(await market.isLiquidatable(0)).to.equal(true);

    const debt = await market.currentDebt(0);
    const liqUsdcBefore = await usdc.balanceOf(liquidator.address);
    const borrowerCreditBefore = await credit.balanceOf(borrower.address);

    const tx = await market.connect(liquidator).liquidate(0);
    const rc = await tx.wait();
    const ev = rc.logs
      .map((l) => { try { return market.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "RepoLiquidated");

    const repaid = ev.args.repaid;
    const seized = ev.args.collateralSeized;
    expect(ev.args.badDebt).to.equal(0n);
    // Debt accrues by the second; the event repaid is >= the pre-tx quote.
    expect(repaid).to.be.gte(debt);

    // Liquidator paid the debt and received collateral worth debt * 1.05
    // (5% penalty) at $0.85.
    expect(liqUsdcBefore - (await usdc.balanceOf(liquidator.address))).to.equal(repaid);
    const seizeValueUsdc = (seized * ethers.parseUnits("0.85", 18)) / 10n ** 18n / 10n ** 12n;
    expect(seizeValueUsdc).to.be.closeTo((repaid * (BPS + 500n)) / BPS, 10n);

    // Borrower got back everything not seized.
    expect((await credit.balanceOf(borrower.address)) - borrowerCreditBefore).to.equal(
      WAD(100_000) - seized
    );
    expect(await market.isLiquidatable(0)).to.equal(false);
    expect(await market.currentDebt(0)).to.equal(0n);
  });

  it("liquidates after maturity + grace even when fully collateralized", async function () {
    const { market, liquidator, creditFeed } = await openedRepoFixture();
    const repo = await market.getRepo(0);

    // Just past maturity but inside grace: not yet liquidatable. The feed
    // must be fresh for the margin check (keeper behavior).
    await time.increaseTo(BigInt(repo.maturity) + 99n);
    await creditFeed.setPrice(WAD("0.98"));
    expect(await market.isLiquidatable(0)).to.equal(false);

    await time.increaseTo(BigInt(repo.maturity) + 86400n);
    await creditFeed.setPrice(WAD("0.98"));
    expect(await market.isLiquidatable(0)).to.equal(true);
    await expect(market.connect(liquidator).liquidate(0)).to.emit(market, "RepoLiquidated");
  });

  it("socializes bad debt to the pool when collateral can't cover", async function () {
    const { market, lenderA, creditFeed, liquidator, treasury, usdc } = await openedRepoFixture();

    const assetsBefore = await market.balanceOfAssets(TERM.MONTHLY, lenderA.address);
    const treasuryBefore = await usdc.balanceOf(treasury.address);

    // Crash tCRED 50%: collateral value 49,000 vs debt ~80,000.
    await creditFeed.setPrice(WAD("0.49"));
    expect(await market.isLiquidatable(0)).to.equal(true);

    const tx = await market.connect(liquidator).liquidate(0);
    const rc = await tx.wait();
    const ev = rc.logs
      .map((l) => { try { return market.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "RepoLiquidated");

    // All collateral seized at the penalty discount; shortfall recorded.
    expect(ev.args.collateralSeized).to.equal(WAD(100_000));
    const expectedRepaid = (USDC(49_000) * BPS) / (BPS + 500n);
    expect(ev.args.repaid).to.be.closeTo(expectedRepaid, USDC(1));
    expect(ev.args.badDebt).to.be.gt(0n);

    // No protocol fee on a loss; the pool takes the writedown. The pool's
    // loss is the principal shortfall (accrued interest was never a pool
    // asset, so it isn't part of the writedown).
    expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
    const assetsAfter = await market.balanceOfAssets(TERM.MONTHLY, lenderA.address);
    expect(assetsBefore - assetsAfter).to.be.closeTo(USDC(80_000) - ev.args.repaid, 5n);

    // Pool stays solvent and operational: utilization back to 0.
    const [, principalOutstanding, , util] = await market.getPool(TERM.MONTHLY);
    expect(principalOutstanding).to.equal(0n);
    expect(util).to.equal(0n);
  });

  it("blocks rolling an unhealthy repo", async function () {
    const { market, creditFeed, borrower } = await openedRepoFixture();
    await creditFeed.setPrice(WAD("0.85"));
    await expect(market.connect(borrower).rollRepo(0)).to.be.revertedWithCustomError(
      market,
      "RepoUnhealthy"
    );
  });
});

describe("RepoMarket — MOR benchmark integration", function () {
  it("publishes utilization-driven overnight prints and a sane TWAR", async function () {
    const { market, oracle, lenderA, borrower, tbill } = await loadFixture(deployFixture);

    const t0 = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(t0);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000)); // util 0 => base rate
    let [rate] = await oracle.currentRate(TERM.OVERNIGHT);
    expect(rate).to.equal(300n);

    await time.setNextBlockTimestamp(t0 + 1000);
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1_000_000), USDC(850_000));
    [rate] = await oracle.currentRate(TERM.OVERNIGHT);
    expect(rate).to.equal(500n); // exactly at the kink: base 300 + slope1 200

    // Half the window at 300, half at 500 => TWAR 400.
    await time.increaseTo(t0 + 2000);
    expect(await oracle.twar(TERM.OVERNIGHT, 2000)).to.equal(400n);

    // Repayment relaxes the print back toward base.
    await market.connect(borrower).closeRepo(0);
    [rate] = await oracle.currentRate(TERM.OVERNIGHT);
    expect(rate).to.equal(300n);
  });

  it("records each term pool independently", async function () {
    const { market, oracle, lenderA } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.QUARTERLY, USDC(1000));
    const [q] = await oracle.currentRate(TERM.QUARTERLY);
    expect(q).to.equal(400n); // quarterly base rate
    await expect(oracle.currentRate(TERM.OVERNIGHT)).to.be.revertedWithCustomError(
      oracle,
      "NoHistory"
    );
  });
});
