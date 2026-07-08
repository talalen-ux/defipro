import raw from "../demoData.json";
import { TERMS } from "./contracts";

const B = (v) => (v == null ? null : BigInt(v));

/**
 * A captured snapshot of a seeded local market (scripts/export-demo-data.js),
 * used when no chain is reachable — e.g. on the hosted demo. Timestamps are
 * shifted so the snapshot always reads as current.
 */
export function demoSnapshot() {
  const now = Math.floor(Date.now() / 1000);
  const shift = now - Number(raw.snapshotAt);
  const shiftTs = (t) => Number(t) + shift;

  return {
    demo: true,
    pools: raw.pools.map((p, i) => ({
      ...TERMS[i],
      cash: B(p.cash),
      outstanding: B(p.outstanding),
      totalShares: B(p.totalShares),
      utilization: B(p.utilization),
      liveRate: B(p.liveRate),
    })),
    mor: raw.mor
      ? { rate: B(raw.mor.rate), twar1d: B(raw.mor.twar1d), updatedAt: shiftTs(raw.mor.updatedAt) }
      : null,
    history: raw.history.map((h) => ({ t: shiftTs(h.t), rate: B(h.rate) })),
    collateralInfo: raw.collateralInfo.map((c) => ({ ...c, unitPriceWad: B(c.unitPriceWad) })),
    repos: raw.repos.map((r) => ({
      ...r,
      id: B(r.id),
      collateralAmount: B(r.collateralAmount),
      principal: B(r.principal),
      rateBps: B(r.rateBps),
      openedAt: shiftTs(r.openedAt),
      maturity: shiftTs(r.maturity),
      debt: B(r.debt),
      collateralValue: B(r.collateralValue),
    })),
    reserve: raw.reserve ? { address: raw.reserve.address, parked: B(raw.reserve.parked) } : null,
    user: null,
    loadedAt: Date.now(),
  };
}
