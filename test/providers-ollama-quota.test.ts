import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUsagePools, extractBalancePools, fetchProviderUsage } from "../src/providers/ollama/quota.js";

import { readFileSync } from "node:fs";
import type { AccountRuntime } from "../src/types.js";
import type { QuotaFetchContext } from "../src/providers/adapter.js";

const balance = JSON.parse(readFileSync(new URL("./fixtures/ollama-balance.json", import.meta.url), "utf8"));
const context: QuotaFetchContext = {
  log: () => {}, markFlagged: () => {}, reportQuotaPollFlag: () => {},
  markProviderInvalid: () => {}, setProviderCooldown: () => {},
};
function runtimeAccount(): AccountRuntime {
  return {
    config: { email: "quota@test.dev", credentials: [{ provider: "ollama", apiKey: "test-ollama-key" }] },
    quota: [
      { modelKey: "claude", displayName: "Claude", percentRemaining: 80, resetTime: null, timerType: "fresh" },
      { modelKey: "monthly", displayName: "Ollama", providerId: "ollama", percentRemaining: 90, resetTime: null, timerType: "monthly" },
    ],
    lastQuotaPoll: 0,
  } as AccountRuntime;
}

describe("Ollama monthly quota parsing", () => {
  it("publishes the current monthly usage pool", () => {
    const quotas = extractUsagePools(
      {
        limits: {
          monthly: {
            usage: 0.37,
            models: [],
          },
        },
      },
      [],
    );

    assert.deepEqual(quotas, [
      {
        modelKey: "monthly",
        displayName: "Ollama",
        percentRemaining: 63,
        usageRaw: 0.37,
        resetTime: null,
        timerType: "monthly",
      },
    ]);
  });

  it("does not retain legacy session/weekly pools when monthly is present", () => {
    const quotas = extractUsagePools(
      {
        limits: {
          monthly: { usage: 0 },
        },
      },
      [
        {
          modelKey: "session",
          displayName: "Session",
          percentRemaining: 20,
          resetTime: null,
          timerType: "5h",
        },
        {
          modelKey: "weekly",
          displayName: "Weekly",
          percentRemaining: 20,
          resetTime: null,
          timerType: "7d",
        },
      ],
    );

    assert.deepEqual(quotas.map((quota) => quota.modelKey), ["monthly"]);
  });
});

// /api/usage is now a histogram; quota polling must use /api/balance.
describe("Ollama balance quota polling", () => {
  it("reads real credits and the provider's renewal date", () => {
    const [monthly] = extractBalancePools(balance);
    assert.equal(monthly.modelKey, "monthly");
    assert.equal(monthly.percentRemaining, 71);
    assert.equal(monthly.usageRaw, 1 - 1.76835 / 2.5);
    assert.equal(monthly.resetTime, balance.included.period.until);
    assert.equal(monthly.timerType, "monthly");
    assert.deepEqual(monthly.credits, { balanceUsd: 1.76835, allowanceUsd: 2.5, purchasedUsd: 0 });
  });

  it("preserves a small positive balance instead of marking it exhausted", () => {
    const [monthly] = extractBalancePools({ included: { balance_usd: 0.001, allowance_usd: 2.5 } });
    assert.equal(monthly.percentRemaining, 1);
  });

  it("uses explicit legacy windows and exact resets from the balance endpoint", () => {
    const quotas = extractBalancePools({ included: {
      session: { remaining_percent: 34.4, resets_at: "2026-10-11T18:00:00Z" },
      weekly: { remaining_percent: 12, resets_at: "2026-10-15T00:00:00Z" },
    } });
    assert.deepEqual(quotas.map(q => [q.modelKey, q.percentRemaining, q.timerType, q.resetTime]), [
      ["session", 34, "5h", "2026-10-11T18:00:00Z"],
      ["weekly", 12, "7d", "2026-10-15T00:00:00Z"],
    ]);
  });

  it("does not invent percentages from consumption or malformed balances", () => {
    for (const data of [{ totals: { usage_usd: 0.2 } }, {}, null,
      { included: { balance_usd: "", allowance_usd: 2.5 } },
      { included: { balance_usd: 1, allowance_usd: 0 } },
      { included: { monthly: { remaining_percent: NaN } } },
    ]) assert.deepEqual(extractBalancePools(data), []);
  });

  it("polls /api/balance and preserves quotas from sibling providers", async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init: RequestInit) => {
      calls.push(String(input));
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-ollama-key");
      return Response.json(balance);
    });
    const account = runtimeAccount();
    await fetchProviderUsage(account, context);
    assert.deepEqual(calls, ["https://ollama.com/api/balance"]);
    assert.deepEqual(account.quota.map(q => q.modelKey), ["claude", "monthly"]);
    assert.equal(account.quota[1].providerId, "ollama");
    assert.equal(account.quota[1].percentRemaining, 71);
    assert.ok(account.lastQuotaPoll > 0);
    assert.equal(account.quota[1].observation?.percentageSource, "derived");
    assert.equal(account.quota[1].observation?.resetSource, "reported");
    assert.ok(account.quota[1].observation!.observedAt > 0);
    assert.equal(account.quota[0].observation, undefined, "sibling freshness is untouched");
  });

  it("keeps last known quotas on an unrecognized successful response", async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ totals: { request_count: 513, usage_usd: 0.23833 } }));
    const account = runtimeAccount();
    const previous = structuredClone(account.quota);
    await fetchProviderUsage(account, context);
    assert.deepEqual(account.quota, previous);
    assert.equal(account.lastQuotaPoll, 0, "unknown data does not count as a successful quota refresh");
  });

  it("supports the legacy usage endpoint only if balance is unavailable", async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return String(input).endsWith("/balance")
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json({ limits: { monthly: { usage: 0.25 } } });
    });
    const account = runtimeAccount();
    await fetchProviderUsage(account, context);
    assert.deepEqual(calls, ["https://ollama.com/api/balance", "https://ollama.com/api/usage"]);
    assert.equal(account.quota.find(q => q.modelKey === "monthly")?.percentRemaining, 75);
  });
  it("marks local legacy resets as estimates", async (t) => {
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => String(input).endsWith("/balance")
      ? Response.json({}, { status: 404 })
      : Response.json({ limits: { weekly: { usage: 0.25 }, session: { usage: 0.1 } } }));
    const account = runtimeAccount();
    await fetchProviderUsage(account, context);
    for (const q of account.quota.filter(q => q.providerId === "ollama")) {
      assert.equal(q.observation?.resetSource, "estimated");
      assert.equal(q.observation?.percentageSource, "derived");
      assert.equal(q.observation?.resetAt, q.resetTime);
    }
  });

});
