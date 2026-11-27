import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  getAccountIdentity,
  getCredentialGeneration,
} from "../src/account-identity.js";
import {
  AICODE_ENDPOINTS,
  AICODE_SCOPE,
  ANTIGRAVITY_ENDPOINTS,
  type AccountRuntime,
} from "../src/types.js";
import {
  buildAicodeGenerateContentRequest,
  resolveAicodeTarget,
  shouldAttemptAicodeRouting,
  shouldShadowAicodeQuotaStatus,
  wrapAicodeSseResponse,
} from "../src/providers/google-antigravity/aicode-forward.js";
import {
  fetchAicodeConfig,
  fetchAicodeLicenses,
  isInAicodeScopeCooldown,
  markAicodeScopeMissing,
  parseAicodeFetchConfig,
  parseAicodeFetchLicenses,
  resolveAicodeExperience,
} from "../src/providers/google-antigravity/aicode.js";
import { refreshAicodeEligibilityIfNeeded } from "../src/providers/google-antigravity/aicode-eligibility.js";
import {
  fetchProviderQuota,
  parseGoogleQuotaSummaryResponse,
} from "../src/providers/google-antigravity/quota.js";
import { dynamicCatalog } from "../src/providers/google-antigravity/dynamic-catalog.js";
import {
  forwardRequest,
  SseEventAccumulator,
} from "../src/providers/google-antigravity/forward.js";

interface CapturedReq {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

async function startStubServer(
  handler: (req: CapturedReq) => {
    status: number;
    headers?: Record<string, string>;
    body: string;
  },
): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const result = handler({
        method: req.method || "GET",
        url: req.url || "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(result.status, {
        "Content-Type": "application/json",
        ...result.headers,
      });
      res.end(result.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function makeEligibleAccount(overrides: Partial<AccountRuntime> = {}): AccountRuntime {
  const config = {
    email: "twin-aicode@gmail.com",
    provider: "google-antigravity",
    refreshToken: "rt-aicode",
    projectId: "aicode-consumers",
    projectSource: "google" as const,
    tier: "pro" as const,
  };
  const base: AccountRuntime = {
    config,
    accessToken: "ya29.aicode-token",
    tokenExpires: Date.now() + 3600_000,
    tokenScopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
      AICODE_SCOPE,
    ],
    requestsSinceRotation: 0,
    totalRequests: 0,
    cooldownsByModel: {},
    quotaExhaustedAt: 0,
    quota: [],
    lastQuotaPoll: 0,
    lastUsed: 0,
    lastError: null,
    consecutiveErrors: 0,
    disabled: false,
    flagged: false,
    inFlightRequests: 0,
    inFlightByModel: {},
    allowFreshWindowStartsOverride: false,
    dailyRequestCount: 0,
    dailyRequestDay: "2026-11-26",
    healthScore: 1,
    tokenBucket: { tokens: 15, lastRefillAt: Date.now() },
  };
  const merged = { ...base, ...overrides };
  const gen = getCredentialGeneration(merged, "google-antigravity");
  if (!overrides.aicodeEligibility) {
    merged.aicodeEligibility = {
      credentialGeneration: gen,
      checkedAt: Date.now(),
      personalConsumer: true,
      useAicodeMendel: true,
      inferenceTrafficMigration: true,
      darkLaunchAicodeQuotaStatus: false,
      userTierId: "g1-pro-tier",
    };
  }
  return merged;
}

const origAicodeEndpoints = [...AICODE_ENDPOINTS];
const origCcpaEndpoints = [...ANTIGRAVITY_ENDPOINTS];
const prevUseAicode = process.env.USE_AICODE;
const prevAicodeEndpointUrl = process.env.AICODE_ENDPOINT_URL;

afterEach(() => {
  AICODE_ENDPOINTS.splice(0, AICODE_ENDPOINTS.length, ...origAicodeEndpoints);
  (ANTIGRAVITY_ENDPOINTS as unknown as string[]).splice(
    0,
    ANTIGRAVITY_ENDPOINTS.length,
    ...origCcpaEndpoints,
  );
  if (prevUseAicode === undefined) delete process.env.USE_AICODE;
  else process.env.USE_AICODE = prevUseAicode;
  if (prevAicodeEndpointUrl === undefined) delete process.env.AICODE_ENDPOINT_URL;
  else process.env.AICODE_ENDPOINT_URL = prevAicodeEndpointUrl;
});

describe("AICode Phase 2 & Phase 3 routing", () => {
  it("parses fetchConfig experiences (skipping disabled model-less entries) and fetchLicenses tier", () => {
    const cfg = parseAicodeFetchConfig(
      {
        experimentConfig: {
          experimentFlags: [
                { name: "use-aicode-mendel", boolValue: true },
                { name: "enable-inference-traffic-migration", boolValue: true },
              ],
        },
        availableExperiences: [
          { name: "gemini-3.8-flash-tiered", model: { modelId: "gemini-3.8-flash" } },
          { name: "claude-sonnet-5-5-high", model: { modelId: "claude-sonnet-5-5" } },
          { name: "gemini-4-carbon-disabled" },
        ],
      },
      "gen-1",
      1000,
    );
    assert.ok(cfg);
    assert.equal(cfg.useAicodeMendel, true);
    assert.equal(cfg.inferenceTrafficMigration, true);
    assert.equal(resolveAicodeExperience(cfg, "Gemini-3.8-Flash-Tiered"), "gemini-3.8-flash-tiered");
    assert.equal(resolveAicodeExperience(cfg, "gemini-4-carbon-disabled"), null);
    assert.equal(resolveAicodeExperience(cfg, "gemini-4-hydrogen-high"), null);

    const lic = parseAicodeFetchLicenses(
      { licenses: [{ userTier: "g1-pro-tier", tierDisplayName: "Google AI Pro" }] },
      "gen-1",
      1000,
    );
    assert.ok(lic);
    assert.equal(lic.userTier, "g1-pro-tier");
    assert.equal(lic.tierDisplayName, "Google AI Pro");
  });

  it("refreshes aicodeEligibility even when account already has the aicode scope", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("loadCodeAssist")) {
        return new Response(
          JSON.stringify({ gcpManaged: false, paidTier: { id: "g1-pro-tier" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("listExperiments")) {
        return new Response(
          JSON.stringify({
            flags: [
              { name: "use-aicode-mendel", boolValue: true },
              { name: "enable-inference-traffic-migration", boolValue: false },
              { name: "dark-launch-aicode-quota-status", boolValue: true },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;

    try {
      const acc = makeEligibleAccount({ aicodeEligibility: undefined });
      delete acc.aicodeEligibility;
      await refreshAicodeEligibilityIfNeeded(
        acc,
        { Authorization: "Bearer ya29.aicode-token" },
        () => true,
      );
      const eligibility = (acc as AccountRuntime).aicodeEligibility;
      assert.equal(eligibility?.personalConsumer, true);
      assert.equal(eligibility?.useAicodeMendel, true);
      assert.equal(eligibility?.inferenceTrafficMigration, false);
      assert.equal(eligibility?.darkLaunchAicodeQuotaStatus, true);
      assert.equal(eligibility?.userTierId, "g1-pro-tier");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes eligible models to AICode v1alpha with flat payload and wrapped SSE output", async () => {
    const aicodeCalls: CapturedReq[] = [];
    const ccpaCalls: CapturedReq[] = [];

    const aicodeStub = await startStubServer((req) => {
      aicodeCalls.push(req);
      if (req.url === "/v1alpha:fetchConfig") {
        return {
          status: 200,
          body: JSON.stringify({
            experimentConfig: {
              experimentFlags: [
                { name: "use-aicode-mendel", boolValue: true },
                { name: "enable-inference-traffic-migration", boolValue: true },
              ],
            },
            availableExperiences: [
              { name: "gemini-3.8-flash-tiered", model: { modelId: "gemini-3.8-flash" } },
              { name: "claude-sonnet-5-5-high", model: { modelId: "claude-sonnet-5-5" } },
            ],
          }),
        };
      }
      if (req.url === "/v1alpha:fetchLicenses") {
        return {
          status: 200,
          body: JSON.stringify({
            licenses: [{ userTier: "g1-pro-tier", tierDisplayName: "Google AI Pro" }],
          }),
        };
      }
      if (req.url === "/v1alpha:streamGenerateContent?alt=sse") {
        return {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body:
            `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hello " }] } }] })}\n\n` +
            `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "AICode" }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } })}\n\n` +
            "data: [DONE]\n\n",
        };
      }
      return { status: 404, body: "{}" };
    });

    const ccpaStub = await startStubServer((req) => {
      ccpaCalls.push(req);
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "CCPA" }] } }] } })}\n\n`,
      };
    });

    AICODE_ENDPOINTS.splice(0, AICODE_ENDPOINTS.length, aicodeStub.url);
    (ANTIGRAVITY_ENDPOINTS as unknown as string[]).splice(0, ANTIGRAVITY_ENDPOINTS.length, ccpaStub.url);

    try {
      const account = makeEligibleAccount();
      const forwarded = await forwardRequest(
        account,
        {
          project: "aicode-consumers",
          model: "gemini-3.8-flash-tiered",
          request: {
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            generationConfig: { maxOutputTokens: 32 },
          },
        },
        {},
        undefined,
        { apiRetry: false },
      );

      assert.equal(forwarded.endpoint, aicodeStub.url);
      assert.equal(forwarded.response.status, 200);
      assert.equal(ccpaCalls.length, 0);

      const streamReq = aicodeCalls.find((c) => c.url === "/v1alpha:streamGenerateContent?alt=sse");
      assert.ok(streamReq);
      assert.equal(streamReq.headers["x-goog-user-project"], undefined);
      const sent = JSON.parse(streamReq.body) as Record<string, unknown>;
      assert.deepEqual(sent.aicode, { experience: "gemini-3.8-flash-tiered" });
      assert.deepEqual(sent.entitlement, { userTier: "g1-pro-tier" });
      assert.equal("model" in sent, false);
      assert.equal("project" in sent, false);
      assert.equal("requestId" in sent, false);
      assert.equal("userPromptId" in sent, false);
      assert.equal("requestType" in sent, false);
      assert.ok(Array.isArray(sent.contents));
      assert.ok(typeof sent.sessionId === "string" && sent.sessionId.length > 0);
      assert.ok(sent.systemInstruction);

      const sseText = await forwarded.response.text();
      const events = sseText
        .split("\n\n")
        .map((b) => b.trim())
        .filter((b) => b.startsWith("data:") && !b.endsWith("[DONE]"))
        .map((b) => JSON.parse(b.slice(5).trim()) as Record<string, unknown>);
      assert.equal(events.length, 2);
      assert.ok("response" in events[0], "SSE chunks should be wrapped in { response } for v1internal callers");
      assert.ok("response" in events[1]);

      const acc = new SseEventAccumulator();
      const usage = acc.append(sseText);
      assert.equal(acc.getText(), "Hello AICode");
      assert.deepEqual(usage, { inputTokens: 12, outputTokens: 4 });

      // Second call uses 5m discovery cache (no extra fetchConfig/fetchLicenses)
      const beforeDiscoveryCount = aicodeCalls.filter(
        (c) => c.url === "/v1alpha:fetchConfig" || c.url === "/v1alpha:fetchLicenses",
      ).length;
      const ccpaOnlyModel = await forwardRequest(
        account,
        {
          project: "aicode-consumers",
          model: "gemini-4-hydrogen-high",
          request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        },
        {},
        undefined,
        { apiRetry: false },
      );
      const afterDiscoveryCount = aicodeCalls.filter(
        (c) => c.url === "/v1alpha:fetchConfig" || c.url === "/v1alpha:fetchLicenses",
      ).length;
      assert.equal(afterDiscoveryCount, beforeDiscoveryCount, "discovery results should be cached");
      assert.equal(ccpaOnlyModel.endpoint, ccpaStub.url, "CCPA-only model must bypass AICode");
      assert.equal(ccpaCalls.length, 1);
    } finally {
      await stopServer(aicodeStub.server);
      await stopServer(ccpaStub.server);
    }
  });

  it("falls back to CCPA on 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT and enters 1h cooldown without flagging", async () => {
    let aicodeGenHits = 0;
    let ccpaGenHits = 0;

    const aicodeStub = await startStubServer((req) => {
      if (req.url === "/v1alpha:fetchConfig") {
        return {
          status: 200,
          body: JSON.stringify({
            experimentConfig: {
              experimentFlags: [
                { name: "use-aicode-mendel", boolValue: true },
                { name: "enable-inference-traffic-migration", boolValue: true },
              ],
            },
            availableExperiences: [
              { name: "gemini-3.8-flash-tiered", model: { modelId: "gemini-3.8-flash" } },
            ],
          }),
        };
      }
      if (req.url === "/v1alpha:fetchLicenses") {
        return {
          status: 200,
          body: JSON.stringify({ licenses: [{ userTier: "g1-pro-tier" }] }),
        };
      }
      aicodeGenHits += 1;
      return {
        status: 403,
        body: JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Request had insufficient authentication scopes.",
            details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
          },
        }),
      };
    });

    const ccpaStub = await startStubServer(() => {
      ccpaGenHits += 1;
      return {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "from-ccpa" }] } }] } })}\n\n`,
      };
    });

    AICODE_ENDPOINTS.splice(0, AICODE_ENDPOINTS.length, aicodeStub.url);
    (ANTIGRAVITY_ENDPOINTS as unknown as string[]).splice(0, ANTIGRAVITY_ENDPOINTS.length, ccpaStub.url);

    try {
      const account = makeEligibleAccount();
      const first = await forwardRequest(
        account,
        {
          project: "aicode-consumers",
          model: "gemini-3.8-flash-tiered",
          request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        },
        {},
        undefined,
        { apiRetry: false },
      );

      assert.equal(first.response.status, 200);
      assert.equal(first.endpoint, ccpaStub.url);
      assert.equal(aicodeGenHits, 1);
      assert.equal(ccpaGenHits, 1);
      assert.equal(account.flagged, false);
      assert.equal(account.disabled, false);
      assert.equal(isInAicodeScopeCooldown(account), true);
      assert.equal(shouldAttemptAicodeRouting(account), false);

      // Next request during 1h cooldown goes straight to CCPA without touching AICode.
      const second = await forwardRequest(
        account,
        {
          project: "aicode-consumers",
          model: "gemini-3.8-flash-tiered",
          request: { contents: [{ role: "user", parts: [{ text: "hi again" }] }] },
        },
        {},
        undefined,
        { apiRetry: false },
      );
      assert.equal(second.response.status, 200);
      assert.equal(second.endpoint, ccpaStub.url);
      assert.equal(aicodeGenHits, 1);
      assert.equal(ccpaGenHits, 2);
    } finally {
      await stopServer(aicodeStub.server);
      await stopServer(ccpaStub.server);
    }
  });

  it("skips AICode for enterprise accounts, migration flag off, or USE_AICODE=false", async () => {
    const enterprise = makeEligibleAccount();
    enterprise.aicodeEligibility!.personalConsumer = false;
    assert.equal(shouldAttemptAicodeRouting(enterprise), false);

    // Antigravity.app: use-aicode-mendel=true does not move generation to AICode.
    const mendelOnly = makeEligibleAccount();
    mendelOnly.aicodeEligibility!.useAicodeMendel = true;
    mendelOnly.aicodeEligibility!.inferenceTrafficMigration = false;
    assert.equal(shouldAttemptAicodeRouting(mendelOnly), false);

    const unknownMigration = makeEligibleAccount();
    unknownMigration.aicodeEligibility!.inferenceTrafficMigration = null;
    assert.equal(shouldAttemptAicodeRouting(unknownMigration), false);

    // USE_AICODE=true forces the prediction flow like the official client.
    process.env.USE_AICODE = "true";
    assert.equal(shouldAttemptAicodeRouting(mendelOnly), true);
    delete process.env.USE_AICODE;

    const noMendel = makeEligibleAccount();
    noMendel.aicodeEligibility!.useAicodeMendel = false;
    assert.equal(shouldAttemptAicodeRouting(noMendel), true);

    const eligible = makeEligibleAccount();
    assert.equal(shouldAttemptAicodeRouting(eligible), true);
    process.env.USE_AICODE = "false";
    assert.equal(shouldAttemptAicodeRouting(eligible), false);
    delete process.env.USE_AICODE;

    // 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT during fetchAicodeConfig enters cooldown cleanly
    const scopeErrStub = await startStubServer(() => ({
      status: 403,
      body: JSON.stringify({ error: { message: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } }),
    }));
    AICODE_ENDPOINTS.splice(0, AICODE_ENDPOINTS.length, scopeErrStub.url);
    try {
      const cfg = await fetchAicodeConfig(eligible);
      assert.equal(cfg, null);
      assert.equal(isInAicodeScopeCooldown(eligible), true);
      const lic = await fetchAicodeLicenses(makeEligibleAccount());
      assert.equal(lic, null);
    } finally {
      await stopServer(scopeErrStub.server);
    }

    // markAicodeScopeMissing isolates per credential generation
    const acc = makeEligibleAccount();
    markAicodeScopeMissing(acc);
    assert.equal(isInAicodeScopeCooldown(acc), true);
    acc.config.refreshToken = "new-rt";
    assert.equal(isInAicodeScopeCooldown(acc), false);

    // Payload helper omits v1internal envelope fields
    const built = buildAicodeGenerateContentRequest(
      {
        project: "ignored",
        model: "gemini-3.8-flash-tiered",
        requestId: "agent/123",
        userPromptId: "uuid",
        userAgent: "antigravity",
        requestType: "agent",
        request: {
          contents: [{ role: "user", parts: [{ text: "x" }] }],
          sessionId: "-123",
          systemInstruction: { parts: [{ text: "sys" }] },
        },
      },
      "gemini-3.8-flash-tiered",
      "g1-pro-tier",
    );
    assert.deepEqual(Object.keys(built).sort(), [
      "aicode",
      "contents",
      "entitlement",
      "sessionId",
      "systemInstruction",
    ]);

    // wrapAicodeSseResponse leaves non-ok error responses raw
    const errRes = new Response('{"error":{"code":429}}', { status: 429 });
    assert.equal(wrapAicodeSseResponse(errRes), errRes);

    // resolveAicodeTarget returns null when USE_AICODE=false
    process.env.USE_AICODE = "false";
    assert.equal(await resolveAicodeTarget(makeEligibleAccount(), "gemini-3.8-flash-tiered", {}), null);
  });

  it("Phase 4: parses fetchQuotaStatus refreshWindowLabel into CCPA summary windows", () => {
    const summary = parseGoogleQuotaSummaryResponse({
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              bucketId: "gemini-weekly",
              refreshWindowLabel: "weekly",
              remainingFraction: 0.75,
              resetTime: "2026-12-03T12:00:00Z",
            },
            {
              bucketId: "gemini-5h",
              refreshWindowLabel: "5h",
              remainingFraction: 0.4,
              resetTime: "2026-11-26T22:00:00Z",
            },
          ],
        },
      ],
    });
    assert.ok(summary);
    assert.equal(summary.groups?.[0]?.buckets?.[0]?.window, "weekly");
    assert.equal(summary.groups?.[0]?.buckets?.[1]?.window, "5h");
  });

  it("Phase 4: keeps CCPA retrieveUserQuotaSummary as quota source and only shadows fetchQuotaStatus under dark-launch", async () => {
    const originalFetch = globalThis.fetch;
    let ccpaSummaryCalls = 0;
    let aicodeQuotaCalls = 0;
    let aicodeOtherCalls = 0;
    const aicodeStub = await startStubServer((req) => {
      if (req.url === "/v1alpha:fetchQuotaStatus") {
        aicodeQuotaCalls += 1;
        return {
          status: 200,
          body: JSON.stringify({
            buckets: [
              {
                remainingFraction: 0.1,
                model: { modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
              },
            ],
            quotaSummary: {
              groups: [
                {
                  displayName: "Gemini Models",
                  buckets: [{ bucketId: "gemini-5h", refreshWindowLabel: "5h", remainingFraction: 0.1 }],
                },
              ],
            },
          }),
        };
      }
      aicodeOtherCalls += 1;
      return { status: 404, body: "{}" };
    });
    AICODE_ENDPOINTS.splice(0, AICODE_ENDPOINTS.length, aicodeStub.url);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("fetchAvailableModels")) {
        return new Response(
          JSON.stringify({
            models: {
              "gemini-4-hydrogen-high": { quotaInfo: { remainingFraction: 0.8 } },
              "gemini-3.8-flash-tiered": { quotaInfo: { remainingFraction: 0.8 } },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        ccpaSummaryCalls += 1;
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.55 }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const ctx = { log: () => {}, markFlagged: () => {}, reportQuotaPollFlag: () => {} };
    try {
      // Migration on, dark-launch off: no AICode management calls at all.
      const acc = makeEligibleAccount();
      assert.equal(shouldShadowAicodeQuotaStatus(acc), false);
      await fetchProviderQuota(acc, ctx);
      assert.equal(aicodeQuotaCalls, 0);
      assert.equal(aicodeOtherCalls, 0);
      assert.equal(ccpaSummaryCalls, 1);
      assert.equal(acc.quota.find((q) => q.modelKey === "gemini")?.percentRemaining, 55);

      // Dark-launch on: fetchQuotaStatus runs as shadow; CCPA still decides quota.
      const shadow = makeEligibleAccount();
      shadow.aicodeEligibility!.darkLaunchAicodeQuotaStatus = true;
      assert.equal(shouldShadowAicodeQuotaStatus(shadow), true);
      await fetchProviderQuota(shadow, ctx);
      assert.equal(aicodeQuotaCalls, 1);
      assert.equal(ccpaSummaryCalls, 2);
      assert.equal(shadow.quota.find((q) => q.modelKey === "gemini")?.percentRemaining, 55);

      // USE_AICODE=false disables the shadow call too.
      process.env.USE_AICODE = "false";
      assert.equal(shouldShadowAicodeQuotaStatus(shadow), false);
    } finally {
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await stopServer(aicodeStub.server);
    }
  });

  it("Phase 4: shadow fetchQuotaStatus 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT enters cooldown without flagging", async () => {
    const originalFetch = globalThis.fetch;
    let ccpaSummaryCalls = 0;
    const aicodeStub = await startStubServer(() => ({
      status: 403,
      body: JSON.stringify({ error: { message: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" } }),
    }));
    AICODE_ENDPOINTS.splice(0, AICODE_ENDPOINTS.length, aicodeStub.url);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("fetchAvailableModels")) {
        return new Response(
          JSON.stringify({
            models: { "gemini-3.8-flash-tiered": { quotaInfo: { remainingFraction: 0.6 } } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("retrieveUserQuotaSummary")) {
        ccpaSummaryCalls += 1;
        return new Response(
          JSON.stringify({
            groups: [
              {
                displayName: "Gemini Models",
                buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.55 }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const acc = makeEligibleAccount();
      acc.aicodeEligibility!.darkLaunchAicodeQuotaStatus = true;
      let flagged = false;
      await fetchProviderQuota(acc, {
        log: () => {},
        markFlagged: () => {
          flagged = true;
        },
        reportQuotaPollFlag: () => {},
      });
      assert.equal(flagged, false);
      assert.equal(isInAicodeScopeCooldown(acc), true);
      assert.equal(ccpaSummaryCalls, 1);
      assert.equal(acc.quota.find((q) => q.modelKey === "gemini")?.percentRemaining, 55);
    } finally {
      dynamicCatalog.reset();
      globalThis.fetch = originalFetch;
      await stopServer(aicodeStub.server);
    }
  });
});
