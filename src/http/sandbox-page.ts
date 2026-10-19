const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The page a sandbox session's `open_url` next_action points to: where a
 * real provider would show its checkout or KYC widget. It shows no session
 * data (it isn't authenticated); the session moves on by itself.
 */
export function sandboxCheckoutPage(sessionId: string): string {
  const id = escape(sessionId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rampart sandbox</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --ink:#16171a; --mute:#6b6f76; --line:#e2e0da; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111214; --card:#1a1c20; --ink:#eef0f4; --mute:#9aa0aa; --line:#2a2e36; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, sans-serif; padding:16px; }
  .card { max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:16px; padding:28px; }
  .tag { display:inline-block; font:600 12px ui-monospace, monospace; letter-spacing:.08em; text-transform:uppercase; border:1px solid var(--line); border-radius:999px; padding:4px 10px; color:var(--mute); }
  h1 { font-size:22px; margin:14px 0 8px; }
  p { color:var(--mute); margin:8px 0; }
  code { font:13px ui-monospace, monospace; word-break:break-all; }
</style>
</head>
<body>
  <main class="card">
    <span class="tag">Test mode</span>
    <h1>Sandbox checkout</h1>
    <p>This is where a real provider's payment or identity check would appear. Nothing is charged and nothing is sent on Stellar.</p>
    <p>The session moves through its scenario by itself. To skip ahead in tests, call <code>POST /v1/sandbox/sessions/${id}/advance</code> (or <code>ramp.sandbox.advance()</code> in the SDK).</p>
    <p>Session <code>${id}</code></p>
    <p>You can close this window.</p>
  </main>
</body>
</html>`;
}
