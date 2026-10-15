import { useEffect, useRef, useState, useCallback } from "react";

/* ---------- CONFIG ---------- */
const API_URL = import.meta.env.VITE_API_URL || "/api/leaderboard";
const POPUP_MS = 10 * 1000; // popup stays 10 seconds
const RESET_HOUR = 11; // announced list resets daily at 11:00 AM (24h clock, local time)
const REFRESH_MS = 10 * 1000; // poll every 10 seconds

async function fetchSheet() {
  const res = await fetch(API_URL, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "API error");
  if (json.missing?.length) console.warn("[leaderboard] sheet columns not found:", json.missing);
  return json.rows.map((r) => ({ ...r, remaining: Math.max(0, r.target - r.won) }));
}

/* ---------- SOUND (synthesised, no audio file needed) ---------- */
function noiseBuffer(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// fanfare + crowd cheering + applause (~4 seconds)
function playCheer(ctx) {
  if (!ctx) return;
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  // 1) fanfare
  [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    const t = now + i * 0.13;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (i === 6 ? 0.9 : 0.35));
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 1);
  });

  // 2) crowd roar: band-passed noise that swells and fades
  const roar = ctx.createBufferSource();
  roar.buffer = noiseBuffer(ctx, 4);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(700, now + 0.5);
  bp.frequency.linearRampToValueAtTime(1500, now + 1.6);
  bp.frequency.linearRampToValueAtTime(900, now + 3.8);
  bp.Q.value = 0.7;
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0.0001, now + 0.5);
  rg.gain.exponentialRampToValueAtTime(0.5, now + 1.3);
  rg.gain.setValueAtTime(0.5, now + 2.4);
  rg.gain.exponentialRampToValueAtTime(0.0001, now + 4);
  roar.connect(bp).connect(rg).connect(master);
  roar.start(now + 0.5);

  // 3) "whoooo" cheers: two voices with vibrato and rising pitch
  [0.7, 1.2].forEach((delay, k) => {
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = "sawtooth";
    const t = now + delay;
    o.frequency.setValueAtTime(k ? 380 : 300, t);
    o.frequency.exponentialRampToValueAtTime(k ? 640 : 520, t + 0.7);
    lfo.frequency.value = 6; lg.gain.value = 12;
    lfo.connect(lg).connect(o.frequency);
    f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(f).connect(g).connect(master);
    o.start(t); lfo.start(t);
    o.stop(t + 1.2); lfo.stop(t + 1.2);
  });

  // 4) applause: lots of tiny random claps
  const clap = noiseBuffer(ctx, 0.05);
  for (let i = 0; i < 90; i++) {
    const src = ctx.createBufferSource(), g = ctx.createGain(), hp = ctx.createBiquadFilter();
    src.buffer = clap;
    hp.type = "highpass"; hp.frequency.value = 1500 + Math.random() * 2500;
    const t = now + 0.9 + Math.random() * 3;
    const vol = 0.25 * (1 - (t - now - 0.9) / 3.5);
    g.gain.setValueAtTime(Math.max(vol, 0.03), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp).connect(g).connect(master);
    src.start(t);
  }
}

/* ---------- APP ---------- */
export default function App() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState(null);
  const [queue, setQueue] = useState([]); // achievement popups
  const [soundOn, setSoundOn] = useState(true);       // sound is ON by default
  const [audioReady, setAudioReady] = useState(false); // browser has allowed audio yet?
  const audioRef = useRef(null);
  const soundRef = useRef(true);
  const pendingRef = useRef(false); // a cheer was due before audio was unlocked

  // "Sales day" key: the announced list resets every day at RESET_HOUR (11 AM local time),
  // not at midnight. Before 11:00 we still count as the previous day.
  const localDay = () => {
    const d = new Date(Date.now() - RESET_HOUR * 60 * 60 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const SEEN_PREFIX = "achieved-v3:";

  // Browsers only allow audio after the user has interacted with the page once.
  // Sound is ON from the start; the first click / key / touch anywhere unlocks it.
  const unlockAudio = useCallback(() => {
    try {
      if (!audioRef.current) {
        audioRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      audioRef.current.resume().then(() => {
        setAudioReady(true);
        if (pendingRef.current && soundRef.current) {
          pendingRef.current = false;
          playCheer(audioRef.current);
        }
      });
    } catch {}
  }, []);

  useEffect(() => {
    const events = ["pointerdown", "mousedown", "click", "keydown", "touchstart", "touchend"];
    const handler = () => {
      unlockAudio();
      events.forEach((e) => window.removeEventListener(e, handler));
    };
    events.forEach((e) => window.addEventListener(e, handler));
    // only start now if the user has already interacted with this page before
    if (navigator.userActivation?.hasBeenActive) unlockAudio();
    return () => events.forEach((e) => window.removeEventListener(e, handler));
  }, [unlockAudio]);

  const toggleSound = () => {
    const next = !soundRef.current;
    soundRef.current = next;
    setSoundOn(next);
    unlockAudio();
    if (next) setTimeout(() => playCheer(audioRef.current), 100); // preview
  };

  const load = useCallback(async () => {
    try {
      const data = await fetchSheet();
      setRows(data);
      setUpdated(new Date());
      setError("");

      // --- who has already been announced in the current sales day? (resets at RESET_HOUR) ---
      const key = SEEN_PREFIX + localDay();
      let seen = [];
      try { seen = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
      // delete stored lists from previous days
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith(SEEN_PREFIX) && k !== key)
          .forEach((k) => localStorage.removeItem(k));
      } catch {}

      // --- who is at/above target RIGHT NOW (checked on every sync) ---
      const achievedNow = new Set(
        data.filter((r) => r.target > 0 && r.won >= r.target).map((r) => r.agent)
      );

      // forget agents who have dropped back below target, so they are announced
      // again if they reach it again later the same day
      const stillAchieved = seen.filter((a) => achievedNow.has(a));
      const removed = seen.filter((a) => !achievedNow.has(a));

      // only NEWLY achieved agents get a popup
      const fresh = data.filter((r) => achievedNow.has(r.agent) && !stillAchieved.includes(r.agent));
      const nextSeen = [...stillAchieved, ...fresh.map((f) => f.agent)];

      if (removed.length || fresh.length) {
        try { localStorage.setItem(key, JSON.stringify(nextSeen)); } catch {}
      }
      console.log(
        "[leaderboard] synced", data.length, "agents |",
        "announced:", nextSeen, "| new:", fresh.map((f) => f.agent), "| removed (below target):", removed
      );

      // drop queued popups of agents who are no longer at target, then add the new ones
      setQueue((q) => [...q.filter((p) => achievedNow.has(p.agent)), ...fresh]);

      if (fresh.length && soundRef.current) {
        if (audioRef.current && audioRef.current.state === "running") playCheer(audioRef.current);
        else pendingRef.current = true; // play as soon as the browser allows audio
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
            {updated ? `Last synced ${updated.toLocaleTimeString()}` : "Loading…"} · auto-refresh every 10 seconds
          </p>
        </div>
        <button className={soundOn && audioReady ? "btn on" : "btn"} onClick={toggleSound}>
          {!soundOn ? "🔇 Muted (click to unmute)" : audioReady ? "🔔 Sound on (click to mute)" : "🔊 Sound on – click once to activate"}
        </button>
      </header>

      {error && <div className="err">{error}</div>}

      <section className="stats">
        <Stat label="Today target" value={sum("target")} />
        <Stat label="Won" value={sum("won")} />
        {/* <Stat label="Target leads" value={sum("targetLeads")} /> */}
        <Stat label="Today leads" value={sum("todayLeads")} />
        <Stat label="Oud Al Salam" value={sum("oudAlSalam")} />
        <Stat label="Bahrain" value={sum("bahrain")} />
        <Stat label="Qty" value={sum("qty")} />
        <Stat label="Remaining" value={sum("remaining")} warn />
        <Stat label="Month backlog" value={sum("totalBacklog")} warn />
      </section>

      <div className="table">
        <div className="tr th">
          <span>#</span><span>Agent</span><span>Progress</span>
          {/* <span>Target leads</span> */}
          <span>Today leads</span>
          <span>Target</span><span>Won</span>
          <span>From leads</span>
          <span>Qty</span><span>Oud Al Salam</span><span>Bahrain</span>
          <span>Remaining</span><span>Month backlog</span>
        </div>
        {ranked.map((r, i) => {
          const pct = r.target > 0 ? Math.min(100, Math.round((r.won / r.target) * 100)) : 0;
          const done = r.target > 0 && r.won >= r.target;
          return (
            <div key={r.agent} className={"tr" + (done ? " done" : "")}>
              <span className="rank">{["🥇", "🥈", "🥉"][i] || i + 1}</span>
              <span className="name">{r.agent}{done && " ✅"}</span>
              <span className="bar"><i style={{ width: pct + "%" }} /><b>{pct}%</b></span>
              {/* <span>{r.targetLeads}</span> */}
              <span>{r.todayLeads}</span>
              <span>{r.target}</span>
              <span>{r.won}</span>
              <span>{r.fromLeads}</span>
              <span className="qty">{r.qty}</span>
              <span>{r.oudAlSalam}</span>
              <span>{r.bahrain}</span>
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
.wrap{max-width:1600px;margin:0 auto;padding:10px 14px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:22px}.muted{color:var(--mut);margin:4px 0 0;font-size:12px}
.btn{background:var(--card);color:var(--txt);border:1px solid var(--line);padding:6px 12px;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px}
.btn.on{background:var(--acc);color:#222;border-color:var(--acc)}
.err{background:#4c1d2b;border:1px solid var(--bad);padding:8px 12px;border-radius:8px;margin:8px 0;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px;margin:12px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:0}.stat .muted{font-size:11px;margin:0}
.stat strong{font-size:20px;line-height:1.2}.bad{color:var(--bad)}.good{color:var(--ok)}
.table{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow-x:auto;font-size:13px}
.tr{display:grid;grid-template-columns:36px 1.9fr 1.3fr repeat(9,.75fr);min-width:1100px;align-items:center;padding:10px 10px;border-top:1px solid var(--line);gap:6px}
.th{border:0;color:var(--mut);font-size:11px;text-transform:uppercase;background:#0e2244}
.tr.done{background:rgba(74,222,128,.1)}.name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qty{font-weight:700;color:var(--acc)}
.bar{position:relative;height:16px;background:#0b1b3a;border-radius:99px;overflow:hidden}
.bar i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#3b82f6,var(--ok));border-radius:99px}
.bar b{position:relative;font-size:10px;display:block;text-align:center;line-height:16px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:grid;place-items:center;z-index:10}
.modal{position:relative;background:var(--card);border:2px solid var(--acc);border-radius:20px;padding:32px;max-width:400px;text-align:center;animation:pop .35s}
.close{position:absolute;top:10px;right:10px;width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:#0b1b3a;color:var(--txt);cursor:pointer;font-size:14px;line-height:1}.close:hover{background:var(--bad)}
.timer{height:4px;background:#0b1b3a;border-radius:99px;margin:16px 0;overflow:hidden}.timer i{display:block;height:100%;background:var(--acc);animation:shrink linear forwards}
@keyframes shrink{from{width:100%}to{width:0}}
.modal h2{color:var(--acc);margin:8px 0}.emoji{font-size:56px}
@keyframes pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
`;