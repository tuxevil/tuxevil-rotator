import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import type { RequestBody, RotationOutcome } from "../src/proxy.js";
import type { AccountConfig, AccountRuntime, Config } from "../src/types.js";
import { getAccountIdentity } from "../src/account-identity.js";
import { setAntigravityModelsForTest } from "./fixtures/antigravity-catalog.js";

const testDir = mkdtempSync(join(tmpdir(), "proxy-model-switches-"));
process.env.TUXEVIL_ROTATOR_DIR = testDir;
process.env.PI_ROTATOR_DIR = testDir;
process.env.TUXEVIL_ROTATOR_ADMIN_TOKEN = "";
process.env.PI_ROTATOR_ADMIN_TOKEN = "";
process.env.TUXEVIL_ROTATOR_TELEMETRY = "off";
process.env.ANTIGRAVITY_CLIENT_ID = "test-client-id";
process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
delete process.env.DATABASE_URL;
delete process.env.TUXEVIL_ROTATOR_DATABASE_URL;
delete process.env.PI_ROTATOR_DATABASE_URL;

let AccountRotator: typeof import("../src/rotator.js").AccountRotator;
let withRotation: typeof import("../src/proxy.js").withRotation;
let startProxy: typeof import("../src/proxy.js").startProxy;
let getProviderAdapter: typeof import("../src/providers/registry.js").getProviderAdapter;
let closeDb: typeof import("../src/db-store.js").closeDb;
let stopVersionChecker: typeof import("../src/version-check.js").stopVersionChecker;
let stopNotificationPoller: typeof import("../src/notification-poller.js").stopNotificationPoller;
let openAIToAntigravityBody: typeof import("../src/providers/google-antigravity/translators.js").openAIToAntigravityBody;
let setEffortRoutingOverride: typeof import("../src/types.js").setEffortRoutingOverride;
let RotatorAudioSession: typeof import("../src/audio-transcription.js").RotatorAudioSession;
let resetCatalog: () => void;

type Rotator = InstanceType<typeof AccountRotator>;
type Capture = { providerId: string; account: AccountRuntime; body: RequestBody };
const GOOGLE = "google-antigravity";
const MODEL = "gemini-3.8-flash-high";
const EFFORT_ALIAS = "gemini-3.8-flash-low";
const EFFORT_TARGET = "gemini-3.8-flash-medium";
const captures: Capture[] = [];
const rotators: Rotator[] = [];
const servers: Server[] = [];
const controllers: AbortController[] = [];
let accountSequence = 0;
const originalFetch = globalThis.fetch;

before(async () => {
  ({ AccountRotator } = await import("../src/rotator.js"));
  ({ withRotation, startProxy } = await import("../src/proxy.js"));
  ({ getProviderAdapter } = await import("../src/providers/registry.js"));
  const db = await import("../src/db-store.js");
  closeDb = db.closeDb;
  await db.initDb();
  ({ stopVersionChecker } = await import("../src/version-check.js"));
  ({ stopNotificationPoller } = await import("../src/notification-poller.js"));
  ({ openAIToAntigravityBody } = await import("../src/providers/google-antigravity/translators.js"));
  ({ setEffortRoutingOverride } = await import("../src/types.js"));
  ({ RotatorAudioSession } = await import("../src/audio-transcription.js"));
  const { dynamicCatalog } = await import("../src/providers/google-antigravity/dynamic-catalog.js");
  resetCatalog = () => dynamicCatalog.reset();
});

beforeEach(() => {
  captures.length = 0;
  mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "only loopback HTTP is allowed in this regression suite");
    return originalFetch(input, init);
  });
  for (const providerId of [GOOGLE, "ollama", "openai-codex", "opencode-zen"]) {
    const provider = getProviderAdapter(providerId);
    mock.method(provider, "ensureValidToken", async () => {});
    mock.method(provider, "forwardRequest", async (account: AccountRuntime, body: RequestBody) => {
      captures.push({ providerId, account, body });
      return successResponse(providerId);
    });
  }
});

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  for (const rotator of rotators.splice(0)) {
    rotator.stopQuotaPolling();
    await rotator.flushPendingStateSave();
  }
  stopVersionChecker();
  stopNotificationPoller();
  setEffortRoutingOverride(null);
  resetCatalog();
  mock.restoreAll();
});

after(async () => {
  await closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

function successResponse(providerId = GOOGLE) {
  const data = providerId === "ollama"
    ? '{"message":{"role":"assistant","content":"ok"},"done":true}\n'
    : 'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n';
  return {
    response: new Response(data, {
      headers: { "content-type": providerId === "ollama" ? "application/x-ndjson" : "text/event-stream" },
    }),
    endpoint: `mock://${providerId}`,
  };
}

function makeRotator(overrides: Partial<Config> = {}, count = 1) {
  const configs = Array.from({ length: count }, (): AccountConfig => ({
    email: `switch-${++accountSequence}@example.com`,
    tier: "free",
    credentials: [
      { provider: GOOGLE, refreshToken: "test-refresh", projectId: `project-${accountSequence}` },
      { provider: "ollama", apiKey: "test-ollama-key" },
    ],
  }));
  const rotator = new AccountRotator({
    proxyPort: 51200,
    requestsPerRotation: 100,
    rotateOnQuotaDrop: 20,
    quotaPollIntervalMs: 300_000,
    maxConcurrentRequestsPerAccount: 1,
    maxConcurrentRequestsPerProjectModel: 1,
    accounts: configs,
    ...overrides,
  });
  rotator.stopQuotaPolling();
  rotators.push(rotator);
  const accounts = (rotator as unknown as { accounts: AccountRuntime[] }).accounts;
  setAntigravityModelsForTest(
    [MODEL, EFFORT_ALIAS, EFFORT_TARGET, "gemini-3.1-pro-high", "gemini-pro-agent"],
    accounts.map(getAccountIdentity),
  );
  for (const account of accounts) {
    account.accessToken = "test-access-token";
    account.tokenExpires = Date.now() + 3_600_000;
    account.quota = ["gemini", "monthly"].map((modelKey) => ({
      modelKey,
      displayName: modelKey,
      percentRemaining: 100,
      resetTime: new Date(Date.now() + 3_600_000).toISOString(),
      timerType: "5h",
      providerId: modelKey === "monthly" ? "ollama" : GOOGLE,
    }));
  }
  return { rotator, accounts };
}

function requestBody(overrides: Partial<RequestBody> = {}): RequestBody {
  return {
    project: "test-project",
    model: MODEL,
    request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
    ...overrides,
  };
}

function assertOff(outcome: RotationOutcome<string>): void {
  assert.equal(outcome.ok, false, "a model switched off before forwarding must be rejected");
  if (!outcome.ok) {
    assert.equal(outcome.status, 404);
    assert.match(outcome.errorText, /turned off/);
  }
}

function assertReleased(accounts: AccountRuntime[]): void {
  for (const account of accounts) {
    assert.equal(account.inFlightRequests, 0, "rejection must return all reserved capacity");
    assert.deepEqual(account.inFlightByModel, {});
  }
}

async function listenProxy(rotator: Rotator): Promise<string> {
  const server = startProxy(rotator, 0, "127.0.0.1");
  servers.push(server);
  stopVersionChecker();
  stopNotificationPoller();
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-skip-safety-jitter": "true" },
    body: JSON.stringify(body),
  });
}

/** One second of 16 kHz PCM loud enough to pass the live session's speech detection. */
function loudPcm(): Buffer {
  const pcm = Buffer.alloc(32_000);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(offset % 4 ? -10_000 : 10_000, offset);
  return pcm;
}

function translatedEffortRequest(): RequestBody {
  setEffortRoutingOverride({
    [EFFORT_ALIAS]: { defaultEffort: "medium", targets: { medium: EFFORT_TARGET } },
  });
  return openAIToAntigravityBody({
    model: EFFORT_ALIAS,
    messages: [{ role: "user", content: "hello" }],
  });
}

function observeAdmission(rotator: Rotator): Promise<string | undefined> {
  let onAdmission!: (model: string | undefined) => void;
  const entered = new Promise<string | undefined>((resolve) => { onAdmission = resolve; });
  const getActive = rotator.getActiveAccount.bind(rotator);
  mock.method(rotator, "getActiveAccount", (...args: Parameters<Rotator["getActiveAccount"]>) => {
    const pending = getActive(...args);
    onAdmission(args[0]);
    return pending;
  });
  return entered;
}

describe("Models switch enforcement at request admission and dispatch", () => {
  for (const { name, body, disabledId } of [
    { name: "requested model", body: requestBody(), disabledId: MODEL },
    {
      name: "catalog model before upstream aliasing",
      body: requestBody({ model: "gemini-pro-agent", catalogModel: "gemini-3.1-pro-high" }),
      disabledId: "gemini-3.1-pro-high",
    },
    {
      name: "upstream alias of a requested model",
      body: requestBody({ model: "gemini-3.1-pro-high" }),
      disabledId: "gemini-pro-agent",
    },
  ]) {
    it(`rejects a queued request after its ${name} is switched off`, async () => {
      const { rotator, accounts } = makeRotator();
      const controller = new AbortController();
      controllers.push(controller);
      const held = await rotator.getActiveAccount(body.model, undefined, GOOGLE);
      assert.ok(held);
      const pending = withRotation(rotator, body.model, {}, body, (response) => response.text(), controller.signal);
      assert.equal((rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length, 1);
      await rotator.setModelsEnabled([`${GOOGLE}/${disabledId}`], false);
      rotator.finishRequest(held, rotator.resolveQuotaModelKeyForDisplay(body.model, GOOGLE));
      const outcome = await pending;
      assertOff(outcome);
      assert.equal(captures.length, 0);
      assertReleased(accounts);
    });
  }

  it("rechecks a production-translated effort alias after queue admission", async () => {
    const { rotator, accounts } = makeRotator();
    const body = translatedEffortRequest();
    assert.equal(body.model, EFFORT_TARGET);
    assert.equal(body.catalogModel, EFFORT_TARGET);
    assert.equal(body.displayModel, EFFORT_ALIAS);
    const held = await rotator.getActiveAccount(body.model, undefined, GOOGLE);
    assert.ok(held);
    const pending = withRotation(rotator, body.model, {}, body, (response) => response.text());
    assert.equal((rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length, 1);
    await rotator.setModelsEnabled([`${GOOGLE}/${EFFORT_ALIAS}`], false);
    rotator.finishRequest(held, rotator.resolveQuotaModelKeyForDisplay(body.model, GOOGLE));
    const outcome = await pending;
    assertOff(outcome);
    if (!outcome.ok) assert.match(outcome.errorText, /gemini-3\.8-flash-low/);
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks a translated effort alias after token validation", async () => {
    const { rotator, accounts } = makeRotator();
    const body = translatedEffortRequest();
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async (account: AccountRuntime) => {
      if (account === accounts[0]) await rotator.setModelsEnabled([`${GOOGLE}/${EFFORT_ALIAS}`], false);
    });
    const outcome = await withRotation(rotator, body.model, {}, body, (response) => response.text());
    assertOff(outcome);
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks a translated effort alias before retrying after rotation", async () => {
    const { rotator, accounts } = makeRotator({}, 2);
    const body = translatedEffortRequest();
    const rotate = rotator.rotateToNext.bind(rotator);
    mock.method(rotator, "rotateToNext", async (...args: Parameters<Rotator["rotateToNext"]>) => {
      await rotator.setModelsEnabled([`${GOOGLE}/${EFFORT_ALIAS}`], false);
      return rotate(...args);
    });
    mock.method(getProviderAdapter(GOOGLE), "forwardRequest", async (account: AccountRuntime, forwardedBody: RequestBody) => {
      captures.push({ providerId: GOOGLE, account, body: forwardedBody });
      return captures.length === 1
        ? { response: new Response("upstream failed", { status: 500 }), endpoint: "mock://google" }
        : successResponse();
    });
    const outcome = await withRotation(rotator, body.model, {}, body, (response) => response.text());
    assertOff(outcome);
    assert.equal(captures.length, 1);
    assertReleased(accounts);
  });

  for (const { name, path, payload } of [
    { name: "OpenAI", path: "/v1/chat/completions", payload: { model: EFFORT_ALIAS, messages: [{ role: "user", content: "hello" }] } },
    { name: "Anthropic", path: "/v1/messages", payload: { model: EFFORT_ALIAS, max_tokens: 16, messages: [{ role: "user", content: "hello" }] } },
    { name: "Responses", path: "/v1/responses", payload: { model: EFFORT_ALIAS, input: "hello", store: false } },
  ]) {
    it(`rejects a queued ${name} request when its translated effort alias is switched off`, async () => {
      const { rotator, accounts } = makeRotator();
      translatedEffortRequest();
      const held = await rotator.getActiveAccount(EFFORT_TARGET, undefined, GOOGLE);
      assert.ok(held);
      const enteredAdmission = observeAdmission(rotator);
      const base = await listenProxy(rotator);
      const pendingResponse = post(`${base}${path}`, payload);
      assert.equal(await enteredAdmission, EFFORT_TARGET, "the production handler must translate before admission");
      assert.equal((rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length, 1);
      await rotator.setModelsEnabled([`${GOOGLE}/${EFFORT_ALIAS}`], false);
      rotator.finishRequest(held, rotator.resolveQuotaModelKeyForDisplay(EFFORT_TARGET, GOOGLE));
      const response = await pendingResponse;
      const json = await response.json() as { error: { message: string } };
      assert.equal(response.status, 404);
      assert.match(json.error.message, /gemini-3\.8-flash-low.*turned off/);
      assert.equal(captures.length, 0);
      assertReleased(accounts);
    });
  }

  it("continues serving an enabled production-translated effort alias", async () => {
    const { rotator, accounts } = makeRotator();
    const body = translatedEffortRequest();
    const outcome = await withRotation(rotator, body.model, {}, body, (response) => response.text());
    assert.equal(outcome.ok, true);
    assert.equal(captures[0]?.body.model, EFFORT_TARGET);
    assertReleased(accounts);
  });

  it("continues serving an enabled ordinary model alias", async () => {
    const { rotator, accounts } = makeRotator();
    const body = openAIToAntigravityBody({
      model: "gemini-3.1-pro-high",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(body.model, "gemini-pro-agent");
    const outcome = await withRotation(rotator, body.model, {}, body, (response) => response.text());
    assert.equal(outcome.ok, true);
    assert.equal(captures[0]?.body.model, "gemini-pro-agent");
    assertReleased(accounts);
  });

  it("checks the concrete auto selection while keeping auto as display metadata", async () => {
    const { rotator, accounts } = makeRotator({
      disabledModels: [`${GOOGLE}/auto`],
      typesafeRouting: { enabled: false },
    });
    mock.method(rotator, "getAutoRoutingCandidateStatus", (model: string) => ({
      available: model === EFFORT_TARGET,
      operationalScore: 1,
      poolKey: "gemini",
    }));
    const base = await listenProxy(rotator);
    const response = await post(`${base}/v1/chat/completions`, {
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(captures[0]?.body.displayModel, "auto");
    assert.equal(captures[0]?.body.model, EFFORT_TARGET);
    assertReleased(accounts);
  });

  it("reports a provider switched off during queue admission as a model-off rejection", async () => {
    const { rotator, accounts } = makeRotator();
    const held = await rotator.getActiveAccount(MODEL, undefined, GOOGLE);
    assert.ok(held);
    const pending = withRotation(
      rotator,
      MODEL,
      {},
      requestBody({ providerId: GOOGLE }),
      (response) => response.text(),
    );
    assert.equal((rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length, 1);
    await rotator.setProviderEnabled(GOOGLE, false);
    rotator.finishRequest(held, rotator.resolveQuotaModelKeyForDisplay(MODEL, GOOGLE));
    assertOff(await pending);
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks after asynchronous token validation and releases the admitted account", async () => {
    const { rotator, accounts } = makeRotator();
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async (account: AccountRuntime) => {
      if (account === accounts[0]) await rotator.setModelsEnabled([`${GOOGLE}/${MODEL}`], false);
    });
    const outcome = await withRotation(rotator, MODEL, {}, requestBody(), (response) => response.text());
    assertOff(outcome);
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks the admitted account's provider switch after token validation and reroutes", async () => {
    const { rotator, accounts } = makeRotator({}, 2);
    let switchedOff: string | undefined;
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async (account: AccountRuntime) => {
      // Admission validates a snapshot copy; only withRotation passes the real account.
      if (switchedOff || !accounts.includes(account)) return;
      switchedOff = account.config.email;
      await rotator.setAccountProviderEnabled(switchedOff, GOOGLE, false);
    });
    const outcome = await withRotation(rotator, MODEL, {}, requestBody(), (response) => response.text());
    assert.ok(switchedOff);
    assert.equal(outcome.ok, true);
    assert.equal(captures.length, 1);
    assert.notEqual(captures[0].account.config.email, switchedOff, "no request may be sent through the switched-off account");
    assertReleased(accounts);
  });

  it("keeps the admitted provider pinned when its model is switched off and another provider still serves the ID", async () => {
    const { rotator, accounts } = makeRotator({ providerOrder: [GOOGLE, "ollama"] });
    rotator.setOllamaModels([MODEL]);
    const held = await rotator.getActiveAccount(MODEL, undefined, GOOGLE);
    assert.ok(held);
    const body = requestBody({ providerId: GOOGLE });
    const pending = withRotation(rotator, MODEL, {}, body, (response) => response.text());
    assert.equal((rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length, 1);
    await rotator.setModelsEnabled([`${GOOGLE}/${MODEL}`], false);
    rotator.finishRequest(held, rotator.resolveQuotaModelKeyForDisplay(MODEL, GOOGLE));
    assertOff(await pending);
    assert.equal(captures.length, 0, "the queued Google envelope must not be rerouted to Ollama");
    assertReleased(accounts);
  });

  it("does not retry a model switched off while rotating after an upstream failure", async () => {
    const { rotator, accounts } = makeRotator({}, 2);
    const rotate = rotator.rotateToNext.bind(rotator);
    mock.method(rotator, "rotateToNext", async (...args: Parameters<Rotator["rotateToNext"]>) => {
      await rotator.setModelsEnabled([`${GOOGLE}/${MODEL}`], false);
      return rotate(...args);
    });
    mock.method(getProviderAdapter(GOOGLE), "forwardRequest", async (account: AccountRuntime, body: RequestBody) => {
      captures.push({ providerId: GOOGLE, account, body });
      return captures.length === 1
        ? { response: new Response("upstream failed", { status: 500 }), endpoint: "mock://google" }
        : successResponse();
    });
    const outcome = await withRotation(rotator, MODEL, {}, requestBody(), (response) => response.text());
    assertOff(outcome);
    assert.equal(captures.length, 1, "the switch must prevent a second upstream attempt");
    assertReleased(accounts);
  });

  for (const hint of ["ollama", "unknown-provider", 123]) {
    it(`rejects an incompatible native Google provider hint (${hint}) before forwarding`, async () => {
      const { rotator, accounts } = makeRotator({ disabledModels: [`${GOOGLE}/${MODEL}`] });
      const base = await listenProxy(rotator);
      const response = await post(`${base}/v1internal:generateContent`, { ...requestBody(), providerId: hint });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /providerId/);
      assert.equal(captures.length, 0);
      assertReleased(accounts);
    });
  }

  for (const hint of [undefined, GOOGLE]) {
    it(`honors Google-native switches with ${hint ? "a matching hint" : "no hint"}`, async () => {
      const { rotator } = makeRotator({ disabledModels: [`${GOOGLE}/${MODEL}`] });
      const base = await listenProxy(rotator);
      const response = await post(`${base}/v1internal:generateContent`, requestBody({ providerId: hint }));
      assert.equal(response.status, 404);
      assert.match(await response.text(), /turned off/);
      assert.equal(captures.length, 0);
    });
  }

  for (const requestedModel of [7, null, {}, []]) {
    it(`rejects malformed native requestedModel (${JSON.stringify(requestedModel)}) before admission or forwarding`, async () => {
      const { rotator, accounts } = makeRotator();
      const admission = mock.method(rotator, "getActiveAccount", async () => {
        throw new Error("invalid request metadata must not reach admission");
      });
      const base = await listenProxy(rotator);
      const response = await post(`${base}/v1internal:generateContent`, { ...requestBody(), requestedModel });
      const json = await response.json() as { error: string; details: string[] };
      assert.equal(response.status, 400);
      assert.equal(json.error, "Invalid request body");
      assert.match(json.details.join("; "), /requestedModel.*string/);
      assert.equal(admission.mock.callCount(), 0);
      assert.equal(captures.length, 0);
      assertReleased(accounts);
    });
  }

  it("keeps Google-native envelopes on Google when Ollama lists the same model first", async () => {
    const { rotator, accounts } = makeRotator({ providerOrder: ["ollama", GOOGLE] });
    rotator.setOllamaModels([MODEL]);
    const base = await listenProxy(rotator);
    for (const providerId of [undefined, GOOGLE]) {
      const body = requestBody({ providerId, requestedModel: MODEL });
      const response = await post(`${base}/v1internal:generateContent`, body);
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(response.headers.get("x-rotator-selected-provider"), GOOGLE);
      assert.equal(captures.at(-1)?.providerId, GOOGLE);
      assert.deepEqual(captures.at(-1)?.body.request, body.request);
    }
    assertReleased(accounts);
  });

  it("keeps native Ollama chat on Ollama when Google lists the same model first", async () => {
    const { rotator, accounts } = makeRotator({ providerOrder: [GOOGLE, "ollama"] });
    rotator.setOllamaModels([MODEL]);
    const base = await listenProxy(rotator);
    const messages = [{ role: "user", content: "hello Ollama" }];
    for (const providerId of [undefined, "ollama"]) {
      const response = await post(`${base}/api/chat`, { model: MODEL, messages, providerId });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(captures.at(-1)?.providerId, "ollama");
      assert.deepEqual((captures.at(-1)?.body.request as { messages: unknown }).messages, messages);
    }
    assertReleased(accounts);
  });

  it("rejects a native Ollama hint that names a different provider", async () => {
    const { rotator } = makeRotator();
    rotator.setOllamaModels([MODEL]);
    const base = await listenProxy(rotator);
    const response = await post(`${base}/api/chat`, {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      providerId: GOOGLE,
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /providerId/);
    assert.equal(captures.length, 0);
  });

  it("rechecks native catalog switches after token validation and returns its reservation", async () => {
    const { rotator, accounts } = makeRotator();
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async (account: AccountRuntime) => {
      if (account === accounts[0]) await rotator.setModelsEnabled([`${GOOGLE}/gemini-3.1-pro-high`], false);
    });
    const base = await listenProxy(rotator);
    const response = await post(`${base}/v1internal:generateContent`, requestBody({
      model: "gemini-pro-agent",
      catalogModel: "gemini-3.1-pro-high",
    }));
    assert.equal(response.status, 404);
    assert.match(await response.text(), /turned off/);
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks a native request's account switch after token validation and returns its reservation", async () => {
    const { rotator, accounts } = makeRotator();
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async (account: AccountRuntime) => {
      await rotator.setAccountProviderEnabled(account.config.email, GOOGLE, false);
    });
    const base = await listenProxy(rotator);
    const response = await post(`${base}/v1internal:generateContent`, requestBody());
    assert.equal(response.status, 503);
    await response.body?.cancel();
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks whisper-1 after token validation for HTTP transcriptions", async () => {
    const { rotator, accounts } = makeRotator();
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async () => {
      await rotator.setModelsEnabled([`${GOOGLE}/whisper-1`], false);
    });
    const base = await listenProxy(rotator);
    const form = new FormData();
    form.append("file", new File([new Uint8Array(loudPcm())], "sample.pcm", { type: "audio/pcm" }));
    form.append("model", "whisper-1");
    const response = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "model_not_found");
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });

  it("rechecks whisper-1 after token validation for WebSocket segments", async () => {
    const { rotator, accounts } = makeRotator();
    mock.method(getProviderAdapter(GOOGLE), "ensureValidToken", async () => {
      await rotator.setModelsEnabled([`${GOOGLE}/whisper-1`], false);
    });
    const errors: Error[] = [];
    const session = new RotatorAudioSession(rotator, {
      model: "whisper-1",
      catalogModel: "whisper-1",
      onError: (err) => errors.push(err),
    });
    try {
      await session.start();
      session.sendChunk(loudPcm());
      await session.endSession();
    } finally {
      session.destroy();
    }
    assert.equal(captures.length, 0);
    assert.match(errors[0]?.message ?? "", /'whisper-1' is turned off/);
    assertReleased(accounts);
  });

  it("rejects a queued native Google request after its model is switched off", async () => {
    const { rotator, accounts } = makeRotator();
    const held = await rotator.getActiveAccount(MODEL, undefined, GOOGLE);
    assert.ok(held);
    let onAdmission!: () => void;
    const enteredAdmission = new Promise<void>((resolve) => { onAdmission = resolve; });
    const getActive = rotator.getActiveAccount.bind(rotator);
    mock.method(rotator, "getActiveAccount", (...args: Parameters<Rotator["getActiveAccount"]>) => {
      const pending = getActive(...args);
      onAdmission();
      return pending;
    });
    const base = await listenProxy(rotator);
    const pendingResponse = post(`${base}/v1internal:generateContent`, requestBody());
    await enteredAdmission;
    assert.equal((rotator as unknown as { requestWaiters: unknown[] }).requestWaiters.length, 1);
    await rotator.setModelsEnabled([`${GOOGLE}/${MODEL}`], false);
    rotator.finishRequest(held, rotator.resolveQuotaModelKeyForDisplay(MODEL, GOOGLE));
    const response = await pendingResponse;
    assert.equal(response.status, 404);
    assert.match(await response.text(), /turned off/);
    assert.equal(captures.length, 0);
    assertReleased(accounts);
  });
});
