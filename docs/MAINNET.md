# Mainnet launch runbook

Everything needed to put Meridian on a production network is wired; this
is the ordered checklist. **The contracts are un-audited — do not put real
user funds behind them until an audit (and ideally a public-testnet
soak) is complete.** The deploy script hard-refuses to ship mock assets to
a production network.

## 0. Prerequisites (only the operator can provide these)

| Item | Why |
|---|---|
| `DEPLOYER_KEY` | Funded EOA private key (gas: full stack ≈ 6–8M gas) |
| `MAINNET_RPC_URL` / `BASE_RPC_URL` | An RPC endpoint (Alchemy/Infura/public) |
| A Safe (multisig) address | To own everything after deployment |
| `VITE_WC_PROJECT_ID` | WalletConnect project id for the frontend (free, cloud.reown.com) |

## 1. Choose the cash + venue addresses (verify, don't trust)

- **Cash (`STABLE`)** — canonical USDC:
  - Ethereum: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  - Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - Verify against https://www.circle.com/en/multi-chain-usdc before use.
- **Reserve vault (`RESERVE_VAULT`)** — any audited ERC-4626 USDC vault
  (Aave stata wrapper, a Morpho vault, Yearn, Spark). Pick from the
  venue's own UI/docs, verify `asset() == USDC`, and check its liquidity
  is instant-redeem. Optional: omit to hold cash in the market until
  governance sets one later via `setReserveVault`.

## 2. Deploy

```bash
STABLE=0x... RESERVE_VAULT=0x... DEPLOYER_KEY=0x... MAINNET_RPC_URL=https://... \
  npx hardhat run scripts/deploy.js --network mainnet     # or --network base
```

Writes `app/src/deployment.json` (update `rpcUrl` to a public RPC for the
hosted frontend).

## 3. List real collateral

For each tokenized asset (BUIDL/BENJI/OUSG-class):

1. Deploy or point at a **price feed** implementing `IPriceFeed`
   (Chainlink aggregator adapter or issuer NAV oracle).
2. `registry.setCollateral(token, true, advanceRateBps, maintenanceRateBps,
   liquidationPenaltyBps, maxStaleness, feed, supplyCap)` — start
   conservative (e.g. treasuries 9800/9900/100, cap low, staleness ≤ 26h).
3. **Transfer-restriction check**: most tokenized treasuries are
   permissioned ERC-20s — the RepoMarket contract address must be
   whitelisted by the issuer before that token can actually move. Engage
   the issuer first; list only after a successful test transfer.

## 4. Hand over control

```
market/registry/model/oracle/treasury.transferOwnership(SAFE)  // Ownable2Step: Safe must accept
```

Put a timelock in front of the Safe for parameter changes if desired.

## 5. Seed and open

- Fund `ProtocolTreasury` with launch liquidity; `seedPool` each term so
  the market quotes usable rates from block one.
- Run a keeper for price-feed freshness and `skim()` (both permissionless).
- Point the frontend at the deployment (`app/src/deployment.json`),
  rebuild, redeploy the site.

## Known launch risks (read before going live)

- **Un-audited code** — the hard blocker for real size.
- **RWA transfer restrictions** — see §3; without issuer whitelisting the
  market can't custody the collateral at all.
- **Oracle quality** — NAV feeds are the main loss vector; staleness
  bounds and supply caps are the mitigations.
- **Liquidation liquidity** — a liquidator must be able to exit seized
  RWA collateral; penalties/haircuts must price that exit.
