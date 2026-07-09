/**
 * Captures a snapshot of the seeded localhost market into
 * app/src/demoData.json. The hosted frontend falls back to this snapshot
 * when no chain is reachable, so the dashboard is viewable anywhere.
 *
 *   npx hardhat run scripts/export-demo-data.js --network localhost
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const deployment = require("../app/src/deployment.json");

async function main() {
  const market = await ethers.getContractAt("RepoMarket", deployment.contracts.RepoMarket);
  const registry = await ethers.getContractAt("CollateralRegistry", deployment.contracts.CollateralRegistry);
  const model = await ethers.getContractAt("KinkedRateModel", deployment.contracts.KinkedRateModel);
  const oracle = await ethers.getContractAt("MeridianRateOracle", deployment.contracts.MeridianRateOracle);

  const pools = [];
  for (let term = 0; term < 4; term++) {
    const [cash, outstanding, totalShares, utilization] = await market.getPool(term);
    const liveRate = await model.rateFor(term, utilization);
    pools.push({ id: term, cash, outstanding, totalShares, utilization, liveRate });
  }

  let mor = null;
  try {
    const [rate, updatedAt] = await oracle.currentRate(0);
    let twar1d = null;
    try {
      twar1d = await oracle.twar(0, 86400);
    } catch {}
    mor = { rate, updatedAt, twar1d };
  } catch {}

  const history = [];
  for (const ev of await oracle.queryFilter(oracle.filters.RateRecorded(0), 0)) {
    const block = await ethers.provider.getBlock(ev.blockNumber);
    history.push({ t: block.timestamp, rate: ev.args.rateBps });
  }

  const collateralInfo = [];
  for (const c of deployment.collateral) {
    const cfg = await registry.getConfig(c.address);
    let unitPriceWad = null;
    try {
      unitPriceWad = await registry.usdValueOf(c.address, 10n ** BigInt(c.decimals));
    } catch {}
    collateralInfo.push({
      ...c,
      cfg: {
        advanceRateBps: Number(cfg.advanceRateBps),
        maintenanceRateBps: Number(cfg.maintenanceRateBps),
        liquidationPenaltyBps: Number(cfg.liquidationPenaltyBps),
      },
      unitPriceWad,
    });
  }

  const repos = [];
  for (const ev of await market.queryFilter(market.filters.RepoOpened(), 0)) {
    const id = ev.args.repoId;
    const repo = await market.getRepo(id);
    if (!repo.active) continue;
    const debt = await market.currentDebt(id);
    const liquidatable = await market.isLiquidatable(id).catch(() => false);
    let collateralValue = null;
    try {
      collateralValue = (await registry.usdValueOf(repo.collateralToken, repo.collateralAmount)) / 10n ** 12n;
    } catch {}
    repos.push({
      id,
      borrower: repo.borrower,
      collateralToken: repo.collateralToken,
      collateralAmount: repo.collateralAmount,
      principal: repo.principal,
      rateBps: repo.rateBps,
      openedAt: repo.openedAt,
      maturity: repo.maturity,
      term: Number(repo.term),
      debt,
      liquidatable,
      collateralValue,
    });
  }

  let reserve = null;
  if (deployment.contracts.ReserveVault) {
    const vault = await ethers.getContractAt("MockYieldVault", deployment.contracts.ReserveVault);
    reserve = {
      address: deployment.contracts.ReserveVault,
      parked: await vault.convertToAssets(await vault.balanceOf(deployment.contracts.RepoMarket)),
    };
  }

  const snapshot = {
    protocolFeeBps: await market.protocolFeeBps(),
    snapshotAt: (await ethers.provider.getBlock("latest")).timestamp,
    pools,
    mor,
    history,
    collateralInfo,
    repos,
    reserve,
  };

  const outPath = path.join(__dirname, "..", "app", "src", "demoData.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(snapshot, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"
  );
  console.log(`Wrote ${path.relative(process.cwd(), outPath)} (${repos.length} repos, ${history.length} prints)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
