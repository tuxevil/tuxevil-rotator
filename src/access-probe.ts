import type { IncomingMessage, ServerResponse } from "node:http";
import { isSettingsRepositoryInitialized } from "./db-store.js";
import { isRecord } from "./compat/schema-sanitizer.js";
import type { AccountRotator } from "./rotator.js";
import { getAccountIdentity } from "./account-identity.js";
import { readLimitedBody } from "./body-limit.js";
import { getProviderAdapter, isKnownProvider } from "./providers/registry.js";
import { listCatalogModels, isProviderModelOff } from "./model-catalog.js";
import { accessEvidenceStore, persistAccessEvidence, classifyAccessObservation, logAccessPolicyShadow } from "./access-evidence.js";

/** HTTP 200 is insufficient: streaming providers can return an error inside it. */
export function completedAccessProbe(provider: string, raw: string): boolean {
  try {
    if (provider === "ollama") { const value = JSON.parse(raw); return value.done === true && !value.error; }
    if (provider === "opencode-zen") { const value = JSON.parse(raw); return !value.error && value.choices?.some((c: { finish_reason?: string }) => c.finish_reason); }
    const events = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).flatMap(line => {
      try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
    });
    if (events.some(e => e.error || ["error", "response.error", "response.failed"].includes(e.type) || e.response?.error)) return false;
    if (provider === "openai-codex") return events.some(e => e.type === "response.completed");
    return events.some(e => (e.response ?? e).candidates?.some((c: { finishReason?: string }) => c.finishReason === "STOP" || c.finishReason === "MAX_TOKENS"));
  } catch { return false; }
}

let running = false;
export async function serveAccessProbe(req: IncomingMessage, res: ServerResponse, rotator: AccountRotator): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const send = (status: number, value: unknown) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); } };
  if (!isSettingsRepositoryInitialized()) { send(503, { error: "Evidence persistence is not ready" }); return; }
  if (running) { send(409, { error: "An access probe is already running", reason: "probe-busy" }); return; }
  running = true;
  try {
    const input = JSON.parse((await readLimitedBody(req, 4096)).toString("utf8"));
    const { accountId, provider, model } = input;
    if (typeof accountId !== "string" || typeof provider !== "string" || !isKnownProvider(provider) || typeof model !== "string" || model.length > 256) { send(400, { error: "Invalid account, provider or model" }); return; }
    const account = rotator.getBenchmarkAccounts().find(a => getAccountIdentity(a.config) === accountId);
    const providers = account?.config.credentials?.map(c => c.provider) ?? [account?.config.provider ?? "google-antigravity"];
    if (!account || !providers.includes(provider)) { send(400, { error: "Account/provider unavailable", reason: "account-unavailable" }); return; }
    if (!listCatalogModels(rotator).some(m => m.providerId === provider && m.id === model)) { send(400, { error: "Model is not in the provider catalog" }); return; }
    const unavailable = rotator.isProviderOffForAccount(account, provider) ? "provider-disabled" : isProviderModelOff(rotator, provider, model) ? "model-disabled" : account.inFlightRequests >= (rotator.getConfig().maxConcurrentRequestsPerAccount ?? 5) ? "account-busy" : null;
    if (unavailable) { send(409, { error: "Probe unavailable", reason: unavailable }); return; }
    const adapter = getProviderAdapter(provider);
    const body = structuredClone(adapter.getBenchmark(account).body);
    body.model = model;
    body.request = { ...(isRecord(body.request) ? body.request : {}), ...(provider === "google-antigravity" ? {} : { model }), ...(provider === "ollama" || provider === "opencode-zen" ? { stream: false } : {}) };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const disconnect = () => controller.abort();
    res.once("close", disconnect);
    rotator.startRequest(account, model, provider);
    let status: number | null = null, detail = "", transport = false;
    const started = Date.now();
    try {
      await rotator.ensureValidToken(account, provider);
      controller.signal.throwIfAborted();
      if (rotator.getConfig().modelAccessShadow === true) logAccessPolicyShadow(account.config, provider, model, {});
      rotator.recordUpstreamAttempt(account);
      const forwarded = await adapter.forwardRequest(account, body, {}, controller.signal);
      status = forwarded.response.status;
      const reader = forwarded.response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder(); let size = 0;
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 262144) throw new Error("Probe response limit"); detail += decoder.decode(chunk.value, { stream: true }); } detail += decoder.decode(); }
        finally { await reader.cancel().catch(() => {}); }
      }
      // Do not turn a successful HTTP envelope with missing/failed completion into access success.
      if (forwarded.response.ok && !completedAccessProbe(provider, detail)) status = null;
    } catch { status = null; transport = true; }
    finally { clearTimeout(timer); res.off("close", disconnect); rotator.finishRequest(account, model, provider); }
    const kind = classifyAccessObservation(status, detail, transport);
    accessEvidenceStore().observe(account.config, provider, model, "unknown", status, detail, transport);
    await persistAccessEvidence();
    const observation = accessEvidenceStore().forAccount(account.config).observations.find(o => o.provider === provider && o.model === model && o.client === "unknown");
    send(200, { provider, model, kind, status, observedAt: observation?.observedAt, expiresAt: observation?.expiresAt, durationMs: Date.now() - started, clientVerified: false, enforced: false });
  } catch { send(400, { error: "Probe input or persistence unavailable" }); }
  finally { running = false; }
}
