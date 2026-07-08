import { useCallback, useState } from "react";
import {
  getContracts,
  connectInjected,
  connectDevAccount,
  ensureAllowance,
  DEPLOYMENT,
} from "./lib/contracts";
import { useMarketData } from "./hooks/useMarketData";
import { fmtRate, fmtUsd, shortAddr, fmtClock } from "./lib/format";
import { Sparkline } from "./components/Sparkline";
import { PoolCard } from "./components/PoolCard";
import { BorrowPanel } from "./components/BorrowPanel";
import { PositionsPanel } from "./components/PositionsPanel";
import { OnboardPanel } from "./components/OnboardPanel";

let toastSeq = 0;

export default function App() {
  const [conn, setConn] = useState(null);
  const [toasts, setToasts] = useState([]);
  const { data, error, refresh } = useMarketData(conn?.address);

  const pushToast = useCallback((kind, label, detail) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, kind, label, detail }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 10000 : 6000);
  }, []);

  async function connect(kind, index) {
    try {
      const c = kind === "wallet" ? await connectInjected() : await connectDevAccount(index);
      setConn(c);
      pushToast("success", `Connected ${c.kind}`, shortAddr(c.address));
    } catch (e) {
      pushToast("error", "Connect failed", e.shortMessage || e.message);
    }
  }

  async function run(label, fn) {
    pushToast("pending", label, "confirm & wait…");
    try {
      await fn(getContracts(conn.signer));
      pushToast("success", label, "confirmed");
      refresh();
    } catch (e) {
      pushToast("error", `${label} failed`, e.reason || e.shortMessage || e.message);
    }
  }

  const onDeposit = (term, amount) =>
    run(`Lend ${fmtUsd(amount)}`, async (c) => {
      await ensureAllowance(c.stable, conn.address, DEPLOYMENT.contracts.RepoMarket, amount);
      await (await c.market.deposit(term, amount)).wait();
    });

  const onWithdraw = (term, shares) =>
    run("Withdraw", async (c) => {
      await (await c.market.withdraw(term, shares)).wait();
    });

  const onOpenRepo = (term, token, collateralAmount, borrowAmount) =>
    run(`Open repo ${fmtUsd(borrowAmount)}`, async (c) => {
      await ensureAllowance(
        c.collateral[token],
        conn.address,
        DEPLOYMENT.contracts.RepoMarket,
        collateralAmount
      );
      await (await c.market.openRepo(term, token, collateralAmount, borrowAmount)).wait();
    });

  const onClose = (id) =>
    run(`Close repo #${id}`, async (c) => {
      const debt = await c.market.currentDebt(id);
      // Approve with headroom: interest accrues until the tx mines.
      await ensureAllowance(c.stable, conn.address, DEPLOYMENT.contracts.RepoMarket, debt + debt / 100n);
      await (await c.market.closeRepo(id)).wait();
    });

  const onRoll = (id) =>
    run(`Roll repo #${id}`, async (c) => {
      const debt = await c.market.currentDebt(id);
      await ensureAllowance(c.stable, conn.address, DEPLOYMENT.contracts.RepoMarket, debt);
      await (await c.market.rollRepo(id)).wait();
    });

  const onLiquidate = (id) =>
    run(`Liquidate repo #${id}`, async (c) => {
      const debt = await c.market.currentDebt(id);
      await ensureAllowance(c.stable, conn.address, DEPLOYMENT.contracts.RepoMarket, debt + debt / 100n);
      await (await c.market.liquidate(id)).wait();
    });

  const onClaim = () =>
    run("Claim test funds", async (c) => {
      await (await c.faucet.claim()).wait();
    });

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <h1>Meridian</h1>
          <span className="tag">the on-chain repo market for tokenized assets</span>
        </div>
        <div className="spacer" />
        <div className="wallet">
          {data?.user && (
            <span className="pill">
              <strong>{fmtUsd(data.user.usdcBalance)}</strong> USDC
            </span>
          )}
          {conn ? (
            <span className="pill" data-testid="account-pill">
              {conn.kind} · <strong>{shortAddr(conn.address)}</strong>
            </span>
          ) : data?.demo ? (
            <span className="pill" data-testid="demo-pill">
              <strong>Demo snapshot</strong> · read-only
            </span>
          ) : (
            <>
              <button onClick={() => connect("wallet")} disabled={!window.ethereum}>
                Connect wallet
              </button>
              <button className="ghost" data-testid="dev-connect" onClick={() => connect("dev", 3)}>
                Dev account
              </button>
            </>
          )}
        </div>
      </header>

      {!data && !error && <div className="offline">Loading market…</div>}

      {error && !data && (
        <div className="offline">
          <p>
            <strong>Can't reach the market</strong> at <code>{DEPLOYMENT.rpcUrl}</code>.
          </p>
          <p>
            Start a local node and deploy: <code>npx hardhat node</code> then{" "}
            <code>npx hardhat run scripts/deploy.js --network localhost</code> and{" "}
            <code>npx hardhat run scripts/seed.js --network localhost</code>
          </p>
        </div>
      )}

      {data && (
        <>
          {data.demo && (
            <div className="demo-banner">
              You're viewing a captured snapshot of a seeded local market — actions are disabled.
              For live mode, run the stack locally (see the README) — the app connects to your node
              automatically.
            </div>
          )}
          <section className="card mor-panel" data-testid="mor-panel">
            <div className="stat-hero">
              <div className="label">MOR · Meridian Overnight Rate</div>
              <div className="value">{data.mor ? fmtRate(data.mor.rate) : "—"}</div>
              <div className="meta">
                {data.mor?.twar1d != null && <>1d TWAR {fmtRate(data.mor.twar1d)} · </>}
                {data.mor ? `updated ${fmtClock(data.mor.updatedAt)}` : "no prints yet"}
              </div>
            </div>
            <Sparkline points={data.history} />
          </section>

          <section className="grid-pools">
            {data.pools.map((pool) => (
              <PoolCard
                key={pool.id}
                pool={pool}
                position={data.user?.positions.find((p) => p.term === pool.id)}
                connected={!!conn}
                onDeposit={onDeposit}
                onWithdraw={onWithdraw}
              />
            ))}
          </section>

          <section className="grid-two">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <OnboardPanel data={data} connected={!!conn} onClaim={onClaim} />
              <BorrowPanel data={data} connected={!!conn} onOpenRepo={onOpenRepo} />
            </div>
            <PositionsPanel
              data={data}
              address={conn?.address}
              onClose={onClose}
              onRoll={onRoll}
              onLiquidate={onLiquidate}
            />
          </section>
        </>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="t-label">{t.label}</div>
            {t.detail && <div className="t-detail">{t.detail}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
