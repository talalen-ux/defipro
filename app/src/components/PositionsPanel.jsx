import { fmtUsd, fmtRate, fmtMaturity, shortAddr } from "../lib/format";
import { TERMS } from "../lib/contracts";
import { TokenIcon } from "./TokenIcon";

const BPSN = 10_000n;

function healthOf(repo, collateralInfo) {
  if (repo.collateralValue == null || repo.debt === 0n) return null;
  const cfg = collateralInfo.find((c) => c.address.toLowerCase() === repo.collateralToken.toLowerCase())?.cfg;
  if (!cfg) return null;
  const capacity = (repo.collateralValue * BigInt(cfg.maintenanceRateBps)) / BPSN;
  return Number((capacity * 1000n) / repo.debt) / 1000; // margin headroom multiple
}

function HealthBadge({ h, liquidatable }) {
  if (liquidatable) return <span className="badge bad">liquidatable</span>;
  if (h == null) return <span className="badge warn">no price</span>;
  if (h >= 1.03) return <span className="badge good">{h.toFixed(2)}× healthy</span>;
  if (h >= 1.0) return <span className="badge warn">{h.toFixed(2)}× thin</span>;
  return <span className="badge bad">{h.toFixed(2)}× breach</span>;
}

export function PositionsPanel({ data, address, onClose, onRoll, onLiquidate }) {
  const symbolOf = (addr) =>
    data.collateralInfo.find((c) => c.address.toLowerCase() === addr.toLowerCase())?.symbol ?? shortAddr(addr);

  const mine = address
    ? data.repos.filter((r) => r.borrower.toLowerCase() === address.toLowerCase())
    : [];
  const atRisk = data.repos.filter(
    (r) => r.liquidatable && (!address || r.borrower.toLowerCase() !== address.toLowerCase())
  );

  return (
    <div className="card" data-testid="positions-panel">
      <h2>Your repos</h2>
      <p className="sub">Fixed-term positions; roll before maturity or close any time.</p>
      {mine.length === 0 ? (
        <div className="empty">{address ? "No open repos." : "Connect to see your positions."}</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Term</th>
              <th>Collateral</th>
              <th>Debt</th>
              <th>Rate</th>
              <th>Maturity</th>
              <th>Health</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mine.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.id)}</td>
                <td>{TERMS[r.term].label}</td>
                <td><TokenIcon symbol={symbolOf(r.collateralToken)} />{symbolOf(r.collateralToken)}</td>
                <td>
                  <strong>{fmtUsd(r.debt)}</strong>
                </td>
                <td>{fmtRate(r.rateBps)}</td>
                <td>{fmtMaturity(r.maturity)}</td>
                <td>
                  <HealthBadge h={healthOf(r, data.collateralInfo)} liquidatable={r.liquidatable} />
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="small ghost" onClick={() => onRoll(r.id)} style={{ marginRight: 6 }}>
                    Roll
                  </button>
                  <button className="small" onClick={() => onClose(r.id)}>
                    Close
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 22 }}>Liquidation desk</h2>
      <p className="sub">Defaulted or under-margined repos anyone can settle for the penalty discount.</p>
      {atRisk.length === 0 ? (
        <div className="empty">Nothing at risk — the book is healthy.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Borrower</th>
              <th>Collateral</th>
              <th>Debt to cover</th>
              <th>Maturity</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {atRisk.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.id)}</td>
                <td>{shortAddr(r.borrower)}</td>
                <td><TokenIcon symbol={symbolOf(r.collateralToken)} />{symbolOf(r.collateralToken)}</td>
                <td>
                  <strong>{fmtUsd(r.debt)}</strong>
                </td>
                <td>{fmtMaturity(r.maturity)}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="small danger" disabled={!address} onClick={() => onLiquidate(r.id)}>
                    Liquidate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
