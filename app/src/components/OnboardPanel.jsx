import { fmtUsd, shortAddr } from "../lib/format";
import { DEPLOYMENT } from "../lib/contracts";

/**
 * Cash & liquidity: where the money comes from. Shows the user's cash
 * balance, the faucet (testnet self-onboarding), and the external ERC-4626
 * venue where the market parks idle liquidity.
 */
export function OnboardPanel({ data, connected, onClaim }) {
  const now = Math.floor(Date.now() / 1000);
  const nextClaimAt = data.user?.nextClaimAt ?? 0;
  const canClaim = connected && !!DEPLOYMENT.contracts.Faucet && nextClaimAt <= now;
  const waitHours = Math.max(0, Math.ceil((nextClaimAt - now) / 3600));

  return (
    <div className="card" data-testid="onboard-panel">
      <h2>Cash &amp; liquidity</h2>
      <p className="sub">
        The market's cash is {DEPLOYMENT.stable.symbol}; idle pool cash is parked in an external
        ERC-4626 venue and recalled on demand.
      </p>

      <div className="kv">
        <span>Your {DEPLOYMENT.stable.symbol}</span>
        <strong>{data.user ? fmtUsd(data.user.usdcBalance) : "—"}</strong>
      </div>
      {data.reserve && (
        <>
          <div className="kv">
            <span>Parked in reserve vault</span>
            <strong>{fmtUsd(data.reserve.parked)}</strong>
          </div>
          <div className="kv">
            <span>Reserve vault</span>
            <strong>{shortAddr(data.reserve.address)}</strong>
          </div>
        </>
      )}

      {DEPLOYMENT.contracts.Faucet && (
        <div className="row">
          <button
            data-testid="faucet-claim"
            disabled={!canClaim}
            onClick={onClaim}
            style={{ flex: 1 }}
          >
            {canClaim || !connected || !nextClaimAt
              ? "Claim test funds (USDC + collateral)"
              : `Faucet cools down ~${waitHours}h`}
          </button>
        </div>
      )}
    </div>
  );
}
