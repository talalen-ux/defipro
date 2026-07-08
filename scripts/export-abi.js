/**
 * Copies compiled contract ABIs into the frontend (app/src/abi/*.json).
 * Run after `npx hardhat compile`.
 */
const fs = require("fs");
const path = require("path");

const CONTRACTS = [
  "RepoMarket",
  "CollateralRegistry",
  "KinkedRateModel",
  "MeridianRateOracle",
  "MockERC20",
  "MockYieldVault",
  "ProtocolTreasury",
  "Faucet",
];

const artifactsDir = path.join(__dirname, "..", "artifacts", "contracts");
const outDir = path.join(__dirname, "..", "app", "src", "abi");
fs.mkdirSync(outDir, { recursive: true });

function findArtifact(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findArtifact(p, name);
      if (found) return found;
    } else if (entry.name === `${name}.json`) {
      return p;
    }
  }
  return null;
}

for (const name of CONTRACTS) {
  const artifactPath = findArtifact(artifactsDir, name);
  if (!artifactPath) {
    console.error(`Artifact not found for ${name} — run 'npx hardhat compile' first.`);
    process.exit(1);
  }
  const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(abi, null, 2) + "\n");
  console.log(`exported ${name} ABI`);
}
