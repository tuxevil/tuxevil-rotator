import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import * as preact from "preact";
import { createElement, render } from "preact";
import { act } from "preact/test-utils";

const window = new Window({ url: "http://localhost/dashboard/models?accessAccount=a" });
Object.assign(globalThis, { React: preact, window, document: window.document, location: window.location, history: window.history });
const originalInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = originalInterval(...args);
  timer.unref();
  return timer;
}) as typeof setInterval;
const panelPath = "../src/web/pages/ModelAccess.js";
const { ModelAccessPanel } = await import(panelPath) as { ModelAccessPanel: preact.FunctionComponent };
const { api } = await import("../src/web/state/api.js");
globalThis.setInterval = originalInterval;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("a late access check cannot overwrite a saved plan", async () => {
  const old = { rules: [{ id: "r", provider: "google-antigravity", modelPrefix: "gemini", plans: ["plus", "free"], state: "allowed", evidence: "documented", verifiedAt: "2026-01-01", reviewAfter: "2027-01-01", note: "", source: "test" }], accounts: [{ id: "a", label: "Account A", providers: ["google-antigravity"], providerPlans: [], inferredPlan: "unknown", observations: [] }] };
  const updated = structuredClone(old);
  (updated.accounts[0].providerPlans as unknown[]).push({ provider: "google-antigravity", plan: "plus", expiresAt: Date.now() + 100000 });
  const stale = deferred<unknown>();
  const save = deferred<unknown>();
  let checks = 0;
  const originalCheck = api.modelAccess;
  const originalSave = api.declareProviderPlan;
  api.modelAccess = (async (params?: URLSearchParams) => {
    if (!params) return old;
    checks++;
    if (checks === 1) return stale.promise;
    return updated;
  }) as typeof api.modelAccess;
  api.declareProviderPlan = (() => save.promise) as typeof api.declareProviderPlan;
  const root = document.createElement("div");
  document.body.append(root);
  try {
    await act(async () => { render(createElement(ModelAccessPanel, {}), root); await pause(20); });
    await act(async () => { await pause(50); });
    const plus = [...root.querySelectorAll("button")].find(b => b.textContent === "plus")!;
    await act(async () => { plus.click(); await pause(350); });
    assert.equal(checks, 1);
    const button = [...root.querySelectorAll("button")].find(b => b.textContent?.startsWith("Save plus"));
    assert.ok(button, root.textContent ?? "missing save button");
    await act(async () => { button.click(); await pause(20); });
    const free = [...root.querySelectorAll("button")].find(b => b.textContent === "free")!;
    await act(async () => { free.click(); await pause(20); });
    await act(async () => { save.resolve(updated); await pause(20); });
    assert.equal(free.getAttribute("aria-pressed"), "true");
    await act(async () => { stale.resolve(old); await pause(20); });
    assert.match(root.textContent!, /Account\s*plus/);
    await act(async () => { await pause(350); });
    assert.match(root.textContent!, /Account\s*plus/);
  } finally {
    render(null, root);
    api.modelAccess = originalCheck;
    api.declareProviderPlan = originalSave;
    root.remove();
    window.happyDOM.abort();
  }
});
