import { useMemo, useRef, useState } from "react";
import { fmtRate, fmtClock } from "../lib/format";

const W = 640;
const H = 132;
const PAD = { top: 12, right: 12, bottom: 20, left: 44 };

/**
 * Single-series MOR sparkline. Rates hold between prints, so the line is a
 * step-after path. Hover shows a crosshair + tooltip with the print value.
 */
export function Sparkline({ points }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  const model = useMemo(() => {
    if (!points || points.length === 0) return null;
    const now = Math.floor(Date.now() / 1000);
    const pts = points.map((p) => ({ t: Number(p.t), rate: Number(p.rate) }));
    // Extend the last print to "now" so the line reaches the right edge.
    pts.push({ t: Math.max(now, pts[pts.length - 1].t + 1), rate: pts[pts.length - 1].rate });

    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const rates = pts.map((p) => p.rate);
    let rMin = Math.min(...rates);
    let rMax = Math.max(...rates);
    if (rMax === rMin) {
      rMin -= 50;
      rMax += 50;
    }
    const padR = (rMax - rMin) * 0.15;
    rMin = Math.max(0, rMin - padR);
    rMax += padR;

    const x = (t) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (r) => PAD.top + (1 - (r - rMin) / (rMax - rMin)) * (H - PAD.top - PAD.bottom);

    let d = `M ${x(pts[0].t)} ${y(pts[0].rate)}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` H ${x(pts[i].t)} V ${y(pts[i].rate)}`; // step-after
    }
    const area = `${d} V ${H - PAD.bottom} H ${x(pts[0].t)} Z`;

    return { pts, x, y, d, area, rMin, rMax, t0, t1 };
  }, [points]);

  if (!model) {
    return <div className="empty">No overnight prints yet — the first repo action writes one.</div>;
  }

  const { pts, x, y, d, area, rMin, rMax } = model;
  const gridRates = [rMin + (rMax - rMin) * 0.25, rMin + (rMax - rMin) * 0.75];

  function onMove(e) {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    // Rate live at px = last print at or before that x (step semantics).
    let best = pts[0];
    for (const p of pts) {
      if (x(p.t) <= px) best = p;
      else break;
    }
    setHover({ px: Math.min(Math.max(px, PAD.left), W - PAD.right), point: best, rectW: rect.width });
  }

  return (
    <div
      className="sparkline-wrap"
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="MOR overnight rate history">
        {gridRates.map((r, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(r)} y2={y(r)} stroke="#35342b" strokeWidth="1" />
            <text x={PAD.left - 8} y={y(r) + 4} textAnchor="end" fontSize="11" fill="#94918b">
              {fmtRate(Math.round(r))}
            </text>
          </g>
        ))}
        <path d={area} fill="#ccff00" opacity="0.1" />
        <path d={d} fill="none" stroke="#ccff00" strokeWidth="2" strokeLinejoin="round" />
        {hover && (
          <g>
            <line x1={hover.px} x2={hover.px} y1={PAD.top} y2={H - PAD.bottom} stroke="#4a4840" strokeWidth="1" />
            <circle cx={hover.px} cy={y(hover.point.rate)} r="4" fill="#ccff00" stroke="#1c1b15" strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="chart-tooltip" style={{ left: (hover.px / W) * hover.rectW, top: y(hover.point.rate) * 0.9 }}>
          <div>
            <strong>{fmtRate(hover.point.rate)}</strong>
          </div>
          <div className="when">{fmtClock(hover.point.t)}</div>
        </div>
      )}
    </div>
  );
}
