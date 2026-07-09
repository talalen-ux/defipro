import { useCallback, useEffect, useRef, useState } from "react";
import { getContracts, readProvider, DEPLOYMENT, TERMS } from "../lib/contracts";
import { demoSnapshot } from "../lib/demo";

const POLL_MS = 10_000;

/**
 * Polls all market state the dashboard needs from the read provider.
 * `refresh()` forces an immediate reload (used after transactions).
 */
export function useMarketData(address) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const blockTsCache = useRef(new Map());

  const load = useCallback(async () => {
    try {
      const { market, registry, model, oracle, stable, collateral, reserveVault, faucet } =
        getContracts();

      const pools = await Promise.all(
        TERMS.map(async (t) => {
          const [cash, outstanding, totalShares, utilization] = await market.getPool(t.id);
          const liveRate = await model.rateFor(t.id, utilization);
          return { ...t, cash, outstanding, totalShares, utilization, liveRate };
        })
      );

      let mor = null;
      try {
        const [rate, updatedAt] = await oracle.currentRate(0);
        let twar1d = null;
        try {
          twar1d = await oracle.twar(0, 86400);
        } catch {}
        mor = { rate, updatedAt, twar1d };
      } catch {}

      // MOR history for the sparkline (overnight prints).
      const rateEvents = await oracle.queryFilter(oracle.filters.RateRecorded(0), 0);
      const history = [];
      for (const ev of rateEvents) {
        let ts = blockTsCache.current.get(ev.blockNumber);
        if (ts === undefined) {
          ts = (await readProvider.getBlock(ev.blockNumber)).timestamp;
          blockTsCache.current.set(ev.blockNumber, ts);
        }
        history.push({ t: ts, rate: ev.args.rateBps });
      }

      const collateralInfo = await Promise.all(
        DEPLOYMENT.collateral.map(async (c) => {
          const cfg = await registry.getConfig(c.address);
          let value = null;
          try {
            value = await registry.usdValueOf(c.address, 10n ** BigInt(c.decimals));
          } catch {}
          return { ...c, cfg, unitPriceWad: value };
        })
      );

      // All open repos (for the liquidation desk) + the connected user's book.
      const openedEvents = await market.queryFilter(market.filters.RepoOpened(), 0);
      const seen = new Set();
      const repos = [];
      for (const ev of openedEvents) {
        const id = ev.args.repoId;
        if (seen.has(id)) continue;
        seen.add(id);
        const repo = await market.getRepo(id);
        if (!repo.active) continue;
        const [debt, liquidatable] = await Promise.all([
          market.currentDebt(id),
          market.isLiquidatable(id).catch(() => false),
        ]);
        let collateralValue = null;
        try {
          const usdWad = await registry.usdValueOf(repo.collateralToken, repo.collateralAmount);
          collateralValue = usdWad / 10n ** 12n; // to 6-dec stable terms
        } catch {}
        repos.push({ id, ...repoToObj(repo), debt, liquidatable, collateralValue });
      }

      const protocolFeeBps = await market.protocolFeeBps();

      // External liquidity venue holding the market's idle cash.
      let reserve = null;
      if (reserveVault) {
        const parked = await reserveVault.convertToAssets(
          await reserveVault.balanceOf(DEPLOYMENT.contracts.RepoMarket)
        );
        reserve = { address: DEPLOYMENT.contracts.ReserveVault, parked };
      }

      let user = null;
      if (address) {
        // Lifetime cash flows per term (from events) let us show realized
        // earnings: assets + withdrawn - deposited.
        const flows = TERMS.map(() => ({ deposited: 0n, withdrawn: 0n }));
        const [depEvents, wdEvents] = await Promise.all([
          market.queryFilter(market.filters.Deposited(null, address), 0),
          market.queryFilter(market.filters.Withdrawn(null, address), 0),
        ]);
        for (const ev of depEvents) flows[Number(ev.args.term)].deposited += ev.args.amount;
        for (const ev of wdEvents) flows[Number(ev.args.term)].withdrawn += ev.args.amount;

        const [usdcBalance, positions, collateralBalances] = await Promise.all([
          stable.balanceOf(address),
          Promise.all(
            TERMS.map(async (t) => {
              const assets = await market.balanceOfAssets(t.id, address);
              const earned = assets + flows[t.id].withdrawn - flows[t.id].deposited;
              return {
                term: t.id,
                shares: await market.sharesOf(t.id, address),
                assets,
                earned: earned > 0n ? earned : 0n,
              };
            })
          ),
          Promise.all(
            DEPLOYMENT.collateral.map(async (c) => ({
              ...c,
              balance: await collateral[c.address].balanceOf(address),
            }))
          ),
        ]);
        let nextClaimAt = null;
        if (faucet) {
          nextClaimAt = Number(await faucet.nextClaimAt(address));
        }
        user = { usdcBalance, positions, collateralBalances, nextClaimAt };
      }

      setData({
        pools,
        mor,
        history,
        collateralInfo,
        repos,
        user,
        reserve,
        protocolFeeBps,
        loadedAt: Date.now(),
      });
      setError(null);
    } catch (e) {
      setError(e);
      // No chain reachable and nothing loaded yet: fall back to the bundled
      // demo snapshot so the hosted app is still viewable. Never clobber
      // live data with it.
      setData((prev) => prev ?? demoSnapshot());
    }
  }, [address]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return { data, error, refresh: load };
}

function repoToObj(repo) {
  return {
    borrower: repo.borrower,
    collateralToken: repo.collateralToken,
    collateralAmount: repo.collateralAmount,
    principal: repo.principal,
    rateBps: repo.rateBps,
    openedAt: repo.openedAt,
    maturity: repo.maturity,
    term: Number(repo.term),
  };
}
