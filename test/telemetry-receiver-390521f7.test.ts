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

describe("telemetry receiver REQUIRE_HTTPS_ADMIN enforcement (390521f7)", () => {
	let dir = "";
	let proc: ReturnType<typeof spawn> | null = null;
	let port = 0;
	const token = "secret-token-390521f7";

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-telemetry-390521f7-"));
		port = await getFreePort();
		proc = spawn(process.execPath, [RECEIVER_PATH], {
			env: {
				...process.env,
				PORT: String(port),
				DATA_DIR: dir,
				STATS_TOKEN: token,
				REQUIRE_HTTPS_ADMIN: "1",
				TRUSTED_PROXIES: "loopback,private",
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

	it("rejects HTTP-forwarded and spoofed X-Forwarded-Proto admin requests even over loopback proxy", async () => {
		const auth = { Authorization: `Bearer ${token}` };

		const okHttps = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { ...auth, "X-Forwarded-For": "203.0.113.10", "X-Forwarded-Proto": "https" },
		});
		assert.equal(okHttps.status, 200);

		const plainHttp = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { ...auth, "X-Forwarded-For": "203.0.113.10", "X-Forwarded-Proto": "http" },
		});
		assert.equal(plainHttp.status, 403);

		const spoofedMulti = await fetch(`http://127.0.0.1:${port}/v1/stats`, {
			headers: { ...auth, "X-Forwarded-For": "203.0.113.10", "X-Forwarded-Proto": "https, http" },
		});
		assert.equal(spoofedMulti.status, 403);

		const dashboardHttp = await fetch(`http://127.0.0.1:${port}/dashboard`, {
			headers: { "X-Forwarded-For": "203.0.113.10", "X-Forwarded-Proto": "https, http" },
		});
		assert.equal(dashboardHttp.status, 403);
	});
});
