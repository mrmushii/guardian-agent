"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import s from "./console.module.css";
import f from "./funds.module.css";
import { Icon } from "./icons";
import { api } from "./model";
import { useSay } from "./detail";
import type { Ctl } from "./Hero";

type Funds = { address: string; network: string; isTestnet: boolean; eth: string; ethWei: string };

/** Fund the account without a terminal: address + QR, testnet faucets, and wrapping plain ETH into the tradable WETH. */
export function AddFunds({ ctl, onClose, onChanged }: { ctl: Ctl; onClose: () => void; onChanged: () => void }) {
  const { busy, run, masterSign, dash } = ctl;
  const say = useSay();
  const [funds, setFunds] = useState<Funds | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api<Funds>("/api/funds").then((r) => { setFunds(r); setErr(null); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (funds) QRCode.toDataURL(funds.address, { margin: 1, width: 360, color: { dark: "#111733", light: "#ffffff" } }).then(setQr).catch(() => setQr(null)); }, [funds?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  const eth = funds ? Number(funds.eth) : 0;
  // Leave a sliver of ETH behind; wrapping is gas-sponsored, but a little native ETH keeps the account flexible.
  const max = Math.max(0, Math.floor((eth - 0.0001) * 1e6) / 1e6);
  const copy = () => { if (!funds) return; void navigator.clipboard?.writeText(funds.address); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const wrap = () => run("wrap", async () => {
    const prepared = await api<{ userOperationId: string; userOpHash: `0x${string}` }>("/api/funds", { eth: amount });
    const done = await masterSign(prepared, say(`Wrapping ${amount} ETH into WETH`));
    setAmount(""); onChanged();
    return done;
  });

  return (
    <>
      <div className={s.scrim} onClick={onClose} />
      <aside className={`glass ${s.drawer}`} role="dialog" aria-modal="true" aria-label="Add funds">
        <div className={s.panelHead}><h2>Add funds</h2><button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>

        <section className={f.step}>
          <span className={f.num}>1</span>
          <div className={f.body}>
            <h3>Send ETH or USDC to your account</h3>
            <p className={s.lead}>From any wallet or exchange, on <b>{funds?.network ?? dash.network.name}</b>. Only send it on this network.</p>
            <div className={f.qrWrap}>{qr ? <img src={qr} alt="QR code of your account address" className={f.qr} /> : <div className={f.qrSkel} />}</div>
            <div className={f.addr}><code>{funds?.address ?? "…"}</code><button onClick={copy} disabled={!funds}><Icon name={copied ? "check" : "external"} size={14} />{copied ? "Copied" : "Copy"}</button></div>
            {(funds?.isTestnet ?? dash.network.isTestnet) && (
              <div className={f.faucets}>
                <span>Free test money:</span>
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">USDC faucet <Icon name="external" size={12} /></a>
                <a href="https://portal.cdp.coinbase.com/products/faucet" target="_blank" rel="noreferrer">ETH faucet <Icon name="external" size={12} /></a>
              </div>
            )}
          </div>
        </section>

        <section className={f.step}>
          <span className={f.num}>2</span>
          <div className={f.body}>
            <h3>{say("Make your ETH tradable")}</h3>
            <p className={s.lead}>The agent trades WETH (wrapped ETH), worth exactly 1 ETH each. Wrapping converts the plain ETH in your account, and you can unwrap it any time.</p>
            <div className={f.balance}><span>Plain ETH waiting</span><b>{funds ? `${eth.toFixed(6)} ETH` : "…"}</b></div>
            <div className={f.wrapRow}>
              <div className={s.field} style={{ flex: 1 }}>
                <input type="number" min={0} step={0.001} placeholder="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="ETH to wrap" />
              </div>
              <button className="ghost" disabled={!max} onClick={() => setAmount(String(max))}>Max</button>
              <button className="primary" disabled={!!busy || !Number(amount) || Number(amount) > eth} onClick={wrap}>{busy === "wrap" ? "Waiting for wallet…" : "Wrap"}</button>
            </div>
            {!!amount && Number(amount) > eth && <p className={s.error}>That's more than the {eth.toFixed(6)} ETH in your account.</p>}
            {dash.sandbox && <p className={s.fine}>The demo can't sign. Sign in with the owner wallet to wrap ETH.</p>}
          </div>
        </section>

        {err && <p className={s.error}>{err}</p>}
        <p className={s.fine}>New funds show up within a few seconds. If your mix moves outside your range, the agent rebalances it on its own.</p>
      </aside>
    </>
  );
}
