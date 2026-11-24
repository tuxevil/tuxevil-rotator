import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const RECEIVER_PATH = join(process.cwd(), "tools/telemetry-receiver/receiver.js");

async function waitForHealth(port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return;
		} catch {
			// retry
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("receiver did not become healthy in time");
}

describe("telemetry receiver", () => {
	let dir = "";
	let proc: ReturnType<typeof spawn> | null = null;
	const port = 40000 + Math.floor(Math.random() * 20000);

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-telemetry-"));
		proc = spawn(process.execPath, [RECEIVER_PATH], {
			env: {
				...process.env,
				PORT: String(port),
				DATA_DIR: dir,
				STATS_TOKEN: "secret-token",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		await waitForHealth(port);
	});

	after(async () => {
		proc?.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("accepts flag payloads and writes dedicated -flags.jsonl", async () => {
		const payload = {
			event: "flag",
			installId: "test-install",
			version: "1.10.0",
			ts: new Date().toISOString(),
			flag: {
				flagHttpStatus: 403,
				flagReasonCode: "VALIDATION_REQUIRED",
				flagReasonMessage: "Verify your account to continue.",
				flagPatternsMatched: ["violat", "blocked_401"],
				model: "quota-poll",
				timerType: "7d",
				accountQuotaPercent: 0,
				wasProAccount: true,
				accountTotalRequests: 123,
				accountRequestsLastHour: 9,
				accountConcurrentAtFlag: 1,
				poolSize: 18,
				poolHealthyCount: 3,
				protectivePauseTriggered: false,
				uptimeSeconds: 42,
				timeSinceLastFlagSeconds: -1,
			},
		};

		const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(res.status, 202);

		const day = new Date().toISOString().slice(0, 10);
		const flagsFile = join(dir, `${day}-flags.jsonl`);
		const raw = await readFile(flagsFile, "utf8");
		const line = JSON.parse(raw.trim().split("\n")[0]);
		assert.equal(line.installId, "test-install");
		assert.equal(line.flagHttpStatus, 403);
		assert.equal(line.flagReasonCode, "VALIDATION_REQUIRED");
		assert.equal(line.flagReasonMessage, "Verify your account to continue.");
		assert.deepEqual(line.flagPatternsMatched, ["violat", "blocked_401"]);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.equal(stats.flags.byReasonCode.VALIDATION_REQUIRED, 1);
		assert.equal(stats.flags.recentIncidents[0].flagReasonMessage, "Verify your account to continue.");

		const unsafe = structuredClone(payload);
		unsafe.flag.flagReasonMessage = "Verify at https://example.test/account";
		const unsafeRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(unsafe),
		});
		assert.equal(unsafeRes.status, 400);

		const legacy = structuredClone(payload);
		delete (legacy.flag as Partial<typeof legacy.flag>).flagReasonCode;
		delete (legacy.flag as Partial<typeof legacy.flag>).flagReasonMessage;
		const legacyRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(legacy),
		});
		assert.equal(legacyRes.status, 202);
	});

	it("does not expose historical notifications without the admin token", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/v1/notifications?all=true`);
		assert.equal(res.status, 401);
	});

	it("serves a public stats page without authentication", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/stats`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") || "", /text\/html/);
		assert.equal(res.headers.get("cache-control"), "no-cache");

		const html = await res.text();
		assert.match(html, /fetch\("\/v1\/public-stats"/);
		assert.match(html, /5 \* 60 \* 1000/);
		assert.match(html, /Installations/);
		assert.match(html, /Requests routed/);
		assert.match(html, /Estimated savings/);
		assert.match(html, /Input tokens/);
		assert.match(html, /Output tokens/);
	});

	it("serves the redesigned notification manager shell", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/notifications`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") || "", /text\/html/);

		const html = await res.text();
		assert.match(html, /Notification Manager/);
		assert.match(html, /id="connectionState"/);
		assert.match(html, /id="previewCard"/);
		assert.match(html, /id="notifSearch"/);
		assert.match(html, /v1\/notifications\?all=true/);

		const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
		assert.ok(script);
		assert.doesNotThrow(() => new Function(script));
	});

	it("serves the redesigned telemetry dashboard shell", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") || "", /text\/html/);

		const html = await res.text();
		assert.match(html, /Telemetry control room/);
		assert.match(html, /id="dashboardConnection"/);
		assert.match(html, /id="refreshBtn"/);
		assert.match(html, /id="filterBar"/);
		assert.match(html, /id="cHealth"/);
		assert.match(html, /id="cFlagReasons"/);
		assert.match(html, /id="flagIncidents"/);
		assert.match(html, /id="installTableWrap"/);
		assert.match(html, /localStorage\.getItem\('st'\)/);

		const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
		assert.ok(script);
		assert.doesNotThrow(() => new Function(script));
	});

	it("calculates estimated savings for gemini 3.6 flash models in /v1/stats", async () => {
		const payload = {
			event: "heartbeat",
			installId: "savings-test-install",
			version: "2.3.6",
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			accountCount: 1,
			modelsUsed: ["gemini-3.6-flash-high", "gemini-3.6-flash"],
			totalRequests: 15,
			uptimeSeconds: 100,
			routingHealthState: "healthy",
			tokensByModel: {
				"gemini-3.6-flash-high": { input: 1_000_000, output: 1_000_000, requests: 10 },
				"gemini-3.6-flash": { input: 1_000_000, output: 1_000_000, requests: 5 },
			},
		};

		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.ok(stats.savings);
		assert.ok(stats.savings.byModel["gemini-3.6-flash-high"]);
		assert.ok(stats.savings.byModel["gemini-3.6-flash"]);
		assert.equal(stats.savings.byModel["gemini-3.6-flash-high"].totalUsd, 4.50);
		assert.equal(stats.savings.byModel["gemini-3.6-flash"].totalUsd, 4.50);
	});

	it("calculates estimated savings for gemini 3.7 flash tiered in /v1/stats", async () => {
		const payload = {
			event: "heartbeat",
			installId: "gemini37-savings-test-install",
			version: "3.1.0",
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			accountCount: 1,
			modelsUsed: ["gemini-3.7-flash-tiered"],
			totalRequests: 10,
			uptimeSeconds: 300,
			routingHealthState: "healthy",
			tokensByModel: {
				"gemini-3.7-flash-tiered": { input: 1_000_000, output: 1_000_000, requests: 10 },
				"google/gemini-3.7-flash-tiered": { input: 1_000_000, output: 1_000_000, requests: 5 },
			},
		};

		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.ok(stats.savings);
		// Exact entry: 0.75 + 3.75 = 4.50 — not the gemini-3-flash 3.50 rates.
		assert.equal(stats.savings.byModel["gemini-3.7-flash-tiered"].totalUsd, 4.50);
		// Provider-prefixed id resolves through the 3.7-flash fallback.
		assert.equal(stats.savings.byModel["google/gemini-3.7-flash-tiered"].totalUsd, 4.50);
	});

	it("calculates estimated savings for native gemini 3.8 flash levels", async () => {
		const payload = {
			event: "heartbeat",
			installId: "gemini38-savings-test-install",
			version: "3.3.2",
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			accountCount: 1,
			modelsUsed: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"],
			totalRequests: 15,
			uptimeSeconds: 300,
			routingHealthState: "healthy",
			tokensByModel: {
				"gemini-3.8-flash-low": { input: 1_000_000, output: 1_000_000, requests: 5 },
				"gemini-3.8-flash-medium": { input: 1_000_000, output: 1_000_000, requests: 5 },
				"gemini-3.8-flash-high": { input: 1_000_000, output: 1_000_000, requests: 5 },
			},
		};

		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		const stats = (await statsRes.json()) as any;
		for (const variant of ["low", "medium", "high"]) {
			assert.equal(stats.savings.byModel[`gemini-3.8-flash-${variant}`].totalUsd, 4.50);
		}
	});

	it("calculates estimated savings for Ollama Cloud models in /v1/stats", async () => {
		const payload = {
			event: "heartbeat",
			installId: "ollama-savings-test-install",
			version: "2.8.12",
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			accountCount: 1,
			modelsUsed: ["gpt-oss:20b", "gemma4:31b", "deepseek-v4-pro", "kimi-k3"],
			totalRequests: 20,
			uptimeSeconds: 200,
			routingHealthState: "healthy",
			tokensByModel: {
				"gpt-oss:20b": { input: 1_000_000, output: 1_000_000, requests: 5 },
				"gemma4:31b": { input: 1_000_000, output: 1_000_000, requests: 5 },
				"deepseek-v4-pro": { input: 1_000_000, output: 1_000_000, requests: 5 },
				"kimi-k3": { input: 1_000_000, output: 1_000_000, requests: 5 },
			},
		};

		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.ok(stats.savings);
		assert.ok(stats.savings.byModel["gpt-oss:20b"]);
		assert.equal(stats.savings.byModel["gpt-oss:20b"].totalUsd, 0.37);
		assert.ok(stats.savings.byModel["gemma4:31b"]);
		assert.equal(stats.savings.byModel["gemma4:31b"].totalUsd, 0.54);
		assert.ok(stats.savings.byModel["deepseek-v4-pro"]);
		assert.equal(stats.savings.byModel["deepseek-v4-pro"].totalUsd, 5.28);
		assert.ok(stats.savings.byModel["kimi-k3"]);
		assert.equal(stats.savings.byModel["kimi-k3"].totalUsd, 18.00);
	});
	it("calculates estimated savings for OpenAI Codex models in /v1/stats", async () => {
		const payload = {
			event: "heartbeat",
			installId: "codex-savings-test-install",
			version: "2.8.12",
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			accountCount: 1,
			modelsUsed: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
			totalRequests: 15,
			uptimeSeconds: 150,
			routingHealthState: "healthy",
			tokensByModel: {
				"gpt-5.6-sol":   { input: 1_000_000, output: 1_000_000, requests: 5 },
				"gpt-5.6-terra": { input: 1_000_000, output: 1_000_000, requests: 5 },
				"gpt-5.6-luna":  { input: 1_000_000, output: 1_000_000, requests: 5 },
			},
		};

		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.ok(stats.savings);
		assert.ok(stats.savings.byModel["gpt-5.6-sol"]);
		assert.equal(stats.savings.byModel["gpt-5.6-sol"].totalUsd, 24.00);
		assert.ok(stats.savings.byModel["gpt-5.6-terra"]);
		assert.equal(stats.savings.byModel["gpt-5.6-terra"].totalUsd, 14.00);
		assert.ok(stats.savings.byModel["gpt-5.6-luna"]);
		assert.equal(stats.savings.byModel["gpt-5.6-luna"].totalUsd, 1.40);
	});

	it("exposes enriched fleet, daily, token, and flag forensic fields in /v1/stats and /v1/public-stats", async () => {
		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as any;
		assert.ok(Array.isArray(stats.daily) && stats.daily.length >= 1);
		assert.ok(typeof stats.daily[0].date === "string");
		assert.ok(stats.fleet && typeof stats.fleet.active24h === "number");
		assert.ok(stats.tokens && stats.tokens.totalInput > 0 && stats.tokens.totalOutput > 0);
		assert.ok(stats.flags.recentIncidents.length >= 1);
		const incident = stats.flags.recentIncidents[0];
		assert.equal(incident.accountRequestsLastHour, 9);
		assert.equal(incident.poolSize, 18);
		assert.equal(incident.poolHealthyCount, 3);
		assert.equal(incident.wasProAccount, true);

		const pubRes = await fetch(`http://127.0.0.1:${port}/v1/public-stats`);
		assert.equal(pubRes.status, 200);
		const pub = (await pubRes.json()) as any;
		assert.ok(typeof pub.installsFormatted === "string");
		assert.ok(typeof pub.totalTokensFormatted === "string");
		assert.ok(Array.isArray(pub.topModels));
		assert.ok(Array.isArray(pub.dailyTrend));
		assert.ok(typeof pub.osDistribution === "object");
		assert.ok(pub.catalogModels > 50);
	});

	it("serves valid inline JS and cyberpunk console components across /stats, /dashboard, and /notifications", async () => {
		const [pubHtml, dashHtml, notifHtml] = await Promise.all([
			fetch(`http://127.0.0.1:${port}/stats`).then((r) => r.text()),
			fetch(`http://127.0.0.1:${port}/dashboard`).then((r) => r.text()),
			fetch(`http://127.0.0.1:${port}/notifications`).then((r) => r.text()),
		]);

		const pubScript = pubHtml.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
		assert.ok(pubScript);
		assert.doesNotThrow(() => new Function(pubScript));
		assert.match(pubHtml, /id="topModelsList"/);
		assert.match(pubHtml, /id="pulseChartWrap"/);

		assert.match(dashHtml, /id="cTimeline"/);
		assert.match(dashHtml, /id="detailDrawerWrap"/);
		assert.match(dashHtml, /id="kbdModal"/);

		assert.match(notifHtml, /id="simVersion"/);
		assert.match(notifHtml, /id="sevGroup"/);
		assert.match(notifHtml, /localStorage\.getItem\('st'\)/);
	});

	it("preserves createdAt when editing an existing notification", async () => {
		const createRes = await fetch(`http://127.0.0.1:${port}/v1/notifications`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
			body: JSON.stringify({
				type: "warning",
				title: "Initial notice",
				message: "Original body",
				createdAt: "2026-10-01T00:00:00.000Z",
			}),
		});
		assert.equal(createRes.status, 200);
		const created = (await createRes.json()) as any;
		assert.equal(created.ok, true);
		const id = created.notification.id;

		const updateRes = await fetch(`http://127.0.0.1:${port}/v1/notifications`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
			body: JSON.stringify({
				id,
				type: "critical",
				title: "Updated notice",
				message: "Edited body",
			}),
		});
		assert.equal(updateRes.status, 200);
		const updated = (await updateRes.json()) as any;
		assert.equal(updated.notification.createdAt, "2026-10-01T00:00:00.000Z");
		assert.equal(updated.notification.type, "critical");

		const delRes = await fetch(`http://127.0.0.1:${port}/v1/notifications/${encodeURIComponent(id)}`, {
			method: "DELETE",
			headers: { Authorization: "Bearer secret-token" },
		});
		assert.equal(delRes.status, 200);
	});
});
