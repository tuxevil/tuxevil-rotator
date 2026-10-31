import assert from "node:assert/strict";
import { it } from "node:test";
import { AccessEvidenceStore } from "../src/access-evidence.js";
import { evaluateAutoModelAccess } from "../src/auto-model-access.js";

const now = Date.parse("2026-10-31T12:00:00Z");

it("enforces the confirmed seven-model Ollama Free list", () => {
  const account = { email: "ollama@test", credentials: [{ provider: "ollama", apiKey: "test" }] };
  const store = new AccessEvidenceStore();
  const allowed = [
    "beam",
    "gemma4:31b",
    "gpt-oss:120b",
    "gpt-oss:20b",
    "nemotron-3-nano:30b",
    "nemotron-3-super",
    "nemotron-3-ultra",
  ];
  for (const model of allowed) {
    assert.equal(evaluateAutoModelAccess(account, "ollama", model, store, now).eligible, true, model);
  }
  assert.equal(evaluateAutoModelAccess(account, "ollama", "deepseek-v4.1-flash:1017", store, now).eligible, false);
  assert.equal(evaluateAutoModelAccess(account, "ollama", "future-free-model", store, now).eligible, false);
});

it("honors provider-specific plan evidence and never transfers a linked account tier to Codex", () => {
  const account = {
    email: "linked@test",
    tier: "plus" as const,
    provider: "google-antigravity",
    credentials: [
      { provider: "google-antigravity", refreshToken: "google" },
      { provider: "openai-codex", refreshToken: "codex", providerAccountId: "codex-id" },
    ],
  };
  const store = new AccessEvidenceStore();
  const unknownCodex = evaluateAutoModelAccess(account, "openai-codex", "gpt-6.1-terra", store, now);
  assert.equal(unknownCodex.plan, "unknown");
  assert.equal(unknownCodex.eligible, false);

  store.declarePlan(account, "openai-codex", "free", now);
  assert.equal(evaluateAutoModelAccess(account, "openai-codex", "gpt-6-luna", store, now).eligible, true);
  assert.equal(evaluateAutoModelAccess(account, "openai-codex", "gpt-6.1-terra", store, now).eligible, false);

  store.declarePlan(account, "openai-codex", "plus", now + 1);
  assert.equal(evaluateAutoModelAccess(account, "openai-codex", "gpt-6.1-terra", store, now + 1).eligible, true);
});

it("uses account/model 402 evidence as a temporary exclusion and re-enables after expiry", () => {
  const account = { email: "codex@test", credentials: [{ provider: "openai-codex", refreshToken: "codex", providerAccountId: "codex-id" }] };
  const store = new AccessEvidenceStore();
  store.declarePlan(account, "openai-codex", "free", now);
  store.observe(account, "openai-codex", "gpt-6-luna", "other", 402, "", false, now + 10);
  assert.equal(evaluateAutoModelAccess(account, "openai-codex", "gpt-6-luna", store, now + 100).eligible, false);
  assert.equal(evaluateAutoModelAccess(account, "openai-codex", "gpt-6-luna", store, now + 3_600_011).eligible, true);
});

it("applies the dated Antigravity Free legacy-model window", () => {
  const account = { email: "google@test", credentials: [{ provider: "google-antigravity", refreshToken: "google" }] };
  const store = new AccessEvidenceStore();
  store.declarePlan(account, "google-antigravity", "free", now);
  assert.equal(evaluateAutoModelAccess(account, "google-antigravity", "claude-opus-4-6-thinking", store, Date.parse("2026-11-01T23:59:59Z")).eligible, true);
  assert.equal(evaluateAutoModelAccess(account, "google-antigravity", "claude-opus-4-6-thinking", store, Date.parse("2026-11-02T00:00:00Z")).eligible, false);
});

it("keeps Antigravity Free and Plus auto candidates within their confirmed model list", () => {
  for (const plan of ["free", "plus"] as const) {
    const account = { email: `google-${plan}@test`, credentials: [{ provider: "google-antigravity", refreshToken: plan }] };
    const store = new AccessEvidenceStore();
    store.declarePlan(account, "google-antigravity", plan, now);
    for (const model of ["gemini-3.8-flash-high", "claude-sonnet-4-6-thinking", "claude-opus-4-6-thinking"]) {
      assert.equal(evaluateAutoModelAccess(account, "google-antigravity", model, store, now).eligible, true, `${plan} ${model}`);
    }
    for (const model of ["gemini-3-flash", "gemini-4-argon-high", "claude-sonnet-5-5", "unlisted-model"]) {
      assert.equal(evaluateAutoModelAccess(account, "google-antigravity", model, store, now).eligible, false, `${plan} ${model}`);
    }
  }
});
