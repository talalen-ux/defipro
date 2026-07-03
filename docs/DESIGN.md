# Meridian design notes

## Thesis

The two fastest-growing flows in crypto are stablecoins and tokenized
real-world assets. What's missing between them is the market that connects
cash to collateral in TradFi: repo. Tokenized treasuries and credit carry
redemption delays (days to months), which makes them poor DeFi collateral in
floating-rate, open-ended money markets — but excellent collateral for
*fixed-term, margin-maintained* financing. That is exactly what a repo
market is.

The durable moat is not the lending spread — it's the benchmark. Every repo
prints a marginal rate; the time-weighted overnight print (**MOR**) is an
economy-wide reference other protocols can settle against. Benchmarks
compound network effects for decades; that is the blue-chip path.

## Mechanism

### Term pools

Four pools per market, keyed by term: overnight (1d), 7d, 30d, 90d. Each
pool holds `cash` (idle stablecoin) and `principalOutstanding` (lent to
active repos). Lender shares follow ERC-4626-style accounting with a
virtual-shares offset (`1e6`) to neutralize first-depositor inflation
attacks. Share value = `(cash + principalOutstanding) / totalShares`.

Two deliberate simplifications:

- **Interest is recognized on settlement**, not accrued into share price
  continuously. A pool's share price steps up when a repo closes, rolls, or
  liquidates profitably. This keeps accounting exact (no estimated accrual
  can be gamed) at the cost of slightly lumpy lender APY.
- **Withdrawals come from idle cash only.** Lenders are never able to force
  early unwind of a fixed-term repo. Liquidity returns on close / roll /
  liquidation. This is the term structure doing its job, not a bug.

### Pricing

Every repo locks the pool's marginal rate at post-trade utilization, from a
per-term kinked curve (`base + slope1·u/kink`, then `+ slope2` beyond the
kink). Fixed for the term; bullet repayment; pro-rata interest on early
close. Rolling settles accrued interest and re-locks at the current
marginal rate — a clean primitive for desks running a matched book.

The utilization-priced marginal rate is the "clearing rate" proxy in v1. A
v2 order-book or batch-auction market can replace the curve without touching
the oracle interface (`IRateModel` is swappable by governance).

### Collateral & margin

Per-token registry config mirrors repo-market risk practice:

| Parameter | Meaning | Treasuries (demo) | Private credit (demo) |
|---|---|---|---|
| `advanceRateBps` | max borrow vs value at open (haircut) | 98% | 85% |
| `maintenanceRateBps` | margin-call threshold on debt/value | 99% | 92% |
| `liquidationPenaltyBps` | liquidator discount | 1% | 5% |
| `supplyCap` | per-issuer concentration cap | ∞ | capped |
| `maxStaleness` | max price-feed age | 1d | 1d |

A repo is liquidatable when **either** debt exceeds
`collateralValue × maintenanceRate` (margin breach) **or** it is past
maturity + 1-day grace (default). The liquidator covers the debt and takes
collateral worth `debt × (1 + penalty)`; any remainder returns to the
borrower. If collateral cannot cover, the liquidator takes it all at the
same discount and the pool absorbs the shortfall — losses are isolated to
the term pool that underwrote the repo, and the protocol takes no fee on a
loss.

### The MOR benchmark

`MeridianRateOracle` keeps a cumulative rate-time accumulator per term (the
same integral trick as a price TWAP) fed by the market on every
utilization-moving action. `twar(term, window)` is therefore
manipulation-resistant in proportion to the window: spoofing a 30-day TWAR
requires holding a distorted utilization — with real capital at the
distorted rate — for a meaningful fraction of 30 days. Windows clamp to
available history; per-term histories are independent.

## Trust model

- **Governance (owner)**: lists collateral, sets curves/fees, pauses new
  risk. Intended to sit behind a timelock + multisig at deployment;
  `Ownable2Step` everywhere. Governance cannot touch user collateral or
  withdraw pool cash.
- **Price feeds**: per-collateral, with staleness bounds. RWA pricing is the
  protocol's deepest external dependency; issuer-published NAV feeds with
  on-chain attestation are the target integration.
- **Pause semantics**: pausing stops new exposure (deposits, opens, rolls) —
  never exits (withdraw, close, liquidate).
- **Unit of account**: the stablecoin is assumed $1. A depegged cash asset
  affects all pools equally; collateral valuations are independent of it.

## What v1 deliberately leaves out

1. **Tokenized pool shares** (ERC-4626 wrappers) — internal share accounting
   is done; wrapping is additive.
2. **Fixed-term lender deposits** (deposit locked to maturity for a rate
   premium) and tradeable term notes — the natural yield-curve extension.
3. **Rate swaps against MOR** — the derivatives layer; requires a seasoned
   benchmark first.
4. **Auction-based rate discovery** — `IRateModel` is the seam.
5. **Partial repayment** — repos are bullet instruments; splitting a
   position is achieved by opening several repos.
6. **KYC-gated pool instances** — a second market deployment with a
   transfer-restricted share token covers permissioned capital; the rate
   engine and oracle are shared.

## Known risks (open-eyed)

- **Oracle quality is the ceiling.** Slow or manipulable RWA NAV feeds are
  the main loss vector; mitigations are conservative staleness bounds,
  advance rates, and supply caps per issuer.
- **Liquidation depends on secondary liquidity.** A liquidator must want the
  collateral. For assets with thin on-chain markets, penalties and haircuts
  must price the exit cost; a keeper/auction module is a v2 candidate.
- **Interest-on-settlement accounting** means a lender who exits right
  before a large repo closes forgoes that interest. Acceptable at v1 scale;
  continuous accrual estimation can be layered on later.
- **`uint128` pool fields** bound a pool to ~3.4e38 base units — orders of
  magnitude beyond any stablecoin supply; SafeCast guards every narrowing.
