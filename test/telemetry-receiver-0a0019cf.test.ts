import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("telemetry receiver flag dedup persistence (0a0019cf)", () => {
	let dir = "";
	let proc: ReturnType<typeof spawn> | null = null;
	let port = 0;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-telemetry-0a0019cf-"));
		port = await getFreePort();
		const day = new Date().toISOString().slice(0, 10);
		await writeFile(join(dir, `${day}-flags.jsonl`), "x".repeat(900) + "\n", "utf8");
		proc = spawn(process.execPath, [RECEIVER_PATH], {
			env: {
				...process.env,
				PORT: String(port),
				DATA_DIR: dir,
				MAX_DAILY_FILE_BYTES: "1000",
				FLAG_DEDUP_WINDOW_MS: "86400000",
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

	it("does not mark a flag event as deduplicated when persistence fails with 507", async () => {
		const payload = {
			event: "flag",
			installId: "poc-install-0a0019cf",
			version: "1.0.0",
			ts: "2026-01-01T00:00:00.000Z",
			flag: {
				flagHttpStatus: 403,
				flagPatternsMatched: ["suspend"],
				model: "m",
				timerType: "5h",
				accountQuotaPercent: 10,
				wasProAccount: true,
				accountTotalRequests: 1,
				accountRequestsLastHour: 1,
				accountConcurrentAtFlag: 1,
				poolSize: 2,
				poolHealthyCount: 1,
				protectivePauseTriggered: false,
				uptimeSeconds: 5,
				timeSinceLastFlagSeconds: -1,
			},
		};

		const r1 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(r1.status, 507);

		const day = new Date().toISOString().slice(0, 10);
		const flagsFile = join(dir, `${day}-flags.jsonl`);
		await writeFile(flagsFile, "", "utf8");

		const r2 = await fetch(`http://127.0.0.1:${port}/v1/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(r2.status, 202);
		const body2 = (await r2.json()) as { accepted: boolean; deduplicated?: boolean };
		assert.equal(body2.accepted, true);
		assert.notEqual(body2.deduplicated, true);

		const flagsContent = await readFile(flagsFile, "utf8");
		assert.ok(flagsContent.includes(payload.installId));
	});
});
