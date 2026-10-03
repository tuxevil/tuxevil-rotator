// Operator action items, each with the action that resolves it.

import type { DashboardOverview } from "../../dashboard-types.js";
import { errorHint, type Tone } from "./status.js";

export type AttentionAction =
  | { kind: "open-account"; email: string }
  | { kind: "enable"; email: string }
  | { kind: "restore"; email: string }
  | { kind: "disable"; email: string }
  | { kind: "reset-breaker"; model?: string }
  | { kind: "open-model"; model: string };

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  hint?: string | null;
  /** Countdown target shown next to the title. */
  until?: number | null;
  chips?: Array<{ label: string; tone: "ok" | "bad" | "neutral" }>;
  actions: AttentionAction[];
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Icon name for each severity. */
export const SEVERITY_ICON: Record<AttentionSeverity, "critical" | "warning" | "info"> = {
  critical: "critical",
  warning: "warning",
  info: "info",
};

export const SEVERITY_TONE: Record<AttentionSeverity, Tone> = {
  critical: "bad",
  warning: "warn",
  info: "info",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function buildAttention(
  overview: DashboardOverview,
  now: number,
  name: (email: string) => string = (email) => email,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { accounts, routingDiagnostics, circuitBreakers } = overview;
  const paused = overview.protectivePause.until > now;

  if (paused) {
    items.push({
      id: "protective-pause",
      severity: "critical",
      title: "Routing is paused",
      detail:
        overview.protectivePause.reason ||
        "A serious provider signal triggered a protective pause. All traffic is held until it ends.",
      until: overview.protectivePause.until,
      actions: [],
    });
  }

  const { security } = overview;
  if (security.warning) {
    const adminExposed = !security.adminTokenConfigured;
    items.push({
      id: "security",
      // A container has to listen on 0.0.0.0 and cannot see where its port is
      // published, so there it is a note rather than a warning.
      severity: adminExposed || !security.inContainer ? "warning" : "info",
      title: adminExposed ? "Admin routes are exposed" : "Proxy listens on all interfaces",
      detail: security.warning,
      hint: security.inContainer ? null : "For local-only use, set bindHost to 127.0.0.1.",
      actions: [],
    });
  }

  const breakerModels = new Set<string>();
  for (const [model, until] of Object.entries(circuitBreakers.model)) {
    if (until <= now) continue;
    breakerModels.add(model);
    items.push({
      id: `breaker:${model}`,
      severity: "warning",
      title: `Circuit breaker open on ${model}`,
      detail:
        "Several accounts hit provider rate limits in a short window, so this model is paused. Resetting early can cause more rate limits.",
      until,
      actions: [{ kind: "reset-breaker", model }, { kind: "open-model", model }],
    });
  }
  const projectBreakers = Object.entries(circuitBreakers.project).filter(
    ([, until]) => until > now,
  );
  if (projectBreakers.length > 0) {
    items.push({
      id: "breaker:projects",
      severity: "warning",
      title: `${projectBreakers.length} project breaker${projectBreakers.length === 1 ? "" : "s"} open`,
      detail: "Individual Google Cloud projects are paused for specific models after repeated rate limits.",
      until: Math.max(...projectBreakers.map(([, until]) => until)),
      chips: projectBreakers.map(([key]) => ({ label: key, tone: "neutral" as const })),
      actions: [{ kind: "reset-breaker" }],
    });
  }

  // A pause already explains why nothing routes; per-model items would be noise.
  for (const [model, diag] of Object.entries(paused ? {} : routingDiagnostics)) {
    if (diag.selectedEmail || breakerModels.has(model) || model === "__default__") continue;
    items.push({
      id: `unroutable:${model}`,
      severity: "critical",
      title: `No account can serve ${model}`,
      detail: diag.reason || "Every candidate was rejected by a routing check.",
      actions: [{ kind: "open-model", model }],
    });
  }

  for (const account of accounts) {
    if (account.status === "flagged") {
      items.push({
        id: `flagged:${account.email}`,
        severity: "critical",
        title: `${name(account.email)} is quarantined`,
        detail: truncate(
          account.lastError ||
            "Flagged after a provider enforcement signal. Keep it out of rotation until the provider restores access.",
          220,
        ),
        hint: errorHint(account.lastError),
        actions: [
          { kind: "open-account", email: account.email },
          { kind: "restore", email: account.email },
        ],
      });
    } else if (account.status === "error") {
      items.push({
        id: `error:${account.email}`,
        severity: "warning",
        title: `${name(account.email)} is erroring`,
        detail: truncate(account.lastError || "Recent requests to this account failed.", 220),
        hint: errorHint(account.lastError),
        actions: [
          { kind: "open-account", email: account.email },
          { kind: "disable", email: account.email },
        ],
      });
    } else if (account.status === "disabled") {
      items.push({
        id: `disabled:${account.email}`,
        severity: "info",
        title: `${name(account.email)} is disabled`,
        detail: account.lastError
          ? truncate(account.lastError, 220)
          : "Taken out of service. Re-enable once the underlying problem is fixed.",
        hint: errorHint(account.lastError),
        actions: [
          { kind: "open-account", email: account.email },
          { kind: "enable", email: account.email },
        ],
      });
    }
  }

  const holding = accounts.filter(
    (a) => a.tokenBucket.enabled && a.tokenBucket.tokens < 1 && a.status !== "disabled" && a.status !== "flagged",
  );
  if (holding.length > 0) {
    const refills = holding
      .map((a) => a.tokenBucket.nextRefillAt)
      .filter((t): t is number => typeof t === "number" && t > now);
    items.push({
      id: "token-bucket",
      severity: "info",
      title: `Token bucket holding ${holding.length} account${holding.length === 1 ? "" : "s"}`,
      detail: "Hybrid routing pauses these accounts briefly so the provider is not hammered before the local refill.",
      until: refills.length > 0 ? Math.min(...refills) : null,
      chips: holding.map((a) => ({ label: name(a.email), tone: "neutral" as const })),
      actions: [],
    });
  }

  const freeTier = accounts.filter((a) => a.tier === "free" || a.tier === "unknown");
  if (freeTier.length > 0 && overview.modelTierAccess) {
    const entries = Object.entries(overview.modelTierAccess);
    items.push({
      id: "free-tier-models",
      severity: "info",
      title: "Free-tier model access",
      detail: `${freeTier.length} account${freeTier.length === 1 ? " is" : "s are"} on the free tier (or not set). Only the models marked available answer on that tier; the rest return 403 "requires a subscription".`,
      chips: [
        ...entries
          .filter(([, access]) => access === "free")
          .map(([model]) => ({ label: model, tone: "ok" as const })),
        ...entries
          .filter(([, access]) => access !== "free")
          .map(([model]) => ({ label: model, tone: "bad" as const })),
      ],
      actions: [],
    });
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Items that should raise the "needs you" count (info items do not). */
export function actionableCount(items: AttentionItem[]): number {
  return items.filter((item) => item.severity !== "info").length;
}
