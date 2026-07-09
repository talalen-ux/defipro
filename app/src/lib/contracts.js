import { ethers } from "ethers";
import deployment from "../deployment.json";
import RepoMarketAbi from "../abi/RepoMarket.json";
import CollateralRegistryAbi from "../abi/CollateralRegistry.json";
import KinkedRateModelAbi from "../abi/KinkedRateModel.json";
import MeridianRateOracleAbi from "../abi/MeridianRateOracle.json";
import MockERC20Abi from "../abi/MockERC20.json";
import MockYieldVaultAbi from "../abi/MockYieldVault.json";
import FaucetAbi from "../abi/Faucet.json";

export const DEPLOYMENT = deployment;
export const TERMS = [
  { id: 0, label: "Overnight", seconds: 86400 },
  { id: 1, label: "7 day", seconds: 7 * 86400 },
  { id: 2, label: "30 day", seconds: 30 * 86400 },
  { id: 3, label: "90 day", seconds: 90 * 86400 },
];

export const readProvider = new ethers.JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  polling: true,
});

export function getContracts(runner = readProvider) {
  return {
    market: new ethers.Contract(deployment.contracts.RepoMarket, RepoMarketAbi, runner),
    registry: new ethers.Contract(deployment.contracts.CollateralRegistry, CollateralRegistryAbi, runner),
    model: new ethers.Contract(deployment.contracts.KinkedRateModel, KinkedRateModelAbi, runner),
    oracle: new ethers.Contract(deployment.contracts.MeridianRateOracle, MeridianRateOracleAbi, runner),
    stable: new ethers.Contract(deployment.stable.address, MockERC20Abi, runner),
    collateral: Object.fromEntries(
      deployment.collateral.map((c) => [c.address, new ethers.Contract(c.address, MockERC20Abi, runner)])
    ),
    reserveVault: deployment.contracts.ReserveVault
      ? new ethers.Contract(deployment.contracts.ReserveVault, MockYieldVaultAbi, runner)
      : null,
    faucet: deployment.contracts.Faucet
      ? new ethers.Contract(deployment.contracts.Faucet, FaucetAbi, runner)
      : null,
  };
}

/** Ask an EIP-1193 wallet to switch to (or add) the app's chain. */
async function ensureChain(rawProvider) {
  const chainIdHex = "0x" + deployment.chainId.toString(16);
  try {
    await rawProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (e) {
    // 4902: chain unknown to the wallet — offer to add it.
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902) {
      await rawProvider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: `Meridian (${deployment.network})`,
            rpcUrls: [deployment.rpcUrl],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

/** Connect an injected wallet (MetaMask etc.). */
export async function connectInjected() {
  if (!window.ethereum) throw new Error("No injected wallet found");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  await ensureChain(window.ethereum);
  const signer = await provider.getSigner();
  return { signer, address: await signer.getAddress(), kind: "wallet" };
}

/**
 * Connect through WalletConnect v2 (QR / mobile wallets). Requires a
 * project id from cloud.reown.com in VITE_WC_PROJECT_ID at build time.
 */
export async function connectWalletConnect() {
  const projectId = import.meta.env.VITE_WC_PROJECT_ID;
  if (!projectId) {
    throw new Error("WalletConnect needs VITE_WC_PROJECT_ID (free at cloud.reown.com) set at build time");
  }
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const wc = await EthereumProvider.init({
    projectId,
    chains: [deployment.chainId],
    showQrModal: true,
    metadata: {
      name: "Meridian",
      description: "The on-chain repo market for tokenized assets",
      url: window.location.origin,
      icons: [],
    },
  });
  await wc.enable();
  const provider = new ethers.BrowserProvider(wc);
  const signer = await provider.getSigner();
  return { signer, address: await signer.getAddress(), kind: "walletconnect" };
}

/**
 * Connect one of the node's unlocked dev accounts (hardhat/anvil localhost).
 * Lets the app be driven end-to-end without a browser wallet.
 */
export async function connectDevAccount(index) {
  const signer = await readProvider.getSigner(index);
  return { signer, address: await signer.getAddress(), kind: `dev #${index}` };
}

/** Ensure `spender` can pull `amount` of `token` from the signer. */
export async function ensureAllowance(token, owner, spender, amount) {
  const allowance = await token.allowance(owner, spender);
  if (allowance < amount) {
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait();
  }
}
