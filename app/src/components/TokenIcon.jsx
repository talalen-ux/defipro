import tbill from "../assets/token-tbill.svg";
import tcred from "../assets/token-tcred.svg";
import usdc from "../assets/token-usdc.svg";

const ICONS = { tBILL: tbill, tCRED: tcred, USDC: usdc };

export function TokenIcon({ symbol, size = 18 }) {
  const src = ICONS[symbol];
  if (!src) return null;
  return <img className="token-ico" src={src} alt="" width={size} height={size} />;
}
