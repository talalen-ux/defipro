/**
 * A realistic, end-to-end yield scenario executed against the real
 * contracts (in-process chain). Prints actual on-chain numbers — nothing
 * hand-computed. Run: npx hardhat run scripts/yield-example.js
 *
 * Cast:
 * - A money-market fund lends $1,000,000 USDC into the 30-day pool.
 * - An RWA desk finances $550,000 of tokenized T-bills for 30 days.
 * - The reserve vault (stand-in for an Aave/Morpho USDC vault) earns 4%
 *   APY on the idle float.
 */
const { ethers, network } = require("hardhat");
const { main: deploy } = require("./deploy");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const fmt = (v) => "$" + Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (num, den) => `${((Number(num) / Number(den)) * 100).toFixed(3)}%`;
const MONTHLY = 2;
const DAYS30 = 30 * 86400;

async function main() {
  const { usdc, tbill, tbillFeed, market, protocolTreasury } = await deploy();
  const [, fund, desk] = await ethers.getSigners();
  const vaultAddr = await market.reserveVault();
  const vault = await ethers.getContractAt("MockYieldVault", vaultAddr);

  await usdc.mint(fund.address, USDC(1_000_000));
  await usdc.connect(fund).approve(market, ethers.MaxUint256);
  await tbill.mint(desk.address, USDC(600_000));
  await tbill.connect(desk).approve(market, ethers.MaxUint256);
  await usdc.mint(desk.address, USDC(50_000)); // for interest
  await usdc.connect(desk).approve(market, ethers.MaxUint256);

  console.log("=== Meridian yield example: one month in the 30-day pool ===\n");

  // 1. Fund lends $1M into the 30d pool.
  await market.connect(fund).deposit(MONTHLY, USDC(1_000_000));
  console.log(`Money-market fund lends ${fmt(USDC(1_000_000))} into the 30-day pool`);

  // 2. Desk finances $577.5k of tBILL (550,000 units @ $1.05) borrowing $550k.
  await market.connect(desk).openRepo(MONTHLY, tbill, USDC(550_000), USDC(550_000));
  const repo = await market.getRepo(0);
  const [, , , util] = await market.getPool(MONTHLY);
  console.log(
    `RWA desk posts 550,000 tBILL (worth ${fmt(USDC(577_500))}) and draws ${fmt(USDC(550_000))}`
  );
  console.log(`  pool utilization: ${Number(util) / 100}%  |  repo rate locked: ${Number(repo.rateBps) / 100}% for 30d\n`);

  // 3. The reserve vault earns ~4% APY on the idle float over the month.
  //    idle = $450k; 4% * 30/365 on that.
  const float = USDC(450_000);
  const floatYield = (float * 400n * BigInt(DAYS30)) / (365n * 86400n * 10_000n);
  await usdc.mint(vault, floatYield);

  // 4. 30 days pass; keeper refreshes the NAV feed; desk repays at maturity.
  await network.provider.send("evm_increaseTime", [DAYS30 - 10]);
  await tbillFeed.setPrice(ethers.parseUnits("1.05", 18));
  const closeTs = Number(repo.maturity);
  await network.provider.send("evm_setNextBlockTimestamp", [closeTs]);
  await market.connect(desk).closeRepo(0);

  const interest = USDC(550_000 + 50_000) - (await usdc.balanceOf(desk.address)) - USDC(550_000);
  console.log(`30 days later the desk repays principal + interest: ${fmt(interest)} interest paid`);

  // 5. Skim the float yield to the treasury.
  await market.skim();

  // 6. The fund exits completely.
  const shares = await market.sharesOf(MONTHLY, fund.address);
  await market.connect(fund).withdraw(MONTHLY, shares);
  const fundFinal = await usdc.balanceOf(fund.address);
  const earned = fundFinal - USDC(1_000_000);
  const treasuryIncome = await usdc.balanceOf(protocolTreasury);

  console.log("\n--- Results (real on-chain balances) ---");
  console.log(`Lender deposited:          ${fmt(USDC(1_000_000))}`);
  console.log(`Lender withdrew:           ${fmt(fundFinal)}`);
  console.log(`Lender earned (30d):       ${fmt(earned)}  (${pct(earned, USDC(1_000_000))} monthly)`);
  console.log(`Lender APY (simple ann.):  ${((Number(earned) / 1e12) * (365 / 30) * 100).toFixed(2)}%`);
  console.log(`Desk financing cost (30d): ${fmt(interest)} on ${fmt(USDC(550_000))} (${Number(repo.rateBps) / 100}% ann.)`);
  console.log(`Treasury income:           ${fmt(treasuryIncome)} (10% of interest + reserve-vault float yield)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
