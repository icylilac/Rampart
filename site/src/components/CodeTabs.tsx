import { type ReactNode, useState } from "react";
import { CODE } from "../content";

/** Minimal highlighting: strings, comments and a few keywords. */
function highlight(code: string) {
  const re = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(import|from|const|new|await|return|if)\b/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(re)) {
    out.push(code.slice(last, m.index));
    const cls = m[1] ? "c" : m[2] ? "s" : "k";
    out.push(
      <span key={m.index} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(code.slice(last));
  return out;
}

export function CodeTabs() {
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const current = CODE[tab];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: nothing to do.
    }
  };

  return (
    <div className="code">
      <div className="code-tabs" role="tablist">
        {CODE.map((c, i) => (
          <button key={c.tab} role="tab" aria-selected={i === tab} className={i === tab ? "on" : ""} onClick={() => setTab(i)}>
            {c.tab}
          </button>
        ))}
        <span className="code-file">{current.file}</span>
        <button className="code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{highlight(current.code)}</code>
      </pre>
    </div>
  );
}
