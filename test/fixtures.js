const { ethers } = require("hardhat");

const BPS = 10_000n;
const YEAR = 365n * 24n * 60n * 60n;
const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const WAD = (n) => ethers.parseUnits(n.toString(), 18);

const TERM = { OVERNIGHT: 0, WEEKLY: 1, MONTHLY: 2, QUARTERLY: 3 };
const DURATION = {
  [TERM.OVERNIGHT]: 86400n,
  [TERM.WEEKLY]: 7n * 86400n,
  [TERM.MONTHLY]: 30n * 86400n,
  [TERM.QUARTERLY]: 90n * 86400n,
};

const RATE_PARAMS = {
  [TERM.OVERNIGHT]: { baseRateBps: 300n, slope1Bps: 200n, slope2Bps: 4000n, kinkBps: 8500n },
  [TERM.WEEKLY]: { baseRateBps: 320n, slope1Bps: 220n, slope2Bps: 4000n, kinkBps: 8500n },
  [TERM.MONTHLY]: { baseRateBps: 350n, slope1Bps: 250n, slope2Bps: 4000n, kinkBps: 8500n },
  [TERM.QUARTERLY]: { baseRateBps: 400n, slope1Bps: 300n, slope2Bps: 4000n, kinkBps: 8500n },
};

// Mirrors KinkedRateModel.rateFor
function modelRate(term, utilBps) {
  const p = RATE_PARAMS[term];
  if (utilBps <= p.kinkBps) return p.baseRateBps + (p.slope1Bps * utilBps) / p.kinkBps;
  return p.baseRateBps + p.slope1Bps + (p.slope2Bps * (utilBps - p.kinkBps)) / (BPS - p.kinkBps);
}

// Mirrors RepoMarket.accruedInterest
function interestFor(principal, rateBps, elapsed, termDur, lateFeeBps = 500n) {
  const inTerm = elapsed < termDur ? elapsed : termDur;
  let interest = (principal * rateBps * inTerm) / (YEAR * BPS);
  if (elapsed > termDur) {
    interest += (principal * (rateBps + lateFeeBps) * (elapsed - termDur)) / (YEAR * BPS);
  }
  return interest;
}

async function deployFixture() {
  const [owner, treasury, lenderA, lenderB, borrower, liquidator, other] = await ethers.getSigners();

  const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const tbill = await ethers.deployContract("MockTokenizedTreasury", [
    "Tokenized T-Bill Fund",
    "tBILL",
    6,
    owner.address,
    5n * 86400n, // 5-day off-chain redemption delay
  ]);
  const credit = await ethers.deployContract("MockERC20", ["Tokenized Private Credit", "tCRED", 18]);

  const tbillFeed = await ethers.deployContract("MockPriceFeed", [WAD("1.05")]);
  const creditFeed = await ethers.deployContract("MockPriceFeed", [WAD("0.98")]);

  const registry = await ethers.deployContract("CollateralRegistry", [owner.address]);
  await registry.setCollateral(tbill, true, 9800, 9900, 100, 86400, tbillFeed, 0);
  await registry.setCollateral(credit, true, 8500, 9200, 500, 86400, creditFeed, WAD("1000000"));

  const model = await ethers.deployContract("KinkedRateModel", [owner.address]);
  for (const term of Object.values(TERM)) {
    const p = RATE_PARAMS[term];
    await model.setParams(term, [p.baseRateBps, p.slope1Bps, p.slope2Bps, p.kinkBps]);
  }

  const oracle = await ethers.deployContract("MeridianRateOracle", [owner.address]);

  const market = await ethers.deployContract("RepoMarket", [
    owner.address,
    usdc,
    registry,
    model,
    oracle,
    treasury.address,
  ]);
  await oracle.setMarket(market);

  // Funding + blanket approvals for test convenience.
  for (const u of [lenderA, lenderB, borrower, liquidator]) {
    await usdc.mint(u.address, USDC(10_000_000));
    await usdc.connect(u).approve(market, ethers.MaxUint256);
  }
  await tbill.mint(borrower.address, USDC(10_000_000)); // 6 decimals
  await tbill.connect(borrower).approve(market, ethers.MaxUint256);
  await credit.mint(borrower.address, WAD(1_000_000));
  await credit.connect(borrower).approve(market, ethers.MaxUint256);

  return {
    owner,
    treasury,
    lenderA,
    lenderB,
    borrower,
    liquidator,
    other,
    usdc,
    tbill,
    credit,
    tbillFeed,
    creditFeed,
    registry,
    model,
    oracle,
    market,
  };
}

module.exports = { deployFixture, TERM, DURATION, RATE_PARAMS, modelRate, interestFor, BPS, YEAR, USDC, WAD };
