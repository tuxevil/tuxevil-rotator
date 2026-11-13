import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	TelemetryReporter,
	isTelemetryEnabled,
	trackFeature,
	getFeaturesSnapshot,
	warnIfInsecureTelemetryEndpoint,
	resolveTelemetryEndpoint,
	FLAG_PATTERNS,
	extractFlagReason,
} from "../src/telemetry.js";
import { logger } from "../src/logger.js";
import type { TelemetryPayload, FlagEventData, FlagTelemetryPayload } from "../src/telemetry.js";
import { resolveTelemetryBase } from "../src/notification-poller.js";

describe("telemetry", () => {
	it("extracts a safe provider 403 reason without transmitting raw details", () => {
		const error = JSON.stringify({ error: {
			status: "PERMISSION_DENIED",
			message: "Verify your account to continue.",
			details: [{ reason: "VALIDATION_REQUIRED", metadata: { verificationUrl: "https://example.test" } }],
		} });
		assert.deepEqual(extractFlagReason(error), {
			flagReasonCode: "VALIDATION_REQUIRED",
			flagReasonMessage: "Verify your account to continue.",
		});
		assert.deepEqual(extractFlagReason(JSON.stringify({ error: {
			status: "PERMISSION_DENIED", message: "Verify at https://example.test/user@example.test",
		} })), { flagReasonCode: "PERMISSION_DENIED" });
	});

	const originalEnv = process.env.PI_ROTATOR_TELEMETRY;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_ROTATOR_TELEMETRY;
		} else {
			process.env.PI_ROTATOR_TELEMETRY = originalEnv;
		}
	});

	describe("isTelemetryEnabled()", () => {
		it("returns true by default (opt-out model)", () => {
			delete process.env.PI_ROTATOR_TELEMETRY;
			assert.equal(isTelemetryEnabled(), true);
		});

		it("returns false when PI_ROTATOR_TELEMETRY=off", () => {
			process.env.PI_ROTATOR_TELEMETRY = "off";
			assert.equal(isTelemetryEnabled(), false);
		});

		it("returns false when PI_ROTATOR_TELEMETRY=false", () => {
			process.env.PI_ROTATOR_TELEMETRY = "false";
			assert.equal(isTelemetryEnabled(), false);
		});

		it("returns false when PI_ROTATOR_TELEMETRY=0", () => {
			process.env.PI_ROTATOR_TELEMETRY = "0";
			assert.equal(isTelemetryEnabled(), false);
		});

		it("is case-insensitive", () => {
			process.env.PI_ROTATOR_TELEMETRY = "OFF";
			assert.equal(isTelemetryEnabled(), false);
		});
	});

	describe("resolveTelemetryEndpoint()", () => {
		it("accepts HTTP(S) overrides", () => {
			assert.equal(
				resolveTelemetryEndpoint("https://telemetry.example.test/v1/events"),
				"https://telemetry.example.test/v1/events",
			);
			assert.equal(
				resolveTelemetryEndpoint("http://localhost:3800/v1/events"),
				"http://localhost:3800/v1/events",
			);
		});

		it("falls back for invalid or unsupported overrides", () => {
			assert.match(
				resolveTelemetryEndpoint("javascript:alert(1)"),
				/^https:\/\/telemetry\.tuxevil\.com\/v1\/events$/,
			);
			assert.match(
				resolveTelemetryEndpoint("not a URL"),
				/^https:\/\/telemetry\.tuxevil\.com\/v1\/events$/,
			);
		});
	});

	describe("feature tracking", () => {
		it("tracks features as booleans", () => {
			trackFeature("dashboard");
			const snap = getFeaturesSnapshot();
			assert.equal(snap.dashboard, true);
			assert.equal(snap.hostedLogin, false);
		});

		it("is idempotent", () => {
			trackFeature("dashboard");
			trackFeature("dashboard");
			const snap = getFeaturesSnapshot();
			assert.equal(snap.dashboard, true);
		});
	});

	describe("FLAG_PATTERNS", () => {
		it("exports the known flag pattern list", () => {
			assert.ok(Array.isArray(FLAG_PATTERNS));
			assert.ok(FLAG_PATTERNS.length >= 9);
			assert.ok(FLAG_PATTERNS.includes("infring"));
			assert.ok(FLAG_PATTERNS.includes("abus"));
			assert.ok(FLAG_PATTERNS.includes("suspend"));
		});
	});

	describe("TelemetryReporter", () => {
		const mockMetrics = () => ({
			accountCount: 3,
			modelsUsed: ["gemini-3-flash", "claude-opus-4-6-thinking"],
			totalRequests: 42,
			uptimeSeconds: 3600,
			routingHealthState: "healthy",
			flaggedCount: 0,
			disabledCount: 1,
			proCount: 2,
			freeCount: 1,
			tokensByModel: {
				"claude-opus-4-6-thinking": { input: 524000, output: 180000, requests: 20 },
				"gemini-3-flash": { input: 1200000, output: 890000, requests: 22 },
			},
		});

		it("builds a valid heartbeat payload with tokensByModel", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildPayloadForTest("boot");

			// Structure
			assert.equal(payload.event, "boot");
			assert.equal(typeof payload.installId, "string");
			assert.ok(payload.installId.length >= 36, "installId should be a UUID");
			assert.equal(typeof payload.version, "string");
			assert.equal(payload.nodeVersion, process.version);
			assert.equal(payload.os, process.platform);
			assert.equal(payload.arch, process.arch);
			assert.equal(typeof payload.ts, "string");

			// Metrics pass-through
			assert.equal(payload.accountCount, 3);
			assert.deepEqual(payload.modelsUsed, ["gemini-3-flash", "claude-opus-4-6-thinking"]);
			assert.equal(payload.totalRequests, 42);
			assert.equal(payload.uptimeSeconds, 3600);
			assert.equal(payload.routingHealthState, "healthy");
			assert.equal(payload.flaggedCount, 0);
			assert.equal(payload.disabledCount, 1);
			assert.equal(payload.proCount, 2);
			assert.equal(payload.freeCount, 1);

			// tokensByModel
			assert.ok(payload.tokensByModel, "payload must include tokensByModel");
			assert.equal(payload.tokensByModel["claude-opus-4-6-thinking"].input, 524000);
			assert.equal(payload.tokensByModel["claude-opus-4-6-thinking"].output, 180000);
			assert.equal(payload.tokensByModel["claude-opus-4-6-thinking"].requests, 20);
			assert.equal(payload.tokensByModel["gemini-3-flash"].requests, 22);

			// Features
			assert.equal(typeof payload.featuresUsed, "object");
			assert.equal(typeof payload.featuresUsed.dashboard, "boolean");
		});

		it("produces consistent installId across calls", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const p1 = reporter._buildPayloadForTest("boot");
			const p2 = reporter._buildPayloadForTest("heartbeat");
			assert.equal(p1.installId, p2.installId);
		});

		it("payload contains NO sensitive data", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildPayloadForTest("boot");
			const serialized = JSON.stringify(payload);

			assert.equal(serialized.includes("@"), false, "payload must not contain email addresses");
			assert.equal(serialized.includes("Bearer"), false, "payload must not contain auth tokens");
			assert.equal(serialized.includes("refresh_token"), false, "payload must not contain refresh tokens");
			assert.equal(serialized.includes("projectId"), false, "payload must not contain project IDs");
		});

		it("supports all event types", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			for (const event of ["boot", "heartbeat", "shutdown"] as const) {
				const payload = reporter._buildPayloadForTest(event);
				assert.equal(payload.event, event);
			}
		});
	});

	describe("Flag event payload", () => {
		const mockMetrics = () => ({
			accountCount: 5,
			modelsUsed: ["gemini-3-flash"],
			totalRequests: 100,
			uptimeSeconds: 7200,
			routingHealthState: "healthy",
			flaggedCount: 1,
			disabledCount: 0,
			proCount: 3,
			freeCount: 2,
			tokensByModel: { "gemini-3-flash": { input: 500000, output: 300000, requests: 100 } },
		});

		const sampleFlagData: FlagEventData = {
			flagHttpStatus: 403,
			flagReasonCode: "VALIDATION_REQUIRED",
			flagReasonMessage: "Verify your account to continue.",
			flagPatternsMatched: ["infring", "violat"],
			model: "claude-opus-4-6-thinking",
			timerType: "5h",
			accountQuotaPercent: 45,
			wasProAccount: true,
			accountTotalRequests: 200,
			accountRequestsLastHour: 15,
			accountConcurrentAtFlag: 1,
			poolSize: 5,
			poolHealthyCount: 3,
			protectivePauseTriggered: false,
			uptimeSeconds: 7200,
			timeSinceLastFlagSeconds: -1,
		};

		it("survives a rejected flag telemetry request", () => {
			const script = `
				import { TelemetryReporter } from './src/telemetry.ts';
				globalThis.fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
				new TelemetryReporter(() => ({})).reportFlag(${JSON.stringify(sampleFlagData)});
				setTimeout(() => {}, 25);
			`;
			const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--import", "tsx/esm", "--input-type=module", "-e", script], {
				cwd: process.cwd(),
				env: { ...process.env, PI_ROTATOR_TELEMETRY: "on", TUXEVIL_ROTATOR_TELEMETRY: "on" },
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
		});

		it("builds a valid flag payload", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildFlagPayloadForTest(sampleFlagData);

			assert.equal(payload.event, "flag");
			assert.equal(typeof payload.installId, "string");
			assert.equal(typeof payload.version, "string");
			assert.equal(typeof payload.ts, "string");
			assert.deepEqual(payload.flag, sampleFlagData);
			assert.equal(payload.flag.flagReasonCode, "VALIDATION_REQUIRED");
			assert.equal(payload.flag.flagReasonMessage, "Verify your account to continue.");
		});

		it("flag payload contains NO email or PII", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildFlagPayloadForTest(sampleFlagData);
			const serialized = JSON.stringify(payload);

			assert.equal(serialized.includes("@"), false, "flag payload must not contain emails");
			assert.equal(serialized.includes("Bearer"), false, "flag payload must not contain tokens");
			assert.equal(serialized.includes("projectId"), false, "flag payload must not contain project IDs");
			// Must not contain actual error text
			assert.equal(serialized.includes("infringement"), false, "must not contain error message text");
		});

		it("only includes known flag patterns", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildFlagPayloadForTest(sampleFlagData);
			const knownPatterns = new Set<string>([...FLAG_PATTERNS, "blocked_401"]);

			for (const pattern of payload.flag.flagPatternsMatched) {
				assert.ok(
					knownPatterns.has(pattern),
					`Unknown pattern: ${pattern}`,
				);
			}
		});

		it("captures all relevant context fields for anti-flag analysis", () => {
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildFlagPayloadForTest(sampleFlagData);
			const flag = payload.flag;

			// These fields are all critical for analyzing what causes flags
			assert.equal(typeof flag.flagHttpStatus, "number");
			assert.ok(Array.isArray(flag.flagPatternsMatched));
			assert.equal(typeof flag.model, "string");
			assert.equal(typeof flag.timerType, "string");
			assert.equal(typeof flag.accountQuotaPercent, "number");
			assert.equal(typeof flag.wasProAccount, "boolean");
			assert.equal(typeof flag.accountTotalRequests, "number");
			assert.equal(typeof flag.accountRequestsLastHour, "number");
			assert.equal(typeof flag.accountConcurrentAtFlag, "number");
			assert.equal(typeof flag.poolSize, "number");
			assert.equal(typeof flag.poolHealthyCount, "number");
			assert.equal(typeof flag.protectivePauseTriggered, "boolean");
			assert.equal(typeof flag.uptimeSeconds, "number");
			assert.equal(typeof flag.timeSinceLastFlagSeconds, "number");
		});

		it("401 flag uses blocked_401 pattern when no standard pattern matches", () => {
			const data: FlagEventData = {
				...sampleFlagData,
				flagHttpStatus: 401,
				flagPatternsMatched: ["blocked_401" as any],
			};
			const reporter = new TelemetryReporter(mockMetrics);
			const payload = reporter._buildFlagPayloadForTest(data);
			assert.deepEqual(payload.flag.flagPatternsMatched, ["blocked_401"]);
		});
	});
});

describe("warnIfInsecureTelemetryEndpoint", () => {
	const originalInsecureOk = process.env.PI_ROTATOR_TELEMETRY_INSECURE_OK;

	afterEach(() => {
		if (originalInsecureOk === undefined) {
			delete process.env.PI_ROTATOR_TELEMETRY_INSECURE_OK;
		} else {
			process.env.PI_ROTATOR_TELEMETRY_INSECURE_OK = originalInsecureOk;
		}
	});

	function captureLog(): string[] {
		const lines: string[] = [];
		const originalWriter = (logger as unknown as { writer: (line: string) => void }).writer;
		(logger as unknown as { writer: (line: string) => void }).writer = (line) => lines.push(line);
		return lines;
	}

	function restoreLog(originalWriter: (line: string) => void): void {
		(logger as unknown as { writer: (line: string) => void }).writer = originalWriter;
	}

	it("returns false for an https:// endpoint without logging", () => {
		const originalWriter = (logger as unknown as { writer: (line: string) => void }).writer;
		const lines = captureLog();
		try {
			const result = warnIfInsecureTelemetryEndpoint("https://telemetry.example.com/events");
			assert.equal(result, false);
			assert.equal(lines.length, 0);
		} finally {
			restoreLog(originalWriter);
		}
	});

	it("returns true and logs for a plain http:// endpoint", () => {
		const originalWriter = (logger as unknown as { writer: (line: string) => void }).writer;
		const lines = captureLog();
		try {
			const result = warnIfInsecureTelemetryEndpoint("http://telemetry.example.com/events");
			assert.equal(result, true);
			assert.equal(lines.length, 1);
			assert.match(lines[0], /plain HTTP/);
			assert.match(lines[0], /PI_ROTATOR_TELEMETRY_URL|TUXEVIL_ROTATOR_TELEMETRY_URL/);
		} finally {
			restoreLog(originalWriter);
		}
	});

	it("silences the warning when PI_ROTATOR_TELEMETRY_INSECURE_OK=1", () => {
		const originalWriter = (logger as unknown as { writer: (line: string) => void }).writer;
		const lines = captureLog();
		process.env.PI_ROTATOR_TELEMETRY_INSECURE_OK = "1";
		try {
			const result = warnIfInsecureTelemetryEndpoint(
				"http://telemetry.example.com/events",
				{ PI_ROTATOR_TELEMETRY_INSECURE_OK: "1" },
			);
			assert.equal(result, false);
			assert.equal(lines.length, 0);
		} finally {
			restoreLog(originalWriter);
		}
	});
});

describe("resolveTelemetryBase", () => {
	it("normalizes HTTP(S) overrides to their origin", () => {
		assert.equal(
			resolveTelemetryBase("https://telemetry.example.test/v1/events"),
			"https://telemetry.example.test",
		);
	});

	it("falls back instead of throwing for invalid overrides", () => {
		assert.equal(
			resolveTelemetryBase("file:///tmp/telemetry"),
			"https://telemetry.tuxevil.com",
		);
	});
});
