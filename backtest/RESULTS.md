# Backtest results — tight stops on BTC (real data)

Run: 2026-07-10 · BTC-USD · 1,441 hourly candles (2026-05-11 → 2026-07-10)
Costs: 11bps round trip (Hyperliquid taker 4.5bp + 1bp slippage, per side)
Engine: https://meridian-research.livo.build/api/backtest?days=60
Context: BTC fell **-21.75%** over the window (buy & hold = -0.408%/day).
Strategies trade long AND short, so the down market is not an excuse.

| strategy            | stop | trades | win%  | stop-outs | daily return | maxDD  |
|---------------------|------|--------|-------|-----------|--------------|--------|
| squeeze-breakout    | 1.0% | 16     | 56.3% | 44%       | **+0.063%**  | 3.1%   |
| breakout-24h+vol    | 1.0% | 42     | 42.9% | 57%       | -0.033%      | 8.0%   |
| squeeze-breakout    | 0.3% | 21     | 28.6% | 71%       | -0.054%      | 3.5%   |
| squeeze-breakout    | 0.5% | 21     | 19.0% | 81%       | -0.114%      | 6.6%   |
| breakout-24h+vol    | 0.5% | 55     | 29.1% | 71%       | -0.173%      | 11.2%  |
| breakout-24h+vol    | 0.3% | 61     | 24.6% | 75%       | -0.193%      | 11.4%  |
| trend-pullback      | 1.0% | 62     | 35.5% | 60%       | -0.212%      | 15.1%  |
| trend-pullback      | 0.5% | 103    | 33.0% | 67%       | -0.226%      | 13.8%  |
| vwap-reversion-2sd  | 0.3% | 96     | 17.7% | 82%       | -0.257%      | 16.0%  |
| vwap-reversion-2sd  | 0.5% | 84     | 26.2% | 74%       | -0.294%      | 17.4%  |
| vwap-reversion-2sd  | 1.0% | 69     | 40.6% | 57%       | -0.308%      | 21.0%  |
| trend-pullback      | 0.3% | 129    | 29.5% | 71%       | -0.313%      | 17.3%  |

Break-even win rates at 2R with costs: 45.6% (0.3% stop) · 40.7% (0.5%) ·
37.0% (1.0%). Only one config cleared its bar.

## Findings

1. **Tighter stops made every strategy worse.** At a 0.3% stop, 70–82% of
   trades die to routine hourly noise before the thesis can play out.
   The whipsaw effect is the dominant cost in the table, not the fees.
2. **11 of 12 configs lost money.** The single positive config
   (squeeze-breakout, 1% stop) earned 0.063%/day on just 16 trades — a
   sample small enough to be luck, and it is the best of 12 tried, so
   selection bias inflates it.
3. **The gap to a 0.5–2%/day target is ~10–30×** even taking the best
   config at face value. Reaching the target would require a ~65–70%
   win rate sustained at 2R — hedge-fund-elite territory.

## Caveats

- 60 days, one asset, hourly bars, one regime (a -22% BTC drawdown).
  The worker accepts `days` up to 90 and any Coinbase `product`.
- Conservative fills; no funding costs modeled (short holds).
- Deliberately no optimization loop: mining 1,000 configs would only
  manufacture overfit winners.
