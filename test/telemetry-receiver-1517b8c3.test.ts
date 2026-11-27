import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("telemetry receiver bounded JSONL cache & date pre-filter (1517b8c3)", () => {
	let dir = "";
	let proc: ReturnType<typeof spawn> | null = null;
	let port = 0;
	const today = "2026-11-26";
	const token = "poc-token-1234567890";

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-telemetry-1517b8c3-"));
		port = await getFreePort();
		const line = JSON.stringify({
			installId: "i1",
			version: "1.0.0",
			os: "darwin",
			event: "heartbeat",
			ts: "2026-10-01T00:00:00Z",
			modelsUsed: ["m1", "m2"],
			tokensByModel: { m1: { input: 1, output: 1, requests: 1 } },
			pad: "x".repeat(40),
		}) + "\n";
		const perFile = Math.floor((5.5 * 1024 * 1024) / line.length);
		const body = line.repeat(perFile);
		for (let d = 1; d <= 10; d++) {
			await writeFile(join(dir, `2026-10-${String(d).padStart(2, "0")}.jsonl`), body, "utf8");
		}
		await writeFile(
			join(dir, `${today}.jsonl`),
			JSON.stringify({
				installId: "i2",
				version: "1.0.0",
				os: "darwin",
				event: "heartbeat",
				ts: `${today}T00:00:00Z`,
				modelsUsed: ["m1"],
				tokensByModel: { m1: { input: 1, output: 1, requests: 1 } },
			}) + "\n",
			"utf8",
		);
		proc = spawn(process.execPath, ["--max-old-space-size=64", RECEIVER_PATH], {
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

	it("serves narrow date-range /v1/stats without OOM across large historical JSONL files", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/v1/stats?from=${today}&to=${today}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 200);
		const stats = (await res.json()) as { uniqueInstalls: number; totalEvents: number };
		assert.equal(stats.uniqueInstalls, 1);
		assert.equal(stats.totalEvents, 1);
	});
});
