import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/** A tiny path router: the site has four pages, so no library. Vercel rewrites every path to index.html. */

const listeners = new Set<() => void>();

export function navigate(to: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useLocation(): { path: string; search: URLSearchParams } {
  const read = () => ({ path: window.location.pathname.replace(/\/+$/, "") || "/", search: new URLSearchParams(window.location.search) });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const update = () => setLoc(read());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return loc;
}

/** Only same-site paths, so ?next= can't send someone to another site after sign-in. */
export function safeNext(value: string | null, fallback = "/dashboard"): string {
  return value && /^\/(?!\/)[\w\-/]*$/.test(value) ? value : fallback;
}

export const withNext = (path: string, next: string) => (next === "/dashboard" ? path : `${path}?next=${encodeURIComponent(next)}`);

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
