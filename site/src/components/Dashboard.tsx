import { useCallback, useEffect, useState, type FormEvent } from "react";
import { GITHUB } from "../content";
import { api, ApiError, setToken, type ApiKey, type Project, type RampSession, type User } from "../lib/api";
import { Link, navigate } from "../lib/router";
import { shortAddress } from "../lib/wallet";
import { Icon } from "./Icon";

const DOCS = `${GITHUB}/blob/main/docs/reference.md`;

/** Secrets the API returns once; shown until the user dismisses them. */
type Reveal = { title: string; items: { label: string; value: string }[] };

const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function DashboardPage() {
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([api<User>("/v1/auth/me"), api<{ data: Project[] }>("/v1/dashboard/projects")]);
      setUser(me);
      setProjects(list.data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        navigate("/login?next=/dashboard&expired=1", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : "Could not load your projects.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page dash">
      <DashNav user={user} />

      <main>
        <section className="box section dash-head">
          <span className="mono-label">Dashboard</span>
          <h1>Projects</h1>
          <p className="muted">Each project gets a live key, a test key and a webhook secret. Test keys run on the sandbox.</p>
        </section>

        {reveal && <SecretsPanel reveal={reveal} onDone={() => setReveal(null)} />}

        <NewProject
          onCreated={(project, secrets) => {
            setProjects((p) => [project, ...(p ?? [])]);
            setReveal({
              title: `${project.name} is ready`,
              items: [
                { label: "Live API key", value: secrets.live_key },
                { label: "Test API key", value: secrets.test_key },
                { label: "Webhook secret", value: secrets.webhook_secret },
              ],
            });
          }}
        />

        {error && (
          <div className="box section">
            <p role="alert" className="form-error">
              {error}
            </p>
            <button className="btn btn-outline btn-sm" onClick={() => void load()}>
              Try again
            </button>
          </div>
        )}

        {projects === null && !error && <div className="box section muted">Loading…</div>}
        {projects?.length === 0 && (
          <div className="box section dash-empty">
            <p className="muted">No projects yet. Create one above to get your API keys.</p>
          </div>
        )}
        {projects?.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onChange={(next) => setProjects((all) => all?.map((x) => (x.id === next.id ? next : x)) ?? null)}
            onRemove={(id) => setProjects((all) => all?.filter((x) => x.id !== id) ?? null)}
            onSecret={setReveal}
          />
        ))}
      </main>

      <DashFooter />
    </div>
  );
}

export async function signOut(everywhere = false) {
  await api(everywhere ? "/v1/auth/logout-all" : "/v1/auth/logout", { method: "POST" }).catch(() => undefined);
  setToken(null);
  navigate("/login", { replace: true });
}

/** The signed-in footer. Docs live here too, since the header has no room for them on a phone. */
export function DashFooter() {
  return (
    <footer className="footer">
      <span className="nav-brand small">
        <img src="/icon.svg" alt="" />
        Rampart
      </span>
      <span className="footer-links">
        <a className="mono-label" href={DOCS} target="_blank" rel="noreferrer">
          Docs
        </a>
        <span className="mono-label">Secrets are shown once · Keys are stored as hashes</span>
      </span>
    </footer>
  );
}

/** The signed-in header: who you are (links to your account), docs, sign out. */
export function DashNav({ user }: { user: User | null }) {
  const who = user ? (user.email ?? shortAddress(user.wallet_address ?? "")) : "";
  return (
    <header className="nav box dash-nav">
      <Link to="/dashboard" className="nav-brand" aria-label="Rampart dashboard">
        <img src="/icon.svg" alt="" />
        <span>Rampart</span>
      </Link>
      <div className="nav-right">
        {user && (
          <Link to="/account" className="dash-who mono-label" title={`Account: ${user.email ?? user.wallet_address ?? ""}`}>
            {user.wallet_address && !user.email && <Icon name="wallet" />}
            <span className="dash-who-text">{who}</span>
          </Link>
        )}
        <a className="btn btn-outline hide-sm" href={DOCS} target="_blank" rel="noreferrer">
          Docs
        </a>
        <button className="btn btn-solid" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function NewProject({ onCreated }: { onCreated: (p: Project, s: { live_key: string; test_key: string; webhook_secret: string }) => void }) {
  const [name, setName] = useState("");
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the project a name.");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ project: Project; secrets: { live_key: string; test_key: string; webhook_secret: string } }>("/v1/dashboard/projects", {
        body: { name: name.trim(), webhook_url: webhook.trim() || null },
      });
      onCreated(res.project, res.secrets);
      setName("");
      setWebhook("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="box section new-project" onSubmit={(e) => void submit(e)} noValidate>
      <label className="field">
        <span className="mono-label">Project name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My wallet app" maxLength={80} />
      </label>
      <label className="field">
        <span className="mono-label">Webhook URL (optional)</span>
        <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://example.com/hooks/ramp" type="url" />
      </label>
      <button type="submit" className="btn btn-solid" disabled={busy}>
        <Icon name="plus" />
        {busy ? "Creating…" : "New project"}
      </button>
      {error && (
        <p role="alert" className="form-error new-project-error">
          {error}
        </p>
      )}
    </form>
  );
}

function ProjectCard({
  project,
  onChange,
  onRemove,
  onSecret,
}: {
  project: Project;
  onChange: (p: Project) => void;
  onRemove: (id: string) => void;
  onSecret: (r: Reveal) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = project.api_keys.filter((k) => !k.revoked_at);
  const revoked = project.api_keys.length - active.length;

  async function addKey(mode: "live" | "test") {
    setBusy(`add-${mode}`);
    setError(null);
    try {
      const res = await api<{ api_key: ApiKey; secret: string }>(`/v1/dashboard/projects/${project.id}/keys`, { body: { mode } });
      onChange({ ...project, api_keys: [...project.api_keys, res.api_key] });
      onSecret({ title: `New ${mode} key for ${project.name}`, items: [{ label: `${mode === "live" ? "Live" : "Test"} API key`, value: res.secret }] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${project.name}? Its API keys stop working immediately and webhooks stop. Its ramp history is kept.`)) return;
    setBusy("delete");
    setError(null);
    try {
      await api(`/v1/dashboard/projects/${project.id}`, { method: "DELETE" });
      onRemove(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the project.");
      setBusy(null);
    }
  }

  async function revoke(key: ApiKey) {
    if (!window.confirm(`Revoke ${key.prefix}…? Anything using it stops working immediately.`)) return;
    setBusy(key.id);
    setError(null);
    try {
      const updated = await api<ApiKey>(`/v1/dashboard/projects/${project.id}/keys/${key.id}`, { method: "DELETE" });
      onChange({ ...project, api_keys: project.api_keys.map((k) => (k.id === key.id ? updated : k)) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the key.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="box section project">
      <div className="project-head">
        <div>
          <ProjectName project={project} onChange={onChange} />
          <p className="mono-label">
            {project.id} · created {date(project.created_at)}
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => void addKey("test")}>
            <Icon name="plus" /> Add test key
          </button>
          <button className="btn btn-outline btn-sm" disabled={busy !== null} onClick={() => void addKey("live")}>
            <Icon name="plus" /> Add live key
          </button>
        </div>
      </div>

      <dl className="project-meta">
        <dt className="mono-label">Webhook</dt>
        <dd>
          <WebhookField project={project} onChange={onChange} />
        </dd>
      </dl>

      <ul className="keys" aria-label={`API keys for ${project.name}`}>
        {active.map((k) => (
          <li key={k.id} className="key-row">
            <span className={`key-mode ${k.mode}`}>{k.mode}</span>
            <code>{k.prefix}…</code>
            <span className="muted">{date(k.created_at)}</span>
            <button
              className="btn btn-outline btn-sm"
              disabled={busy !== null}
              onClick={() => void revoke(k)}
              aria-label={`Revoke ${k.mode} key ${k.prefix}`}
            >
              {busy === k.id ? "Revoking…" : "Revoke"}
            </button>
          </li>
        ))}
        {active.length === 0 && <li className="keys-none muted">No active keys.</li>}
      </ul>
      {revoked > 0 && <p className="mono-label keys-revoked">{revoked} revoked</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <Ramps project={project} />
      <div className="project-foot">
        <button className="link-btn danger" disabled={busy !== null} onClick={() => void remove()}>
          {busy === "delete" ? "Deleting…" : "Delete project"}
        </button>
      </div>
    </article>
  );
}

/** The project's name, renamable in place. */
function ProjectName({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return setError("Give the project a name.");
    setBusy(true);
    setError(null);
    try {
      onChange(await api<Project>(`/v1/dashboard/projects/${project.id}`, { method: "PATCH", body: { name: value.trim() } }));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the project.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="project-title">
        <h2>{project.name}</h2>
        <button
          className="link-btn"
          onClick={() => {
            setValue(project.name);
            setEditing(true);
          }}
          aria-label={`Rename ${project.name}`}
        >
          Rename
        </button>
      </div>
    );
  }
  return (
    <form className="inline-edit project-rename" onSubmit={(e) => void save(e)} noValidate>
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} aria-label="Project name" />
      <button type="submit" className="btn btn-solid btn-sm" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}

/** The webhook URL, editable in place. Empty removes it. */
function WebhookField({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.webhook_url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api<Project>(`/v1/dashboard/projects/${project.id}`, { method: "PATCH", body: { webhook_url: value.trim() || null } });
      onChange(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the webhook URL.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="inline-field">
        {project.webhook_url ? <span className="inline-value">{project.webhook_url}</span> : <span className="muted">Not set</span>}
        <button
          className="link-btn"
          onClick={() => {
            setValue(project.webhook_url ?? "");
            setEditing(true);
          }}
        >
          {project.webhook_url ? "Change" : "Add"}
        </button>
      </span>
    );
  }
  return (
    <form className="inline-edit" onSubmit={(e) => void save(e)} noValidate>
      <input
        type="url"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="https://example.com/hooks/ramp"
        aria-label={`Webhook URL for ${project.name}`}
      />
      <button type="submit" className="btn btn-solid btn-sm" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => setEditing(false)}>
        Cancel
      </button>
      <span className="field-hint">Leave empty to stop sending webhooks.</span>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function amount(s: RampSession) {
  const fiat = s.fiat_amount ? `${Number(s.fiat_amount)} ${s.fiat_currency ?? ""}`.trim() : null;
  const crypto = s.crypto_amount ? `${Number(s.crypto_amount)} ${s.asset.code}` : s.asset.code;
  return s.direction === "ON" ? `${fiat ?? "?"} → ${crypto}` : `${crypto} → ${fiat ?? s.fiat_currency ?? "fiat"}`;
}

/** The project's ramps, test or live, newest first. Loaded when opened. */
function Ramps({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"test" | "live">("test");
  const [rows, setRows] = useState<RampSession[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (after?: string) => {
      setBusy(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ mode, limit: "20", ...(after ? { starting_after: after } : {}) });
        const res = await api<{ data: RampSession[]; has_more: boolean }>(`/v1/dashboard/projects/${project.id}/sessions?${qs}`);
        setRows((prev) => (after ? [...(prev ?? []), ...res.data] : res.data));
        setHasMore(res.has_more);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the ramps.");
      } finally {
        setBusy(false);
      }
    },
    [mode, project.id],
  );

  useEffect(() => {
    if (open) void fetchPage();
  }, [open, fetchPage]);

  return (
    <section className="ramps" aria-label={`Ramps for ${project.name}`}>
      <div className="ramps-head">
        <button className="ramps-toggle mono-label" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className={`chevron${open ? " open" : ""}`} aria-hidden>
            ›
          </span>
          Ramps
        </button>
        {open && (
          <div className="ramps-tabs" role="tablist">
            {(["test", "live"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                {m}
              </button>
            ))}
            <button className="ramps-refresh" onClick={() => void fetchPage()} disabled={busy} aria-label="Refresh ramps">
              ↻
            </button>
          </div>
        )}
      </div>
      {open && (
        <>
          {rows === null && busy && <p className="muted ramps-note">Loading…</p>}
          {rows?.length === 0 && (
            <p className="muted ramps-note">
              No {mode} ramps yet. They appear here when your backend calls <code>POST /v1/sessions</code> with a {mode} key.
            </p>
          )}
          {rows && rows.length > 0 && (
            <ul className="ramp-list">
              {rows.map((s) => (
                <li key={s.id} className="ramp-row">
                  <span className={`ramp-status ${s.status.toLowerCase()}`}>{s.status.replace(/_/g, " ")}</span>
                  <span className="ramp-what">
                    <strong>{s.direction === "ON" ? "On-ramp" : "Off-ramp"}</strong> {amount(s)}
                    <span className="mono-label">
                      {s.provider.toLowerCase()}
                      {s.sandbox ? ` · ${s.sandbox.scenario.replace(/_/g, " ")}` : ""}
                      {s.onchain_verified ? " · verified on Stellar" : ""}
                    </span>
                    {s.failure_reason && <span className="ramp-fail">{s.failure_reason}</span>}
                  </span>
                  <code className="ramp-wallet" title={s.wallet_address}>
                    {shortAddress(s.wallet_address)}
                  </code>
                  <span className="muted ramp-when">{when(s.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
          {hasMore && (
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => rows && void fetchPage(rows[rows.length - 1]!.id)}>
              {busy ? "Loading…" : "Load more"}
            </button>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function SecretsPanel({ reveal, onDone }: { reveal: Reveal; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (value: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(value),
      () => undefined,
    );

  return (
    <section className="box section secrets" aria-live="polite">
      <div className="secrets-head">
        <div>
          <h2>{reveal.title}</h2>
          <p className="muted">Copy these now. They won't be shown again.</p>
        </div>
        <button className="btn btn-solid btn-sm" onClick={onDone}>
          <Icon name="check" /> I've saved them
        </button>
      </div>
      <dl className="secret-list">
        {reveal.items.map((s) => (
          <div key={s.label} className="secret">
            <dt className="mono-label">{s.label}</dt>
            <dd>
              <code>{s.value}</code>
              <button className="btn btn-outline btn-sm" onClick={() => copy(s.value)} aria-label={`Copy ${s.label}`}>
                <Icon name={copied === s.value ? "check" : "copy"} />
                {copied === s.value ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
