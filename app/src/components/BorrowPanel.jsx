import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { getContracts, TERMS } from "../lib/contracts";
import { fmtUsd, fmtToken, fmtRate } from "../lib/format";
import { TokenIcon } from "./TokenIcon";

const BPSN = 10_000n;

export function BorrowPanel({ data, connected, onOpenRepo }) {
  const [term, setTerm] = useState(0);
  const [tokenAddr, setTokenAddr] = useState(data.collateralInfo[0]?.address ?? "");
  const [collateralAmt, setCollateralAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");
  const [previewRate, setPreviewRate] = useState(null);

  const token = useMemo(
    () => data.collateralInfo.find((c) => c.address === tokenAddr) ?? data.collateralInfo[0],
    [data.collateralInfo, tokenAddr]
  );
  const pool = data.pools[term];

  const parsedCollateral = useMemo(() => {
    if (!token) return null;
    try {
      const v = ethers.parseUnits(collateralAmt || "0", token.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [collateralAmt, token]);

  const parsedBorrow = useMemo(() => {
    try {
      const v = ethers.parseUnits(borrowAmt || "0", 6);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [borrowAmt]);

  // Advance-rate limit for the entered collateral.
  const maxBorrow = useMemo(() => {
    if (!token || !parsedCollateral || token.unitPriceWad == null) return null;
    const valueWad = (parsedCollateral * token.unitPriceWad) / 10n ** BigInt(token.decimals);
    const valueUsdc = valueWad / 10n ** 12n;
    return (valueUsdc * BigInt(token.cfg.advanceRateBps)) / BPSN;
  }, [token, parsedCollateral]);

  // Preview the locked rate at post-borrow utilization.
  useEffect(() => {
    let cancelled = false;
    async function preview() {
      if (!parsedBorrow || parsedBorrow > pool.cash) {
        setPreviewRate(null);
        return;
      }
      const total = pool.cash + pool.outstanding;
      const utilAfter = total === 0n ? 0n : ((pool.outstanding + parsedBorrow) * BPSN) / total;
      try {
        const rate = await getContracts().model.rateFor(term, utilAfter);
        if (!cancelled) setPreviewRate(rate);
      } catch {
        if (!cancelled) setPreviewRate(null);
      }
    }
    preview();
    return () => {
      cancelled = true;
    };
  }, [parsedBorrow, pool, term]);

  const overLimit = maxBorrow != null && parsedBorrow != null && parsedBorrow > maxBorrow;
  const overLiquidity = parsedBorrow != null && parsedBorrow > pool.cash;
  const canSubmit = connected && token && parsedCollateral && parsedBorrow && !overLimit && !overLiquidity;

  const userBalance = data.user?.collateralBalances.find((c) => c.address === token?.address)?.balance;

  return (
    <div className="card" data-testid="borrow-panel">
      <h2>Finance collateral</h2>
      <p className="sub">Post tokenized assets, draw cash at a rate fixed for the term.</p>

      <div className="field-label">Term</div>
      <div className="seg">
        {TERMS.map((t) => (
          <button key={t.id} className={t.id === term ? "active" : ""} onClick={() => setTerm(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="field-label">Collateral</div>
      <select value={token?.address ?? ""} onChange={(e) => setTokenAddr(e.target.value)} aria-label="Collateral token">
        {data.collateralInfo.map((c) => (
          <option key={c.address} value={c.address}>
            {c.symbol} — advance {Number(c.cfg.advanceRateBps) / 100}%, maintenance{" "}
            {Number(c.cfg.maintenanceRateBps) / 100}%
          </option>
        ))}
      </select>
      {userBalance != null && (
        <div className="hint">
          <TokenIcon symbol={token.symbol} size={14} /> You hold{" "}
          <strong>{fmtToken(userBalance, token.decimals, token.symbol)}</strong>
        </div>
      )}

      <div className="field-label">Collateral amount</div>
      <input
        placeholder={`Amount (${token?.symbol ?? ""})`}
        value={collateralAmt}
        onChange={(e) => setCollateralAmt(e.target.value)}
        inputMode="decimal"
        aria-label="Collateral amount"
      />

      <div className="field-label">Borrow (USDC)</div>
      <input
        placeholder="Amount (USDC)"
        value={borrowAmt}
        onChange={(e) => setBorrowAmt(e.target.value)}
        inputMode="decimal"
        aria-label="Borrow amount"
      />
      {maxBorrow != null && (
        <div className="hint">
          Advance limit: <strong>{fmtUsd(maxBorrow)}</strong>
          {overLimit && <span style={{ color: "var(--bad)" }}> — over limit</span>}
          {overLiquidity && <span style={{ color: "var(--bad)" }}> — exceeds pool cash</span>}
        </div>
      )}
      {previewRate != null && (
        <div className="hint">
          Locks at <strong>{fmtRate(previewRate)}</strong> for {TERMS[term].label.toLowerCase()}
          {" · "}pool cash {fmtUsd(pool.cash)}
        </div>
      )}

      <div className="row">
        <button
          disabled={!canSubmit}
          onClick={() => onOpenRepo(term, token.address, parsedCollateral, parsedBorrow)}
          style={{ flex: 1 }}
        >
          Open repo
        </button>
      </div>
    </div>
  );
}
