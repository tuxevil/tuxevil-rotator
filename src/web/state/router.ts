// Minimal History API router. Every view has a real URL, so pages, filters
// and the open account drawer survive reloads and can be shared.

import { computed, signal } from "@preact/signals";

export const BASE = "/dashboard";

export type PageId = "overview" | "accounts" | "requests" | "usage" | "keys" | "settings";

export interface RouteMatch {
  page: PageId | "not-found";
  /** Email of the account whose drawer is open. */
  account: string | null;
}

interface LocationState {
  path: string;
  search: string;
}

function readLocation(): LocationState {
  return { path: window.location.pathname, search: window.location.search };
}

export const location = signal<LocationState>(readLocation());

window.addEventListener("popstate", () => {
  location.value = readLocation();
});

export function matchRoute(path: string): RouteMatch {
  const rest = path.replace(/\/+$/, "").slice(BASE.length).split("/").filter(Boolean);
  const [head, second] = rest;
  if (!head) return { page: "overview", account: null };
  if (head === "accounts") {
    let account: string | null = null;
    if (second) {
      try {
        account = decodeURIComponent(second);
      } catch {
        account = second;
      }
    }
    return { page: "accounts", account };
  }
  if (head === "requests" || head === "usage" || head === "keys" || head === "settings") {
    return { page: head, account: null };
  }
  return { page: "not-found", account: null };
}

export const route = computed(() => matchRoute(location.value.path));
export const query = computed(() => new URLSearchParams(location.value.search));

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = new URL(to, window.location.origin);
  const next = target.pathname + target.search;
  if (next === window.location.pathname + window.location.search) return;
  const pathChanged = target.pathname !== window.location.pathname;
  window.history[options.replace ? "replaceState" : "pushState"](null, "", next);
  location.value = readLocation();
  if (pathChanged && !matchRoute(target.pathname).account) {
    // Pages scroll inside the canvas, not the window.
    document.getElementById("main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }
}

/** Update query parameters in place (null removes a key). */
export function setQuery(params: Record<string, string | null>, options: { replace?: boolean } = {}): void {
  const search = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === "") search.delete(key);
    else search.set(key, value);
  }
  const text = search.toString();
  navigate(window.location.pathname + (text ? `?${text}` : ""), { replace: options.replace ?? true });
}

export function accountPath(email: string): string {
  return `${BASE}/accounts/${encodeURIComponent(email)}`;
}

/** Legacy routes from the old dashboard. */
export function redirectLegacyRoutes(): void {
  const { pathname, search } = window.location;
  if (pathname === `${BASE}/logs`) {
    const params = new URLSearchParams(search);
    params.set("view", "history");
    navigate(`${BASE}/requests?${params.toString()}`, { replace: true });
  }
}
