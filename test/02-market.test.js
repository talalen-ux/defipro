const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  deployFixture,
  TERM,
  DURATION,
  modelRate,
  interestFor,
  BPS,
  USDC,
  WAD,
} = require("./fixtures");

describe("RepoMarket — lender side", function () {
  it("mints shares on deposit and redeems them for cash", async function () {
    const { market, usdc, lenderA } = await loadFixture(deployFixture);
    const amount = USDC(1_000_000);

    await expect(market.connect(lenderA).deposit(TERM.OVERNIGHT, amount))
      .to.emit(market, "Deposited");

    const [cash, principal, totalShares, util] = await market.getPool(TERM.OVERNIGHT);
    expect(cash).to.equal(amount);
    expect(principal).to.equal(0n);
    expect(util).to.equal(0n);
    expect(await market.balanceOfAssets(TERM.OVERNIGHT, lenderA.address)).to.be.closeTo(amount, 2n);

    const shares = await market.sharesOf(TERM.OVERNIGHT, lenderA.address);
    expect(shares).to.equal(totalShares);

    const balBefore = await usdc.balanceOf(lenderA.address);
    await market.connect(lenderA).withdraw(TERM.OVERNIGHT, shares);
    expect((await usdc.balanceOf(lenderA.address)) - balBefore).to.be.closeTo(amount, 2n);
  });

  it("blocks withdrawing more than idle cash while repos are out", async function () {
    const { market, lenderA, borrower, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000));
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1_000_000), USDC(900_000));

    const shares = await market.sharesOf(TERM.OVERNIGHT, lenderA.address);
    await expect(market.connect(lenderA).withdraw(TERM.OVERNIGHT, shares)).to.be.revertedWithCustomError(
      market,
      "InsufficientLiquidity"
    );
    // A partial withdrawal within idle cash works.
    await market.connect(lenderA).withdraw(TERM.OVERNIGHT, shares / 20n);
  });

  it("rejects zero amounts, bad terms, and over-redemption", async function () {
    const { market, lenderA } = await loadFixture(deployFixture);
    await expect(market.connect(lenderA).deposit(TERM.OVERNIGHT, 0)).to.be.revertedWithCustomError(
      market,
      "ZeroAmount"
    );
    await expect(market.connect(lenderA).deposit(4, 1)).to.be.revertedWithCustomError(
      market,
      "InvalidTerm"
    );
    await expect(market.connect(lenderA).withdraw(TERM.OVERNIGHT, 1)).to.be.revertedWithCustomError(
      market,
      "InsufficientShares"
    );
  });

  it("pause blocks deposits and opens but never repay or withdraw", async function () {
    const { market, owner, lenderA, borrower, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(100_000));
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(50_000), USDC(40_000));

    await market.connect(owner).pause();
    await expect(market.connect(lenderA).deposit(TERM.OVERNIGHT, 1)).to.be.revertedWithCustomError(
      market,
      "EnforcedPause"
    );
    await expect(
      market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1000), USDC(500))
    ).to.be.revertedWithCustomError(market, "EnforcedPause");
    await expect(market.connect(borrower).rollRepo(0)).to.be.revertedWithCustomError(
      market,
      "EnforcedPause"
    );

    // Exit paths stay open.
    await market.connect(borrower).closeRepo(0);
    const shares = await market.sharesOf(TERM.OVERNIGHT, lenderA.address);
    await market.connect(lenderA).withdraw(TERM.OVERNIGHT, shares / 2n);
  });
});

describe("RepoMarket — repo lifecycle", function () {
  it("opens a repo at the post-borrow marginal rate and enforces the advance rate", async function () {
    const { market, oracle, lenderA, borrower, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000));

    // 1,000,000 tBILL at $1.05 = $1,050,000; advance rate 98% => max 1,029,000.
    await expect(
      market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1_000_000), USDC("1029000.000001"))
    ).to.be.revertedWithCustomError(market, "ExceedsAdvanceRate");

    // Borrow 500k => utilization 50% => locked rate from the curve.
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1_000_000), USDC(500_000));
    const repo = await market.getRepo(0);
    const expectedRate = modelRate(TERM.OVERNIGHT, 5000n);
    expect(repo.rateBps).to.equal(expectedRate);
    expect(repo.maturity - repo.openedAt).to.equal(DURATION[TERM.OVERNIGHT]);

    // The oracle saw the same marginal rate (MOR print).
    const [morRate] = await oracle.currentRate(TERM.OVERNIGHT);
    expect(morRate).to.equal(expectedRate);
  });

  it("accrues pro-rata interest and splits the protocol fee on close", async function () {
    const { market, usdc, treasury, lenderA, borrower, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.MONTHLY, USDC(1_000_000));
    await market.connect(borrower).openRepo(TERM.MONTHLY, tbill, USDC(500_000), USDC(400_000));

    const repo = await market.getRepo(0);
    const closeTime = BigInt(repo.openedAt) + DURATION[TERM.MONTHLY]; // exactly at maturity
    await time.setNextBlockTimestamp(closeTime);

    const principal = USDC(400_000);
    const interest = interestFor(principal, repo.rateBps, DURATION[TERM.MONTHLY], DURATION[TERM.MONTHLY]);
    const fee = (interest * 1000n) / BPS;

    const borrowerBefore = await usdc.balanceOf(borrower.address);
    const tbillBefore = await (await ethers.getContractAt("MockERC20", tbill)).balanceOf(borrower.address);

    await expect(market.connect(borrower).closeRepo(0))
      .to.emit(market, "RepoClosed")
      .withArgs(0, principal, interest, fee);

    expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
    expect(borrowerBefore - (await usdc.balanceOf(borrower.address))).to.equal(principal + interest);

    // Collateral returned in full.
    const tbillAfter = await (await ethers.getContractAt("MockERC20", tbill)).balanceOf(borrower.address);
    expect(tbillAfter - tbillBefore).to.equal(USDC(500_000));

    // Lender share price appreciated by the pool's interest cut.
    expect(await market.balanceOfAssets(TERM.MONTHLY, lenderA.address)).to.be.closeTo(
      USDC(1_000_000) + interest - fee,
      2n
    );
  });

  it("charges the late-fee rate past maturity", async function () {
    const { market, borrower, lenderA, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000));
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(500_000), USDC(400_000));

    const repo = await market.getRepo(0);
    const late = 3600n; // one hour past maturity
    const checkTime = BigInt(repo.openedAt) + DURATION[TERM.OVERNIGHT] + late;
    await time.increaseTo(checkTime);

    const expected = interestFor(
      USDC(400_000),
      repo.rateBps,
      DURATION[TERM.OVERNIGHT] + late,
      DURATION[TERM.OVERNIGHT]
    );
    expect(await market.accruedInterest(0)).to.equal(expected);
  });

  it("rolls a healthy repo: interest settles, rate and maturity refresh", async function () {
    const { market, usdc, treasury, lenderA, borrower, tbill, tbillFeed } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.WEEKLY, USDC(1_000_000));
    await market.connect(borrower).openRepo(TERM.WEEKLY, tbill, USDC(500_000), USDC(400_000));

    const repo = await market.getRepo(0);
    const rollTime = BigInt(repo.openedAt) + DURATION[TERM.WEEKLY] / 2n;
    // Keep the price feed fresh across the warp (keeper behavior).
    await time.setNextBlockTimestamp(rollTime - 5n);
    await tbillFeed.setPrice(ethers.parseUnits("1.05", 18));
    await time.setNextBlockTimestamp(rollTime);

    const interest = interestFor(USDC(400_000), repo.rateBps, DURATION[TERM.WEEKLY] / 2n, DURATION[TERM.WEEKLY]);
    const fee = (interest * 1000n) / BPS;

    await expect(market.connect(borrower).rollRepo(0)).to.emit(market, "RepoRolled");

    const rolled = await market.getRepo(0);
    expect(rolled.openedAt).to.equal(rollTime);
    expect(BigInt(rolled.maturity)).to.equal(rollTime + DURATION[TERM.WEEKLY]);
    expect(rolled.principal).to.equal(USDC(400_000));
    expect(await usdc.balanceOf(treasury.address)).to.equal(fee);

    // Only the borrower can roll; nobody can roll past maturity.
    await expect(market.connect(lenderA).rollRepo(0)).to.be.revertedWithCustomError(market, "NotBorrower");
    await time.increaseTo(BigInt(rolled.maturity));
    await expect(market.connect(borrower).rollRepo(0)).to.be.revertedWithCustomError(market, "RepoMatured");
  });

  it("anyone may repay on the borrower's behalf; collateral still returns to the borrower", async function () {
    const { market, lenderB, borrower, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderB).deposit(TERM.OVERNIGHT, USDC(500_000));
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(200_000), USDC(100_000));

    const t = await ethers.getContractAt("MockERC20", tbill);
    const before = await t.balanceOf(borrower.address);
    await market.connect(lenderB).closeRepo(0); // third party repays
    expect((await t.balanceOf(borrower.address)) - before).to.equal(USDC(200_000));
    await expect(market.connect(lenderB).closeRepo(0)).to.be.revertedWithCustomError(
      market,
      "RepoNotActive"
    );
  });

  it("enforces collateral gating: enabled flag, supply cap, min borrow, pool liquidity", async function () {
    const { market, registry, owner, lenderA, borrower, tbill, credit } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(1_000_000));

    await expect(
      market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1000), 100)
    ).to.be.revertedWithCustomError(market, "BelowMinBorrow");

    await registry.connect(owner).setEnabled(tbill, false);
    await expect(
      market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(1000), USDC(500))
    ).to.be.revertedWithCustomError(market, "CollateralNotEnabled");
    await registry.connect(owner).setEnabled(tbill, true);

    // tCRED cap is 1,000,000 units.
    await expect(
      market.connect(borrower).openRepo(TERM.OVERNIGHT, credit, WAD("1000001"), USDC(500_000))
    ).to.be.revertedWithCustomError(market, "SupplyCapExceeded");

    await expect(
      market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(3_000_000), USDC(2_000_000))
    ).to.be.revertedWithCustomError(market, "InsufficientLiquidity");
  });

  it("handles 18-decimal collateral against the 6-decimal cash asset", async function () {
    const { market, lenderA, borrower, credit } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.MONTHLY, USDC(1_000_000));

    // 100,000 tCRED at $0.98 = $98,000; advance 85% => max 83,300 USDC.
    await expect(
      market.connect(borrower).openRepo(TERM.MONTHLY, credit, WAD(100_000), USDC("83300.000001"))
    ).to.be.revertedWithCustomError(market, "ExceedsAdvanceRate");
    await market.connect(borrower).openRepo(TERM.MONTHLY, credit, WAD(100_000), USDC(83_300));

    const repo = await market.getRepo(0);
    expect(repo.collateralAmount).to.equal(WAD(100_000));
    expect(repo.principal).to.equal(USDC(83_300));
  });

  it("interest paid accrues to lenders pro-rata across two depositors", async function () {
    const { market, lenderA, lenderB, borrower, tbill } = await loadFixture(deployFixture);
    await market.connect(lenderA).deposit(TERM.OVERNIGHT, USDC(750_000));
    await market.connect(lenderB).deposit(TERM.OVERNIGHT, USDC(250_000));
    await market.connect(borrower).openRepo(TERM.OVERNIGHT, tbill, USDC(600_000), USDC(500_000));

    const repo = await market.getRepo(0);
    await time.setNextBlockTimestamp(BigInt(repo.openedAt) + DURATION[TERM.OVERNIGHT]);
    await market.connect(borrower).closeRepo(0);

    const interest = interestFor(USDC(500_000), repo.rateBps, DURATION[TERM.OVERNIGHT], DURATION[TERM.OVERNIGHT]);
    const poolGain = interest - (interest * 1000n) / BPS;

    const a = await market.balanceOfAssets(TERM.OVERNIGHT, lenderA.address);
    const b = await market.balanceOfAssets(TERM.OVERNIGHT, lenderB.address);
    expect(a).to.be.closeTo(USDC(750_000) + (poolGain * 3n) / 4n, 5n);
    expect(b).to.be.closeTo(USDC(250_000) + poolGain / 4n, 5n);
  });
});

describe("RepoMarket — admin", function () {
  it("bounds and applies parameter changes, owner-only", async function () {
    const { market, owner, other } = await loadFixture(deployFixture);
    await expect(market.connect(other).setProtocolFee(500)).to.be.revertedWithCustomError(
      market,
      "OwnableUnauthorizedAccount"
    );
    await expect(market.connect(owner).setProtocolFee(2001)).to.be.revertedWithCustomError(
      market,
      "InvalidParams"
    );
    await market.connect(owner).setProtocolFee(2000);
    expect(await market.protocolFeeBps()).to.equal(2000n);

    await expect(market.connect(owner).setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      market,
      "InvalidParams"
    );
    await market.connect(owner).setMinBorrow(USDC(100));
    expect(await market.minBorrow()).to.equal(USDC(100));
  });
});
