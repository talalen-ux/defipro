import { useState } from "react";
import { ethers } from "ethers";
import { fmtUsd, fmtRate, fmtPctOfBps } from "../lib/format";

const KINK_BPS = 8500;
const BPSN = 10_000n;
const VIRTUAL_SHARES = 10n ** 6n;

export function PoolCard({ pool, position, feeBps, walletBalance, connected, onDeposit, onWithdraw }) {
  const [amount, setAmount] = useState("");

  const utilNum = Number(pool.utilization);
  const hot = utilNum > KINK_BPS;
  const poolAssets = pool.cash + pool.outstanding;

  // What a lender earns at current conditions: borrowers pay the marginal
  // rate on the utilized share; the protocol keeps feeBps of interest.
  const lenderAprBps =
    (pool.liveRate * pool.utilization * (BPSN - (feeBps ?? 1000n))) / (BPSN * BPSN);

  function parsed() {
    try {
      const v = ethers.parseUnits(amount || "0", 6);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }

  function withdrawShares() {
    const v = parsed();
    if (!v || !position) return null;
    // Full exit if they asked for (at least) everything they have.
    if (v >= position.assets) return position.shares;
    return (v * (pool.totalShares + VIRTUAL_SHARES)) / (poolAssets + 1n);
  }

  const maxLend = walletBalance ?? 0n;
  const maxWithdraw = position ? (position.assets < pool.cash ? position.assets : pool.cash) : 0n;

  return (
    <div className="card" data-testid={`pool-${pool.id}`}>
      <div className="pool-head">
        <h2>{pool.label}</h2>
        <span className="rate">{fmtRate(pool.liveRate)}</span>
      </div>
      <p className="sub">
        borrow rate · lenders earn ~<strong>{fmtRate(lenderAprBps)}</strong> APR
      </p>

      <div className="meter" role="meter" aria-valuenow={utilNum / 100} aria-valuemin="0" aria-valuemax="100">
        <div className={`fill${hot ? " hot" : ""}`} style={{ width: `${Math.min(100, utilNum / 100)}%` }} />
        <div className="kink" style={{ left: `${KINK_BPS / 100}%` }} />
      </div>
      <div className="meter-caption">
        <span className={hot ? "hot" : ""}>
          {fmtPctOfBps(pool.utilization)} utilized{hot ? " — above kink" : ""}
        </span>
        <span>kink 85%</span>
      </div>

      <div className="kv">
        <span>Idle cash</span>
        <strong>{fmtUsd(pool.cash)}</strong>
      </div>
      <div className="kv">
        <span>Out in repos</span>
        <strong>{fmtUsd(pool.outstanding)}</strong>
      </div>
      <div className="kv">
        <span>Your balance</span>
        <strong>{position ? fmtUsd(position.assets) : "—"}</strong>
      </div>
      <div className="kv">
        <span>Your earnings</span>
        <strong>{position && position.earned != null ? fmtUsd(position.earned) : "—"}</strong>
      </div>

      <div className="row">
        <input
          placeholder="Amount (USDC)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-label={`${pool.label} amount`}
        />
        <button
          className="ghost small"
          disabled={!connected}
          title="Fill with your full wallet balance"
          onClick={() => setAmount(ethers.formatUnits(maxLend, 6))}
        >
          Max
        </button>
      </div>
      <div className="row">
        <button
          disabled={!connected || !parsed()}
          onClick={() => onDeposit(pool.id, parsed())}
          style={{ flex: 1 }}
        >
          Lend
        </button>
        <button
          className="ghost"
          disabled={!connected || !withdrawShares()}
          onClick={() => onWithdraw(pool.id, withdrawShares())}
          style={{ flex: 1 }}
          title={position ? `Withdrawable now: ${fmtUsd(maxWithdraw)}` : undefined}
        >
          Withdraw
        </button>
      </div>
    </div>
  );
}
