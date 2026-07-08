require("@nomicfoundation/hardhat-toolbox");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
} = require("hardhat/builtin-tasks/task-names");
const { subtask } = require("hardhat/config");

// This environment has no network access to binaries.soliditylang.org, so we
// compile with the solc-js build bundled in the `solc` npm package instead of
// letting Hardhat download a native compiler.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.28") {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.28",
    };
  }
  return runSuper(args);
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
    },
  },
  mocha: { timeout: 120000 },
};
