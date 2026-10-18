"use client";
import s from "./console.module.css";

const KEY = "guardian.onboarded";
export const seenOnboarding = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
const markSeen = () => { try { localStorage.setItem(KEY, "1"); } catch { /* storage unavailable */ } };

export function Onboarding({ onClose, maxAuto }: { onClose: () => void; maxAuto: number }) {
  const close = () => { markSeen(); onClose(); };
  return (
    <>
      <div className={`${s.scrim} ${s.modalScrim}`} onClick={close} />
      <div className={`glass ${s.modal}`} role="dialog" aria-modal="true" aria-label="How Guardian works">
        <h2 style={{ margin: 0, fontSize: "1.4rem", letterSpacing: "-0.02em" }}>How Guardian works</h2>
        <p className="muted" style={{ margin: "6px 0 0" }}>An AI agent that keeps your WETH/USDC mix in range — without ever holding your keys.</p>
        <div className={s.cards}>
          <div className={s.card}><span className={s.cardNum}>1</span><div><strong>You set the limits</strong><p>An allowed WETH range, a target, a per-trade cap and a daily budget. Your smart account enforces them on-chain.</p></div></div>
          <div className={s.card}><span className={s.cardNum}>2</span><div><strong>The agent watches and acts</strong><p>When WETH leaves the range, the AI decides, code builds the exact swap, and the agent signs trades up to ${maxAuto} with a limited key.</p></div></div>
          <div className={s.card}><span className={s.cardNum}>3</span><div><strong>Bigger moves ask you</strong><p>Anything above your limits appears in “Your tasks” for your wallet signature. You can pause or revoke the agent anytime.</p></div></div>
        </div>
        <button className="primary" onClick={close} style={{ width: "100%" }}>Got it</button>
      </div>
    </>
  );
}
