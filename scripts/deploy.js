/**
 * Deploys the full Meridian stack.
 *
 * On a local/dev network this also deploys mock assets (USDC, a tokenized
 * T-bill fund, tokenized private credit) and price feeds, then wires risk
 * parameters so the market is immediately usable. On a live network, set
 * the STABLE / TREASURY env vars and list real collateral via governance
 * afterwards.
 */
const { ethers, network } = require("hardhat");

const WAD = (n) => ethers.parseUnits(n.toString(), 18);

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying Meridian to '${network.name}' from ${deployer.address}\n`);

  const isLocal = network.name === "hardhat" || network.name === "localhost";
  let stableAddress = process.env.STABLE;

  let usdc, tbill, credit, tbillFeed, creditFeed;
  if (isLocal || !stableAddress) {
    usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    stableAddress = await usdc.getAddress();
    tbill = await ethers.deployContract("MockTokenizedTreasury", [
      "Tokenized T-Bill Fund",
      "tBILL",
      6,
      deployer.address,
      5n * 86400n,
    ]);
    credit = await ethers.deployContract("MockERC20", ["Tokenized Private Credit", "tCRED", 18]);
    tbillFeed = await ethers.deployContract("MockPriceFeed", [WAD("1.05")]);
    creditFeed = await ethers.deployContract("MockPriceFeed", [WAD("0.98")]);
    console.log(`  MockERC20 (USDC):          ${stableAddress}`);
    console.log(`  MockTokenizedTreasury:     ${await tbill.getAddress()}`);
    console.log(`  MockERC20 (tCRED):         ${await credit.getAddress()}`);
  }

  const registry = await ethers.deployContract("CollateralRegistry", [deployer.address]);
  const model = await ethers.deployContract("KinkedRateModel", [deployer.address]);
  const oracle = await ethers.deployContract("MeridianRateOracle", [deployer.address]);
  const protocolTreasury = await ethers.deployContract("ProtocolTreasury", [deployer.address]);
  const market = await ethers.deployContract("RepoMarket", [
    deployer.address,
    stableAddress,
    await registry.getAddress(),
    await model.getAddress(),
    await oracle.getAddress(),
    await protocolTreasury.getAddress(),
  ]);
  await (await oracle.setMarket(await market.getAddress())).wait();

  // Idle cash is parked in an external ERC-4626 venue. On live networks set
  // RESERVE_VAULT to an already-deployed vault (Aave wrapper, Morpho, etc.);
  // locally a mock venue stands in.
  let reserveVault = process.env.RESERVE_VAULT;
  if (!reserveVault && isLocal) {
    const mockVault = await ethers.deployContract("MockYieldVault", [stableAddress]);
    reserveVault = await mockVault.getAddress();
  }
  if (reserveVault) {
    await (await market.setReserveVault(reserveVault)).wait();
  }

  // Testnet self-onboarding.
  let faucet = null;
  if (tbill) {
    faucet = await ethers.deployContract("Faucet", [
      stableAddress,
      await tbill.getAddress(),
      await credit.getAddress(),
      ethers.parseUnits("100000", 6),
      ethers.parseUnits("50000", 6),
      WAD("25000"),
    ]);
  }

  // Rate curves: [base, slope1, slope2, kink] annualized bps. Overnight is
  // the MOR-defining pool; longer terms carry a small term premium.
  const curves = [
    [300, 200, 4000, 8500], // overnight
    [320, 220, 4000, 8500], // 7d
    [350, 250, 4000, 8500], // 30d
    [400, 300, 4000, 8500], // 90d
  ];
  for (let term = 0; term < curves.length; term++) {
    await (await model.setParams(term, curves[term])).wait();
  }

  if (tbill) {
    // Treasuries: 2% haircut (98% advance), 99% maintenance, 1% penalty.
    await (
      await registry.setCollateral(tbill, true, 9800, 9900, 100, 86400, tbillFeed, 0)
    ).wait();
    // Private credit: 15% haircut, 92% maintenance, 5% penalty, capped.
    await (
      await registry.setCollateral(credit, true, 8500, 9200, 500, 86400, creditFeed, WAD("10000000"))
    ).wait();
  }

  console.log(`  CollateralRegistry:        ${await registry.getAddress()}`);
  console.log(`  KinkedRateModel:           ${await model.getAddress()}`);
  console.log(`  MeridianRateOracle:        ${await oracle.getAddress()}`);
  console.log(`  RepoMarket:                ${await market.getAddress()}`);
  console.log(`  ProtocolTreasury:          ${await protocolTreasury.getAddress()}`);
  console.log(`  ReserveVault (ERC-4626):   ${reserveVault ?? "none (local custody)"}`);
  if (faucet) console.log(`  Faucet:                    ${await faucet.getAddress()}`);

  // Write addresses for the frontend (app/src/deployment.json).
  const fs = require("fs");
  const path = require("path");
  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rpcUrl: "http://localhost:8545",
    contracts: {
      RepoMarket: await market.getAddress(),
      CollateralRegistry: await registry.getAddress(),
      KinkedRateModel: await model.getAddress(),
      MeridianRateOracle: await oracle.getAddress(),
      ProtocolTreasury: await protocolTreasury.getAddress(),
      ReserveVault: reserveVault ?? null,
      Faucet: faucet ? await faucet.getAddress() : null,
    },
    stable: { address: stableAddress, symbol: "USDC", decimals: 6 },
    collateral: tbill
      ? [
          { address: await tbill.getAddress(), symbol: "tBILL", decimals: 6 },
          { address: await credit.getAddress(), symbol: "tCRED", decimals: 18 },
        ]
      : [],
  };
  const outPath = path.join(__dirname, "..", "app", "src", "deployment.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}`);
  console.log("Meridian deployed.");

  return { usdc, tbill, credit, tbillFeed, creditFeed, registry, model, oracle, market, protocolTreasury, faucet };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
