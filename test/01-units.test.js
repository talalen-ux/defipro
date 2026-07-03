const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFixture, TERM, RATE_PARAMS, modelRate, USDC, WAD } = require("./fixtures");

describe("CollateralRegistry", function () {
  it("prices collateral through its feed, normalizing decimals", async function () {
    const { registry, tbill, credit } = await loadFixture(deployFixture);
    // 1000 tBILL (6 dec) at $1.05 => $1050
    expect(await registry.usdValueOf(tbill, USDC(1000))).to.equal(WAD(1050));
    // 1000 tCRED (18 dec) at $0.98 => $980
    expect(await registry.usdValueOf(credit, WAD(1000))).to.equal(WAD(980));
  });

  it("reverts on unlisted tokens and stale or zero prices", async function () {
    const { registry, usdc, tbill, tbillFeed } = await loadFixture(deployFixture);
    await expect(registry.usdValueOf(usdc, 1n)).to.be.revertedWithCustomError(registry, "NotListed");

    await tbillFeed.setUpdatedAt((await time.latest()) - 86401);
    await expect(registry.usdValueOf(tbill, 1n)).to.be.revertedWithCustomError(registry, "StalePrice");

    await tbillFeed.setPrice(0);
    await expect(registry.usdValueOf(tbill, 1n)).to.be.revertedWithCustomError(registry, "InvalidPrice");
  });

  it("rejects invalid risk parameters", async function () {
    const { registry, tbill, tbillFeed } = await loadFixture(deployFixture);
    // advance >= maintenance
    await expect(
      registry.setCollateral(tbill, true, 9900, 9900, 100, 86400, tbillFeed, 0)
    ).to.be.revertedWithCustomError(registry, "InvalidParams");
    // maintenance > 100%
    await expect(
      registry.setCollateral(tbill, true, 9800, 10001, 100, 86400, tbillFeed, 0)
    ).to.be.revertedWithCustomError(registry, "InvalidParams");
  });

  it("only owner can list or toggle collateral", async function () {
    const { registry, tbill, tbillFeed, other } = await loadFixture(deployFixture);
    await expect(
      registry.connect(other).setCollateral(tbill, true, 9800, 9900, 100, 86400, tbillFeed, 0)
    ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    await expect(registry.connect(other).setEnabled(tbill, false)).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
  });
});

describe("KinkedRateModel", function () {
  it("matches the reference curve below, at, and above the kink", async function () {
    const { model } = await loadFixture(deployFixture);
    for (const util of [0n, 1000n, 5000n, 8500n, 9000n, 10000n]) {
      expect(await model.rateFor(TERM.OVERNIGHT, util)).to.equal(modelRate(TERM.OVERNIGHT, util));
    }
    // Spot values: base at 0%, base+slope1 at kink, full stack at 100%.
    const p = RATE_PARAMS[TERM.OVERNIGHT];
    expect(await model.rateFor(TERM.OVERNIGHT, 0)).to.equal(p.baseRateBps);
    expect(await model.rateFor(TERM.OVERNIGHT, p.kinkBps)).to.equal(p.baseRateBps + p.slope1Bps);
    expect(await model.rateFor(TERM.OVERNIGHT, 10000)).to.equal(
      p.baseRateBps + p.slope1Bps + p.slope2Bps
    );
  });

  it("reverts on unset terms and utilization > 100%", async function () {
    const { model } = await loadFixture(deployFixture);
    await expect(model.rateFor(7, 5000)).to.be.revertedWithCustomError(model, "ParamsNotSet");
    await expect(model.rateFor(TERM.OVERNIGHT, 10001)).to.be.revertedWithCustomError(
      model,
      "InvalidUtilization"
    );
  });
});

describe("MeridianRateOracle", function () {
  it("only the market can record", async function () {
    const { oracle, other } = await loadFixture(deployFixture);
    await expect(oracle.connect(other).record(0, 400)).to.be.revertedWithCustomError(
      oracle,
      "OnlyMarket"
    );
  });

  it("computes a time-weighted average rate across rate changes", async function () {
    const { oracle, owner, other } = await loadFixture(deployFixture);
    // Point the oracle at an EOA so we can push observations directly.
    await oracle.setMarket(other.address);
    const o = oracle.connect(other);

    const t0 = (await time.latest()) + 10;
    await time.setNextBlockTimestamp(t0);
    await o.record(0, 400); // 400 bps live from t0

    await time.setNextBlockTimestamp(t0 + 100);
    await o.record(0, 800); // 800 bps live from t0+100

    await time.increaseTo(t0 + 200);
    // Window covering [t0, t0+200]: 100s @ 400 + 100s @ 800 = 600 avg
    expect(await oracle.twar(0, 200)).to.equal(600n);
    // Window covering [t0+150, t0+200]: all @ 800
    expect(await oracle.twar(0, 50)).to.equal(800n);
    // Window longer than history clamps to first observation.
    expect(await oracle.twar(0, 100000)).to.equal(600n);

    const [rate] = await oracle.currentRate(0);
    expect(rate).to.equal(800n);
  });

  it("reverts when there is no history", async function () {
    const { oracle } = await loadFixture(deployFixture);
    await expect(oracle.twar(2, 100)).to.be.revertedWithCustomError(oracle, "NoHistory");
    await expect(oracle.currentRate(2)).to.be.revertedWithCustomError(oracle, "NoHistory");
  });
});
