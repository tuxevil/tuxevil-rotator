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
		assert.deepEqual(line.flagPatternsMatched, ["violat", "blocked_401"]);
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
		assert.equal(stats.savings.byModel["gemini-3.6-flash-high"].totalUsd, 9.00);
		assert.equal(stats.savings.byModel["gemini-3.6-flash"].totalUsd, 9.00);
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
		assert.equal(stats.savings.byModel["gpt-oss:20b"].totalUsd, 0.38);
		assert.ok(stats.savings.byModel["gemma4:31b"]);
		assert.equal(stats.savings.byModel["gemma4:31b"].totalUsd, 1.53);
		assert.ok(stats.savings.byModel["deepseek-v4-pro"]);
		assert.equal(stats.savings.byModel["deepseek-v4-pro"].totalUsd, 1.31);
		assert.ok(stats.savings.byModel["kimi-k3"]);
		assert.equal(stats.savings.byModel["kimi-k3"].totalUsd, 4.95);
	});
});
