# Tight-stop strategy backtest

Measures what "high-quality entries + tight stop loss" actually earns on
real BTC-USD hourly data under Hyperliquid-like costs (4.5bp taker + 1bp
slippage per side). Four systematic entry setups — 24h breakout with
volume confirmation, trend pullback, volatility-squeeze breakout, 2σ
mean reversion — traded long AND short, stop sweep 0.3/0.5/1.0%, 2R
targets, 24h time exit, conservative intra-bar fills (stop assumed hit
before target).

The engine runs as a live worker (candles fetched server-side from
Coinbase Exchange; only the summary returns):

    https://meridian-research.livo.build/api/backtest?days=60
    ...&product=ETH-USD   # any Coinbase product
    ...&costs=0           # rerun without fees to isolate cost drag

`worker.js` mirrors the deployed source
(github.com/livo-projects/meridian-research, api/index.js). Add your own
entry rules to the STRATEGIES map and redeploy to test them. Findings in
RESULTS.md.
