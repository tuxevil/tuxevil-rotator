import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const RECEIVER_PATH = join(process.cwd(), "tools/telemetry-receiver/receiver.js");

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.on("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => resolve(port));
		});
	});
}

async function waitForHealth(port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
			if (res.ok) return;
		} catch {
			// retry
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("receiver did not become healthy in time");
}

describe("telemetry receiver provider-aware pricing (8cc0b118)", () => {
	let dir = "";
	let proc: ReturnType<typeof spawn> | null = null;
	let port = 0;
	const token = "poc-token-8cc0b118";

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-telemetry-8cc0b118-"));
		port = await getFreePort();
		proc = spawn(process.execPath, [RECEIVER_PATH], {
			env: { ...process.env, PORT: String(port), DATA_DIR: dir, STATS_TOKEN: token },
			stdio: ["ignore", "ignore", "pipe"],
		});
		await waitForHealth(port);
	});

	after(async () => {
		proc?.kill("SIGTERM");
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("normalizes ollama/opencode prefixes and avoids Gemini fallback on non-Gemini models", async () => {
		const big = { input: 1_000_000, output: 1_000_000, requests: 1 };
		const models = {
			"deepseek-v4-pro": big,
			"ollama/glm-5.3-flash-cloud": big,
			"ollama/deepseek-v4-pro-cloud": big,
			"opencode/ling-3.0-flash-fin-free": big,
			"acme-flash-preview": big,
		};
		const postRes = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event: "heartbeat",
				installId: "poc-install-8cc0b118",
				version: "2.8.12",
				nodeVersion: process.version,
				os: process.platform,
				arch: process.arch,
				ts: new Date().toISOString(),
				accountCount: 1,
				modelsUsed: Object.keys(models),
				totalRequests: 5,
				uptimeSeconds: 100,
				routingHealthState: "healthy",
				tokensByModel: models,
			}),
		});
		assert.equal(postRes.status, 202);

		const statsRes = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		assert.equal(statsRes.status, 200);
		const stats = (await statsRes.json()) as { savings: { byModel: Record<string, { totalUsd: number }> } };
		const by = stats.savings.byModel;
		assert.equal(by["deepseek-v4-pro"]?.totalUsd, 5.28);
		assert.equal(by["ollama/glm-5.3-flash-cloud"]?.totalUsd, 0.65);
		assert.equal(by["ollama/deepseek-v4-pro-cloud"]?.totalUsd, 5.28);
		assert.equal(by["opencode/ling-3.0-flash-fin-free"]?.totalUsd, 0);
		assert.equal(by["acme-flash-preview"], undefined);
	});
});
