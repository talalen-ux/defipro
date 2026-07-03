/**
 * End-to-end simulation on the in-process Hardhat network: a week in the
 * life of the Meridian repo market. Lenders fund term pools, an RWA desk
 * finances tokenized T-bills overnight and rolls daily, a credit fund takes
 * 30-day money, a price shock triggers a liquidation, and the script prints
 * the MOR benchmark (live print + trailing TWAR) as it evolves.
 *
 * Run: npx hardhat run scripts/demo.js
 */
const { ethers, network } = require("hardhat");
const { main: deploy } = require("./deploy");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const WAD = (n) => ethers.parseUnits(n.toString(), 18);
const fmtUSDC = (v) => `$${Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const fmtRate = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;

const OVERNIGHT = 0;
const MONTHLY = 2;

async function warp(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function printMOR(oracle, label) {
  const [rate] = await oracle.currentRate(OVERNIGHT);
  let twar1d = "n/a";
  try {
    twar1d = fmtRate(await oracle.twar(OVERNIGHT, 86400));
  } catch {}
  console.log(`  MOR ${label}: live ${fmtRate(rate)} | 1d TWAR ${twar1d}`);
}

async function main() {
  console.log("=== Meridian demo: a week in the repo market ===\n");
  const { usdc, tbill, credit, tbillFeed, creditFeed, oracle, market } = await deploy();
  const [deployer, lenderA, lenderB, rwaDesk, creditFund, liquidator] = await ethers.getSigners();

  // Fund actors.
  for (const u of [lenderA, lenderB, rwaDesk, creditFund, liquidator]) {
    await usdc.mint(u.address, USDC(50_000_000));
    await usdc.connect(u).approve(market, ethers.MaxUint256);
  }
  await tbill.mint(rwaDesk.address, USDC(20_000_000));
  await tbill.connect(rwaDesk).approve(market, ethers.MaxUint256);
  await credit.mint(creditFund.address, WAD(5_000_000));
  await credit.connect(creditFund).approve(market, ethers.MaxUint256);

  console.log("\n--- Day 0: lenders fund the term pools ---");
  await market.connect(lenderA).deposit(OVERNIGHT, USDC(10_000_000));
  await market.connect(lenderB).deposit(OVERNIGHT, USDC(5_000_000));
  await market.connect(lenderA).deposit(MONTHLY, USDC(5_000_000));
  console.log("  lenderA: $10M overnight + $5M 30-day | lenderB: $5M overnight");
  await printMOR(oracle, "after funding");

  console.log("\n--- Day 0: an RWA desk finances $12.6M of tokenized T-bills overnight ---");
  // 12,600,000 tBILL @ $1.05 = $13.23M value; borrow $12.6M (advance limit ~$12.97M).
  await market.connect(rwaDesk).openRepo(OVERNIGHT, tbill, USDC(12_600_000), USDC(12_600_000));
  let repo = await market.getRepo(0);
  console.log(`  repo #0 locked at ${fmtRate(repo.rateBps)} for 1 day (utilization-priced)`);
  await printMOR(oracle, "after the draw");

  console.log("\n--- Day 0: a credit fund takes 30-day money against private credit ---");
  await market.connect(creditFund).openRepo(MONTHLY, credit, WAD(3_000_000), USDC(2_400_000));
  repo = await market.getRepo(1);
  console.log(`  repo #1: $2.4M for 30d at ${fmtRate(repo.rateBps)} vs $2.94M tCRED (85% advance)`);

  console.log("\n--- Days 1-3: the desk rolls its overnight book daily ---");
  for (let day = 1; day <= 3; day++) {
    await warp(86000); // just inside the 1-day term
    await tbillFeed.setPrice(WAD("1.05")); // keeper keeps the feed fresh
    await creditFeed.setPrice(WAD("0.98"));
    const before = await usdc.balanceOf(rwaDesk.address);
    await market.connect(rwaDesk).rollRepo(0);
    const paid = before - (await usdc.balanceOf(rwaDesk.address));
    repo = await market.getRepo(0);
    console.log(`  day ${day}: rolled at ${fmtRate(repo.rateBps)}, interest settled ${fmtUSDC(paid)}`);
  }
  await printMOR(oracle, "after three rolls");

  console.log("\n--- Day 4: rate spike — a second desk drains the overnight pool ---");
  await tbill.mint(creditFund.address, USDC(3_000_000));
  await tbill.connect(creditFund).approve(market, ethers.MaxUint256);
  await market.connect(creditFund).openRepo(OVERNIGHT, tbill, USDC(2_400_000), USDC(2_300_000));
  await printMOR(oracle, "at high utilization");

  console.log("\n--- Day 4: private credit reprices 12% down; repo #1 breaches maintenance ---");
  await creditFeed.setPrice(WAD("0.8624"));
  console.log(`  repo #1 liquidatable: ${await market.isLiquidatable(1)}`);
  const debt = await market.currentDebt(1);
  await market.connect(liquidator).liquidate(1);
  console.log(`  liquidator covered ${fmtUSDC(debt)} debt, seized tCRED at a 5% discount;`);
  console.log("  the credit fund got the remaining collateral back, lenders stayed whole");

  console.log("\n--- Day 7: the desk unwinds; lenders harvest ---");
  await warp(3 * 86000);
  await tbillFeed.setPrice(WAD("1.05"));
  await market.connect(rwaDesk).closeRepo(0);
  await market.connect(creditFund).closeRepo(2);

  const aAssets = await market.balanceOfAssets(OVERNIGHT, lenderA.address);
  const bAssets = await market.balanceOfAssets(OVERNIGHT, lenderB.address);
  console.log(`  lenderA overnight balance: ${fmtUSDC(aAssets)} (from $10M)`);
  console.log(`  lenderB overnight balance: ${fmtUSDC(bAssets)} (from $5M)`);
  console.log(`  protocol treasury earned:  ${fmtUSDC(await usdc.balanceOf(deployer.address))}`);
  await printMOR(oracle, "end of week");

  console.log("\n=== Demo complete: fixed-term financing, live MOR prints, a margin ===");
  console.log("=== liquidation, and pro-rata lender yield — all on-chain.         ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
