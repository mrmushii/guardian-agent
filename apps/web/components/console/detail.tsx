"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import s from "./console.module.css";
import { Icon } from "./icons";

/**
 * Simple vs. detailed view. Simple (the default) hides technical content: addresses, permission ids,
 * contract specs, model internals. Anything wrapped in <More> stays one click away either way;
 * "Show technical details" opens all of it. Elements with the global `tech` class are hidden in simple view.
 */
const KEY = "guardian.detail";
const Ctx = createContext<{ full: boolean; setFull: (v: boolean) => void }>({ full: false, setFull: () => {} });

export function DetailProvider({ children }: { children: React.ReactNode }) {
  const [full, setFullState] = useState(false);
  useEffect(() => { try { if (localStorage.getItem(KEY) === "full") setFullState(true); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { document.documentElement.dataset.detail = full ? "full" : "simple"; }, [full]);
  const setFull = useCallback((v: boolean) => { setFullState(v); try { localStorage.setItem(KEY, v ? "full" : "simple"); } catch { /* storage unavailable */ } }, []);
  return <Ctx.Provider value={{ full, setFull }}>{children}</Ctx.Provider>;
}

export const useDetail = () => useContext(Ctx);

/** Collapsed "Details" section; opens by itself when the user has switched technical details on. */
export function More({ label = "Technical details", children }: { label?: string; children: React.ReactNode }) {
  const { full } = useDetail();
  return (
    <details className={s.more} open={full} key={String(full)}>
      <summary><Icon name="chevron" size={14} />{label}</summary>
      <div className={s.moreBody}>{children}</div>
    </details>
  );
}

/** Simple view says "ETH": WETH is the tradable wrapper of ETH and the name confuses non-experts. Detailed view keeps WETH. */
export function useSay() {
  const { full } = useDetail();
  return useCallback((text: string) => (full ? text : text.replace(/\bWETH\b/g, "ETH")), [full]);
}

/** On/off switch for the whole app. */
export function DetailSwitch() {
  const { full, setFull } = useDetail();
  return (
    <label className={s.switch}>
      <input type="checkbox" role="switch" checked={full} onChange={(e) => setFull(e.target.checked)} />
      <i aria-hidden="true" />
      <span><b>Show technical details</b><small>Addresses, permission ids, contract specs and AI internals. Off keeps every screen simple.</small></span>
    </label>
  );
}
