// Small page-level helpers shared by the three windows.
import { api } from "./api";
import type { Config } from "./types";

/** Theme from Settings ("system" follows Windows). */
export function applyTheme(config: Pick<Config, "theme"> | null | undefined): void {
  const t = config?.theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

/** Web links (target=_blank) open in the real browser, never inside Sidekick's windows. */
export function routeLinksToBrowser(): void {
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    e.preventDefault();
    if (/^https?:\/\//i.test(href)) api.openUrl(href).catch(() => {});
  });
}

/** "Mon, Nov 16, 09:30 AM" */
export const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "now", "5m ago", "2h ago", "yesterday", "3d ago" */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return `${Math.round(s / 86400)}d ago`;
}

/** "in 25m", "in 2h 10m", or a weekday + time further out. */
export function until(iso: string): string {
  const t = new Date(iso).getTime();
  const s = (t - Date.now()) / 1000;
  if (!Number.isFinite(s)) return "none";
  if (s < 60) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 6 * 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  return new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}
