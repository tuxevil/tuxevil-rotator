// Operator actions with confirmation, toast feedback and a state refresh.

import { signal } from "@preact/signals";
import type { AccountTier } from "../../types.js";
import { api } from "./api.js";
import { masker, refreshSnapshot } from "./store.js";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export const toasts = signal<Toast[]>([]);
let toastId = 1;

export function toast(message: string, tone: ToastTone = "info"): void {
  const id = toastId++;
  toasts.value = [...toasts.value, { id, message, tone }].slice(-4);
  setTimeout(() => dismissToast(id), tone === "error" ? 9000 : 4500);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  /** Require typing this text before confirming (irreversible actions). */
  typeToConfirm?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export const confirmRequest = signal<ConfirmRequest | null>(null);

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmRequest.value?.resolve(false);
    confirmRequest.value = { ...options, resolve };
  });
}

/** Run an action, toast the outcome, then pull fresh state. */
export async function run<T>(
  fn: () => Promise<T>,
  messages: { success?: string | ((result: T) => string | null); failure: string },
): Promise<T | null> {
  try {
    const result = await fn();
    const success =
      typeof messages.success === "function" ? messages.success(result) : messages.success;
    if (success) toast(success, "success");
    return result;
  } catch (err) {
    toast(`${messages.failure}: ${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  } finally {
    void refreshSnapshot();
  }
}

const name = (email: string) => masker.value.name(email);

export const actions = {
  enable: (email: string) =>
    run(() => api.enable(email), {
      success: `${name(email)} is back in rotation`,
      failure: `Could not re-enable ${name(email)}`,
    }),

  restore: (email: string) =>
    run(() => api.restore(email), {
      success: `${name(email)} restored to rotation`,
      failure: `Could not restore ${name(email)}`,
    }),

  async disable(email: string) {
    const ok = await confirmAction({
      title: `Disable ${name(email)}?`,
      body: "It stops serving traffic until you re-enable it.",
      confirmLabel: "Disable",
    });
    if (!ok) return null;
    return run(() => api.disable(email), {
      success: `${name(email)} disabled`,
      failure: `Could not disable ${name(email)}`,
    });
  },

  async quarantine(email: string) {
    const ok = await confirmAction({
      title: `Quarantine ${name(email)}?`,
      body: "It is marked as flagged and excluded from routing until you restore it. Use this when a provider has warned or restricted the account.",
      confirmLabel: "Quarantine",
      danger: true,
    });
    if (!ok) return null;
    return run(() => api.quarantine(email), {
      success: `${name(email)} quarantined`,
      failure: `Could not quarantine ${name(email)}`,
    });
  },

  async remove(email: string) {
    const ok = await confirmAction({
      title: `Remove ${name(email)}?`,
      body: "The account and its stored credentials are deleted from the rotator. This cannot be undone; you would have to sign in again to add it back.",
      confirmLabel: "Remove account",
      danger: true,
      typeToConfirm: "remove",
    });
    if (!ok) return null;
    return run(() => api.remove(email), {
      success: `${name(email)} removed`,
      failure: `Could not remove ${name(email)}`,
    });
  },

  setTier: (email: string, tier: AccountTier) =>
    run(() => api.setTier(email, tier), {
      success: `${name(email)} set to ${tier === "unknown" ? "unknown tier" : tier}`,
      failure: `Could not change the tier of ${name(email)}`,
    }),

  setFreshOverride: (email: string, on: boolean) =>
    run(() => api.setAccountFreshOverride(email, on), {
      success: on
        ? `${name(email)} may open fresh windows`
        : `${name(email)} follows the global fresh-window policy`,
      failure: "Could not change the fresh-window override",
    }),

  kickstart: (email: string, modelKey: string, poolName: string) =>
    run(() => api.kickstart(email, modelKey), {
      success: (result) =>
        result.ok ? `Started the ${poolName} window on ${name(email)}` : null,
      failure: `Could not start ${poolName} on ${name(email)}`,
    }).then((result) => {
      if (result && !result.ok) toast(`Could not start ${poolName}: ${result.error || "upstream error"}`, "error");
      return result;
    }),

  async kickstartAll(email: string) {
    const ok = await confirmAction({
      title: `Start idle windows on ${name(email)}?`,
      body: "Sends one minimal request per idle quota pool so their reset timers start now.",
      confirmLabel: "Start windows",
    });
    if (!ok) return null;
    const result = await run(() => api.kickstart(email), { failure: "Kickstart failed" });
    if (!result) return null;
    const results = result.results ?? [];
    if (result.error) toast(`Kickstart failed: ${result.error}`, "error");
    else if (results.length === 0) toast(`${name(email)} has no idle windows`, "info");
    else if (!result.ok) {
      const failed = results
        .filter((r) => !r.ok)
        .map((r) => `${r.upstreamModel ?? "pool"} (HTTP ${r.status ?? "?"})`)
        .join(", ");
      toast(`Some windows did not start: ${failed}`, "error");
    } else toast(`Started ${results.length} idle window${results.length === 1 ? "" : "s"} on ${name(email)}`, "success");
    return result;
  },

  async clearInFlight(email: string, modelKey: string, poolName: string) {
    const ok = await confirmAction({
      title: "Clear the in-flight counter?",
      body: `Only do this when a ${poolName} request on ${name(email)} is stuck; a live request will keep running but stops counting against the concurrency limit.`,
      confirmLabel: "Clear counter",
    });
    if (!ok) return null;
    return run(() => api.clearInFlight(email, modelKey), {
      success: `Cleared the ${poolName} in-flight counter`,
      failure: "Could not clear the in-flight counter",
    });
  },

  async resetBreaker(model?: string) {
    const ok = await confirmAction({
      title: model ? `Reset the ${model} circuit breaker?` : "Reset all circuit breakers?",
      body: "If the provider is still rate limiting, traffic will hit the limits again and may trigger more breakers.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (!ok) return null;
    return run(() => api.clearBreaker(model), {
      success: model ? `Circuit breaker reset for ${model}` : "All circuit breakers reset",
      failure: "Could not reset the circuit breaker",
    });
  },

  setFreshWindows: (on: boolean) =>
    run(() => api.setFreshWindows(on), {
      success: on ? "Fresh windows allowed" : "Fresh windows blocked",
      failure: "Could not change the fresh-window policy",
    }),

  setAutoWarmup: (on: boolean) =>
    run(() => api.setAutoWarmup(on), {
      success: on ? "Auto-warmup on" : "Auto-warmup off",
      failure: "Could not change auto-warmup",
    }),
};
