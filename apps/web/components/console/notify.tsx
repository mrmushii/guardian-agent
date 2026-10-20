"use client";
import { useEffect, useRef, useState } from "react";
import s from "./console.module.css";
import { tasksOf, type Dash } from "./model";
import { useSay } from "./detail";

const KEY = "guardian.notify";
const supported = () => typeof window !== "undefined" && "Notification" in window;
const wanted = () => { try { return localStorage.getItem(KEY) === "on"; } catch { return false; } };

/**
 * Desktop notification when a new approval appears (works while the tab is in the background), and a "(n)" count in the
 * tab title. Approvals expire after 30 minutes, so the owner should not have to keep the dashboard in view.
 */
export function useTaskAlerts(dash: Dash | null) {
  const say = useSay();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!dash) return;
    const tasks = tasksOf(dash), approvals = tasks.filter((t) => t.kind === "approve" && t.action);
    document.title = tasks.length ? `(${tasks.length}) Guardian` : "Guardian";
    const ids = new Set(approvals.map((t) => t.action!.id));
    // The first load only records what already exists; alert on approvals that appear afterwards.
    if (seen.current && supported() && wanted() && Notification.permission === "granted")
      for (const t of approvals) if (!seen.current.has(t.action!.id)) {
        const n = new Notification("Guardian needs your OK", { body: say(`${t.title}. Approve or decline within 30 minutes.`), tag: t.action!.id });
        n.onclick = () => { window.focus(); location.hash = "overview"; n.close(); };
      }
    seen.current = ids;
  }, [dash, say]);
}

/** Settings switch; turning it on asks the browser for permission. */
export function NotifySwitch() {
  const [on, setOn] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => { setOn(wanted() && supported() && Notification.permission === "granted"); setDenied(supported() && Notification.permission === "denied"); }, []);
  const toggle = async (next: boolean) => {
    if (next && supported() && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      setDenied(p === "denied");
      if (p !== "granted") return;
    }
    try { localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* storage unavailable */ }
    setOn(next);
    if (next) new Notification("Guardian notifications are on", { body: "You'll get an alert here whenever a trade needs your OK." });
  };
  if (!supported()) return null;
  return (
    <label className={s.switch}>
      <input type="checkbox" role="switch" checked={on} disabled={denied} onChange={(e) => void toggle(e.target.checked)} />
      <i aria-hidden="true" />
      <span><b>Notify me when Guardian needs me</b><small>{denied ? "Notifications are blocked for this site. Allow them in your browser's site settings." : "A desktop alert when a trade waits for your signature, even if this tab is in the background."}</small></span>
    </label>
  );
}
