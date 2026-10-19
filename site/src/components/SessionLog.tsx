import { useEffect, useRef, useState } from "react";
import { SESSION_LOG } from "../content";

const STEP_MS = 700;

/** Plays the session log line by line once it scrolls into view; "Replay" starts it again. */
export function SessionLog() {
  const [shown, setShown] = useState(0);
  const [run, setRun] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) {
      setShown(SESSION_LOG.length);
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !started.current) {
        started.current = true;
        setRun((r) => r + 1);
      }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (run === 0) return;
    setShown(0);
    const timers = SESSION_LOG.map((_, i) => setTimeout(() => setShown(i + 1), (i + 1) * STEP_MS));
    return () => timers.forEach(clearTimeout);
  }, [run]);

  const state = [...SESSION_LOG.slice(0, shown)].reverse().find((l) => l.state)?.state ?? "…";
  const done = shown === SESSION_LOG.length;

  return (
    <div className="log" ref={ref}>
      <div className="log-head">
        <span className="mono-label">ramp_session · rs_44a12070</span>
        <span className={`log-state ${state === "COMPLETED" ? "is-done" : ""}`}>{state}</span>
      </div>
      <ol className="log-lines">
        {SESSION_LOG.map((l, i) => (
          <li key={i} className={`${i < shown ? "in" : ""} ${l.tone ?? ""}`}>
            <span className="log-t">{l.t}</span>
            <span className="log-src">{l.source}</span>
            <span className="log-ev">{l.event}</span>
            {l.state && <span className="log-tag">{l.state}</span>}
          </li>
        ))}
      </ol>
      <div className="log-foot">
        <span className="mono-label">{done ? "Delivered and receipted" : "Running…"}</span>
        <button className="btn btn-outline btn-sm" onClick={() => setRun((r) => r + 1)} disabled={!done}>
          Replay
        </button>
      </div>
    </div>
  );
}
