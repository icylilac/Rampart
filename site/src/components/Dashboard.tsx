import { useCallback, useEffect, useState, type FormEvent } from "react";
import { GITHUB } from "../content";
import { api, ApiError, setToken, type ApiKey, type Project, type User } from "../lib/api";
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

  async function signOut() {
    await api("/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    setToken(null);
    navigate("/login", { replace: true });
  }

  const who = user ? (user.email ?? shortAddress(user.wallet_address ?? "")) : "";

  return (
    <div className="page dash">
      <header className="nav box dash-nav">
        <Link to="/" className="nav-brand" aria-label="Rampart home">
          <img src="/icon.svg" alt="" />
          <span>Rampart</span>
        </Link>
        <div className="nav-right">
          {user && (
            <span className="dash-who mono-label" title={user.email ?? user.wallet_address ?? ""}>
              {user.wallet_address && !user.email && <Icon name="wallet" />}
              {who}
            </span>
          )}
          <a className="btn btn-outline hide-sm" href={DOCS} target="_blank" rel="noreferrer">
            Docs
          </a>
          <button className="btn btn-solid" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

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
            onSecret={setReveal}
          />
        ))}
      </main>

      <footer className="footer">
        <span className="nav-brand small">
          <img src="/icon.svg" alt="" />
          Rampart
        </span>
        <span className="mono-label">Secrets are shown once · Keys are stored as hashes</span>
      </footer>
    </div>
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

function ProjectCard({ project, onChange, onSecret }: { project: Project; onChange: (p: Project) => void; onSecret: (r: Reveal) => void }) {
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
          <h2>{project.name}</h2>
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
        <dd>{project.webhook_url ?? <span className="muted">Not set</span>}</dd>
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
    </article>
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
