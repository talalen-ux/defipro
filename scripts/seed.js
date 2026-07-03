/**
 * Seeds a localhost deployment with demo liquidity and positions so the
 * frontend has live data. Run after deploy, against a running node:
 *
 *   npx hardhat node
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/seed.js --network localhost
 */
const { ethers } = require("hardhat");
const deployment = require("../app/src/deployment.json");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const WAD = (n) => ethers.parseUnits(n.toString(), 18);
const OVERNIGHT = 0;
const WEEKLY = 1;
const MONTHLY = 2;

async function main() {
  const [deployer, lenderA, lenderB, rwaDesk, creditFund] = await ethers.getSigners();
  const market = await ethers.getContractAt("RepoMarket", deployment.contracts.RepoMarket);
  const usdc = await ethers.getContractAt("MockERC20", deployment.stable.address);
  const tbill = await ethers.getContractAt("MockERC20", deployment.collateral[0].address);
  const credit = await ethers.getContractAt("MockERC20", deployment.collateral[1].address);

  console.log("Funding demo accounts...");
  for (const u of [deployer, lenderA, lenderB, rwaDesk, creditFund]) {
    await (await usdc.mint(u.address, USDC(20_000_000))).wait();
    await (await usdc.connect(u).approve(market, ethers.MaxUint256)).wait();
  }
  for (const u of [deployer, rwaDesk, creditFund]) {
    await (await tbill.mint(u.address, USDC(10_000_000))).wait();
    await (await tbill.connect(u).approve(market, ethers.MaxUint256)).wait();
    await (await credit.mint(u.address, WAD(2_000_000))).wait();
    await (await credit.connect(u).approve(market, ethers.MaxUint256)).wait();
  }

  console.log("Lenders fund the term pools...");
  await (await market.connect(lenderA).deposit(OVERNIGHT, USDC(8_000_000))).wait();
  await (await market.connect(lenderB).deposit(OVERNIGHT, USDC(4_000_000))).wait();
  await (await market.connect(lenderA).deposit(WEEKLY, USDC(3_000_000))).wait();
  await (await market.connect(lenderB).deposit(MONTHLY, USDC(5_000_000))).wait();

  console.log("Desks open repos...");
  await (await market.connect(rwaDesk).openRepo(OVERNIGHT, tbill, USDC(7_000_000), USDC(6_800_000))).wait();
  await (await market.connect(creditFund).openRepo(MONTHLY, credit, WAD(1_500_000), USDC(1_200_000))).wait();
  await (await market.connect(rwaDesk).openRepo(WEEKLY, tbill, USDC(1_000_000), USDC(950_000))).wait();

  console.log("\nSeeded. Demo accounts (hardhat defaults):");
  console.log(`  #0 deployer/treasury  ${deployer.address}`);
  console.log(`  #1 lenderA            ${lenderA.address}`);
  console.log(`  #2 lenderB            ${lenderB.address}`);
  console.log(`  #3 RWA desk           ${rwaDesk.address}`);
  console.log(`  #4 credit fund        ${creditFund.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
