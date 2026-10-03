// Live dashboard state. One EventSource carries a snapshot followed by
// small patches; when it drops, the store polls until it reconnects.

import { computed, effect, signal } from "@preact/signals";
import type {
  AccountsPatch,
  DashboardAccount,
  DashboardOverview,
  DashboardSnapshot,
  LiveEvent,
  LiveRequest,
} from "../../dashboard-types.js";
import { createMasker } from "../lib/mask.js";
import { api, ApiError, setUnauthorizedHandler } from "./api.js";
import { readPref, writePref } from "./prefs.js";

const REQUEST_LIMIT = 200;
const EVENT_LIMIT = 100;
const POLL_MS = 15_000;

export type AuthState = "checking" | "signed-in" | "signed-out";
export type ConnectionState = "connecting" | "live" | "polling" | "offline";

export const authState = signal<AuthState>("checking");
export const authRequired = signal(true);
export const overview = signal<DashboardOverview | null>(null);
export const liveRequests = signal<LiveRequest[]>([]);
export const liveEvents = signal<LiveEvent[]>([]);
export const connection = signal<{ state: ConnectionState; lastUpdate: number; error: string | null }>({
  state: "connecting",
  lastUpdate: 0,
  error: null,
});

/** Wall clock for countdowns; ticks once a second. */
export const now = signal(Date.now());
setInterval(() => {
  now.value = Date.now();
}, 1000);

// ── Preferences ─────────────────────────────────────────────────────────

export type ThemePref = "system" | "light" | "dark";

function initialTheme(): ThemePref {
  const value = readPref("rotatorTheme", "system");
  return value === "light" || value === "dark" ? value : "system";
}

export const theme = signal<ThemePref>(initialTheme());
effect(() => {
  const value = theme.value;
  if (value === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", value);
  writePref("rotatorTheme", value === "system" ? null : value);
});

/** Desktop rail: icons only, or icons with labels. */
export const railExpanded = signal(readPref("rotatorRail", "") === "expanded");
effect(() => {
  writePref("rotatorRail", railExpanded.value ? "expanded" : null);
});

/** The ⌘K command palette. */
export const paletteOpen = signal(false);

export const masked = signal(
  new URLSearchParams(window.location.search).has("mask") || readPref("rotatorMask", "") === "1",
);
effect(() => {
  writePref("rotatorMask", masked.value ? "1" : null);
});

export const masker = computed(() => createMasker(overview.value?.accounts ?? [], masked.value));

export const accounts = computed<DashboardAccount[]>(() => overview.value?.accounts ?? []);

// ── Applying server data ────────────────────────────────────────────────

function markUpdated(): void {
  connection.value = { ...connection.value, lastUpdate: Date.now(), error: null };
}

export function applySnapshot(snapshot: DashboardSnapshot): void {
  overview.value = snapshot.overview;
  liveRequests.value = snapshot.requests.slice(0, REQUEST_LIMIT);
  liveEvents.value = snapshot.events.slice(0, EVENT_LIMIT);
  markUpdated();
}

function applyAccounts(patch: AccountsPatch): void {
  const current = overview.value;
  if (!current) return;
  const byEmail = new Map(current.accounts.map((a) => [a.email, a]));
  for (const email of patch.remove) byEmail.delete(email);
  for (const account of patch.upsert) byEmail.set(account.email, account);
  const order = patch.order ?? current.accounts.map((a) => a.email).filter((e) => byEmail.has(e));
  const seen = new Set(order);
  const next = order.map((email) => byEmail.get(email)).filter((a): a is DashboardAccount => Boolean(a));
  for (const [email, account] of byEmail) if (!seen.has(email)) next.push(account);
  overview.value = { ...current, accounts: next };
}

function prependUnique<T extends { id: number }>(incoming: T[], existing: T[], limit: number): T[] {
  const ids = new Set(existing.map((item) => item.id));
  return incoming.filter((item) => !ids.has(item.id)).concat(existing).slice(0, limit);
}

// ── Connection ──────────────────────────────────────────────────────────

let source: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function setConnection(state: ConnectionState, error: string | null = null): void {
  connection.value = { ...connection.value, state, error };
}

export async function refreshSnapshot(): Promise<void> {
  try {
    applySnapshot(await api.snapshot());
    if (connection.value.state === "offline") setConnection(source ? "polling" : "offline");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    setConnection("offline", err instanceof Error ? err.message : String(err));
  }
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshSnapshot(), POLL_MS);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function parse<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

function connect(): void {
  if (!running) return;
  source?.close();
  const es = new EventSource("/api/dashboard/stream");
  source = es;
  es.onopen = () => {
    setConnection("live");
    stopPolling();
  };
  es.addEventListener("snapshot", (event) => {
    const data = parse<DashboardSnapshot>(event);
    if (data) applySnapshot(data);
    setConnection("live");
  });
  es.addEventListener("overview", (event) => {
    const data = parse<Partial<DashboardOverview>>(event);
    if (data && overview.value) {
      overview.value = { ...overview.value, ...data };
      markUpdated();
    }
  });
  es.addEventListener("accounts", (event) => {
    const data = parse<AccountsPatch>(event);
    if (data) {
      applyAccounts(data);
      markUpdated();
    }
  });
  es.addEventListener("requests", (event) => {
    const data = parse<LiveRequest[]>(event);
    if (data) liveRequests.value = prependUnique(data, liveRequests.value, REQUEST_LIMIT);
  });
  es.addEventListener("events", (event) => {
    const data = parse<LiveEvent[]>(event);
    if (data) liveEvents.value = prependUnique(data, liveEvents.value, EVENT_LIMIT);
  });
  es.onerror = () => {
    if (!running) return;
    // A failed poll already said "offline"; stream retries must not undo it.
    if (connection.value.state !== "offline") {
      setConnection(connection.value.lastUpdate ? "polling" : "connecting");
    }
    startPolling();
    // A 401 or a closed stream will not auto-reconnect; check and retry.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        void refreshSnapshot().then(() => {
          if (running) connect();
        });
      }, 5000);
    }
  };
}

export function startLive(): void {
  if (running) return;
  running = true;
  setConnection("connecting");
  connect();
}

export function stopLive(): void {
  running = false;
  source?.close();
  source = null;
  stopPolling();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

setUnauthorizedHandler(() => {
  stopLive();
  authState.value = "signed-out";
});

export async function checkSession(): Promise<void> {
  try {
    const info = await api.session();
    authRequired.value = info.authRequired;
    authState.value = info.authenticated ? "signed-in" : "signed-out";
  } catch {
    // Unreachable server: assume signed in and let the live connection report it.
    authState.value = "signed-in";
  }
  if (authState.value === "signed-in") startLive();
}

export async function signIn(token: string): Promise<void> {
  await api.signIn(token);
  authState.value = "signed-in";
  startLive();
}

export async function signOut(): Promise<void> {
  stopLive();
  try {
    await api.signOut();
  } finally {
    overview.value = null;
    authState.value = "signed-out";
  }
}

/** Legacy dashboards kept the admin token in localStorage; trade it for a cookie once. */
export async function migrateStoredToken(): Promise<boolean> {
  const legacy = readPref("rotatorAdminToken", "");
  if (!legacy) return false;
  try {
    await signIn(legacy);
    writePref("rotatorAdminToken", null);
    return true;
  } catch (err) {
    // Keep it for the next load unless the rotator actually rejected it.
    if (err instanceof ApiError && err.status === 401) writePref("rotatorAdminToken", null);
    return false;
  }
}
