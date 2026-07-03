import { ethers } from "ethers";

export const fmtUsd = (v, decimals = 6, frac = 2) =>
  "$" +
  Number(ethers.formatUnits(v ?? 0n, decimals)).toLocaleString("en-US", {
    maximumFractionDigits: frac,
  });

export const fmtToken = (v, decimals, symbol, frac = 2) =>
  Number(ethers.formatUnits(v ?? 0n, decimals)).toLocaleString("en-US", {
    maximumFractionDigits: frac,
  }) + (symbol ? ` ${symbol}` : "");

export const fmtRate = (bps) => `${(Number(bps ?? 0n) / 100).toFixed(2)}%`;

export const fmtPctOfBps = (bps) => `${(Number(bps ?? 0n) / 100).toFixed(1)}%`;

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function fmtMaturity(maturity, now = Math.floor(Date.now() / 1000)) {
  const secs = Number(maturity) - now;
  if (secs <= 0) return "matured";
  if (secs < 3600) return `${Math.ceil(secs / 60)}m left`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m left`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h left`;
}

export function fmtClock(ts) {
  return new Date(Number(ts) * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
