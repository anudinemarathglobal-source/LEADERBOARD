import { useEffect, useRef, useState, useCallback } from "react";

/* ---------- CONFIG ---------- */
const API_URL = import.meta.env.VITE_API_URL || "/api/leaderboard";
const POPUP_MS = 10 * 1000; // popup stays 10 seconds
const REFRESH_MS = 60 * 1000; // poll every minute (sheet itself updates hourly)

async function fetchSheet() {
  const res = await fetch(API_URL, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "API error");
  return json.rows.map((r) => ({ ...r, remaining: Math.max(0, r.target - r.won) }));
}

/* ---------- SOUND (no audio file needed) ---------- */
function playChime(ctx) {
  if (!ctx) return;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    const t = ctx.currentTime + i * 0.15;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.55);
  });
}

/* ---------- APP ---------- */
export default function App() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState(null);
  const [queue, setQueue] = useState([]); // achievement popups
  const [soundOn, setSoundOn] = useState(false);
  const audioRef = useRef(null);
  const soundRef = useRef(false);
  
  // local date (not UTC) so the reset happens at local midnight
  const localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const SEEN_PREFIX = "achieved-v3:";

  const enableSound = () => {
    audioRef.current = new (window.AudioContext || window.webkitAudioContext)();
    audioRef.current.resume();
    soundRef.current = true;
    setSoundOn(true);
    playChime(audioRef.current); // test
  };

  const load = useCallback(async () => {
    try {
      const data = await fetchSheet();
      setRows(data);
      setUpdated(new Date());
      setError("");

      // --- who has already been announced today? (resets every new day) ---
      const key = SEEN_PREFIX + localDay();
      let seen = [];
      try { seen = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
      // delete stored lists from previous days
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith(SEEN_PREFIX) && k !== key)
          .forEach((k) => localStorage.removeItem(k));
      } catch {}

      // --- only NEWLY achieved agents ---
      const fresh = data.filter(
        (r) => r.target > 0 && r.won >= r.target && !seen.includes(r.agent)
      );
      console.log(
        "[leaderboard] synced",
        data.length, "agents | already announced:", seen, "| new:", fresh.map((f) => f.agent)
      );
      if (fresh.length) {
        try { localStorage.setItem(key, JSON.stringify([...seen, ...fresh.map((f) => f.agent)])); } catch {}
        setQueue((q) => [...q, ...fresh]);
        if (soundRef.current) playChime(audioRef.current);
      }
    } catch (e) {
      setError(e.message + " — is the backend (server.py) running?");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    // browsers slow down timers in background tabs: refresh as soon as the tab is visible again
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const ranked = [...rows].sort(
    (a, b) => ratio(b) - ratio(a) || b.won - a.won
  );
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const popup = queue[0];

  // auto-close each popup after 10 seconds
  useEffect(() => {
    if (!popup) return;
    const t = setTimeout(() => setQueue((q) => q.slice(1)), POPUP_MS);
    return () => clearTimeout(t);
  }, [popup]);

  return (
    <div className="wrap">
      <style>{css}</style>

      <header>
        <div>
          <h1>🏆 Sales Leaderboard</h1>
          <p className="muted">
            {updated ? `Last synced ${updated.toLocaleTimeString()}` : "Loading…"} · auto-refresh every minute
          </p>
        </div>
        <button className={soundOn ? "btn on" : "btn"} onClick={enableSound} disabled={soundOn}>
          {soundOn ? "🔔 Sound on" : "🔇 Enable sound"}
        </button>
      </header>

      {error && <div className="err">{error}</div>}

      <section className="stats">
        <Stat label="Today target" value={sum("target")} />
        <Stat label="Won" value={sum("won")} />
        <Stat label="Qty" value={sum("qty")} />
        <Stat label="Remaining" value={sum("remaining")} warn />
        <Stat label="Month backlog" value={sum("totalBacklog")} warn />
      </section>

      <div className="table">
        <div className="tr th">
          <span>#</span><span>Agent</span><span>Progress</span>
          <span>Target</span><span>Won</span><span>From leads</span>
          <span>Qty</span><span>Remaining</span><span>Month backlog</span>
        </div>
        {ranked.map((r, i) => {
          const pct = r.target > 0 ? Math.min(100, Math.round((r.won / r.target) * 100)) : 0;
          const done = r.target > 0 && r.won >= r.target;
          return (
            <div key={r.agent} className={"tr" + (done ? " done" : "")}>
              <span className="rank">{["🥇", "🥈", "🥉"][i] || i + 1}</span>
              <span className="name">{r.agent}{done && " ✅"}</span>
              <span className="bar"><i style={{ width: pct + "%" }} /><b>{pct}%</b></span>
              <span>{r.target}</span>
              <span>{r.won}</span>
              <span>{r.fromLeads}</span>
              <span className="qty">{r.qty}</span>
              <span className={r.remaining > 0 ? "bad" : "good"}>{r.remaining}</span>
              <span>{r.totalBacklog}</span>
            </div>
          );
        })}
      </div>

      {popup && (
        <div className="overlay" onClick={() => setQueue((q) => q.slice(1))}>
          <div key={popup.agent} className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="close" aria-label="Close" onClick={() => setQueue((q) => q.slice(1))}>✕</button>
            <div className="emoji">🎉</div>
            <h2>Target Achieved!</h2>
            <p><b>{popup.agent}</b> has achieved today's target of {popup.target} with <b>{popup.won}</b> won. Great work!</p>
            <div className="timer"><i style={{ animationDuration: POPUP_MS + "ms" }} /></div>
            <button className="btn on" onClick={() => setQueue((q) => q.slice(1))}>
              {queue.length > 1 ? `Next (${queue.length - 1} more)` : "Close"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// agents with no target go to the bottom of the ranking
const ratio = (r) => (r.target > 0 ? r.won / r.target : -1);

const Stat = ({ label, value, warn }) => (
  <div className="stat">
    <span className="muted">{label}</span>
    <strong className={warn ? "bad" : ""}>{value}</strong>
  </div>
);

const css = `
:root{--bg:#0b1b3a;--card:#13294f;--line:#22406e;--txt:#eef3ff;--mut:#9fb3d6;--ok:#4ade80;--bad:#fb7185;--acc:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:28px}.muted{color:var(--mut);margin:4px 0 0;font-size:13px}
.btn{background:var(--card);color:var(--txt);border:1px solid var(--line);padding:10px 16px;border-radius:10px;cursor:pointer;font-weight:600}
.btn.on{background:var(--acc);color:#222;border-color:var(--acc)}
.err{background:#4c1d2b;border:1px solid var(--bad);padding:12px;border-radius:10px;margin:16px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:6px}
.stat strong{font-size:28px}.bad{color:var(--bad)}.good{color:var(--ok)}
.table{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
.tr{display:grid;grid-template-columns:50px 1.5fr 1.6fr repeat(6,.8fr);min-width:900px;align-items:center;padding:12px 14px;border-top:1px solid var(--line);gap:8px}
.th{border:0;color:var(--mut);font-size:12px;text-transform:uppercase;background:#0e2244}
.tr.done{background:rgba(74,222,128,.1)}.name{font-weight:700}.qty{font-weight:700;color:var(--acc)}
.bar{position:relative;height:20px;background:#0b1b3a;border-radius:99px;overflow:hidden}
.bar i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#3b82f6,var(--ok));border-radius:99px}
.bar b{position:relative;font-size:11px;display:block;text-align:center;line-height:20px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:grid;place-items:center;z-index:10}
.modal{position:relative;background:var(--card);border:2px solid var(--acc);border-radius:20px;padding:32px;max-width:400px;text-align:center;animation:pop .35s}
.close{position:absolute;top:10px;right:10px;width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:#0b1b3a;color:var(--txt);cursor:pointer;font-size:14px;line-height:1}.close:hover{background:var(--bad)}
.timer{height:4px;background:#0b1b3a;border-radius:99px;margin:16px 0;overflow:hidden}.timer i{display:block;height:100%;background:var(--acc);animation:shrink linear forwards}
@keyframes shrink{from{width:100%}to{width:0}}
.modal h2{color:var(--acc);margin:8px 0}.emoji{font-size:56px}
@keyframes pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
`;