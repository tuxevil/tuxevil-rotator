// Anonymous usage telemetry — opt-out via TUXEVIL_ROTATOR_TELEMETRY=off
//
// What we collect (all anonymous):
//   - Random install ID (UUID, not tied to any account)
//   - Rotator version, Node version, OS, arch
//   - Account count, models used, total requests, uptime, savings USD
//   - Routing health state, flagged/disabled/pro/free counts
//   - Features used (dashboard, login, toggles — booleans only)
//   - Flag events: HTTP status, matched patterns, model, pool state,
//     request velocity — everything needed to improve the anti-flag algorithm
//
// What we NEVER include in telemetry payloads or event files:
//   - Emails, tokens, project IDs, request bodies, error message text
// Source IPs are not part of the JSON telemetry payload, but the receiver and
// network path can observe them for transport and rate limiting.
//
// Docs: https://github.com/tuxevil/tuxevil-rotator#telemetry

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./paths.js";
import { logger } from "./logger.js";
import { rotatorEnv } from "./env.js";

const telemetryLogger = logger.child("telemetry");

// ── Public telemetry endpoint (not a secret — anonymous data only) ───
// Update this URL to your VPS before publishing to npm.
// Can be overridden via TUXEVIL_ROTATOR_TELEMETRY_URL.
// HTTPS is preferred to avoid leaking the operator's IP in plaintext.
const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.tuxevil.com/v1/events";

export function resolveTelemetryEndpoint(raw: string | undefined): string {
	const candidate = raw?.trim();
	if (!candidate) return DEFAULT_TELEMETRY_ENDPOINT;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
		return candidate;
	} catch {
		telemetryLogger.log(
			"warn",
			"Ignoring invalid TUXEVIL_ROTATOR_TELEMETRY_URL; using the default HTTPS endpoint.",
		);
		return DEFAULT_TELEMETRY_ENDPOINT;
	}
}

const TELEMETRY_ENDPOINT = resolveTelemetryEndpoint(rotatorEnv("TELEMETRY_URL"));

const HEARTBEAT_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
const SEND_TIMEOUT_MS = 5000;

// ── Known flag patterns (same list used in proxy.ts for detection) ───
export const FLAG_PATTERNS = [
	"infring", "suspend", "abus", "terminat",
	"violat", "banned", "policy", "forbidden", "verif",
] as const;
export type FlagPattern = typeof FLAG_PATTERNS[number];

/** Keep provider reasons useful for diagnosis without sending raw errors or links. */
export function extractFlagReason(errorText: string): {
	flagReasonCode?: string;
	flagReasonMessage?: string;
} {
	let code: unknown;
	let message: unknown;
	try {
		const parsed = JSON.parse(errorText) as {
			error?: { status?: unknown; message?: unknown; details?: Array<{ reason?: unknown }> };
		};
		code = parsed.error?.details?.find((detail) => typeof detail?.reason === "string")?.reason
			?? parsed.error?.status;
		message = parsed.error?.message;
	} catch {
		message = errorText;
	}
	const flagReasonCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
		? code : undefined;
	const rawMessage = typeof message === "string" ? message.trim().replace(/\s+/g, " ") : "";
	// Provider errors can include verification URLs, account addresses, and tokens.
	const flagReasonMessage = rawMessage &&
		!/(?:https?:\/\/|@|bearer\s|access[_ -]?token|refresh[_ -]?token|api[_ -]?key)/i.test(rawMessage)
		? rawMessage.slice(0, 160) : undefined;
	return { ...(flagReasonCode ? { flagReasonCode } : {}),
		...(flagReasonMessage ? { flagReasonMessage } : {}) };
}

// ── Version ──────────────────────────────────────────────────────────
let _version: string | null = null;
function getVersion(): string {
	if (_version) return _version;
	try {
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
		_version = pkg.version ?? "unknown";
	} catch {
		_version = "unknown";
	}
	return _version!;
}

// ── Opt-out check ────────────────────────────────────────────────────
export function isTelemetryEnabled(): boolean {
	const env = rotatorEnv("TELEMETRY")?.toLowerCase();
	return env !== "off" && env !== "false" && env !== "0";
}

// ── Insecure-endpoint warning ───────────────────────────────────────
let warnedAboutInsecureTelemetry = false;

/**
 * Emit a one-time warning if the telemetry endpoint is plain HTTP, since that
 * leaks the operator's IP and network metadata to any on-path observer.
 * The warning can be silenced with TUXEVIL_ROTATOR_TELEMETRY_INSECURE_OK=1.
 *
 * The INSECURE_OK check runs before the once-flag so the operator's explicit
 * acknowledgement is always honored, even after a previous run warned.
 */
export function warnIfInsecureTelemetryEndpoint(
	endpoint: string = TELEMETRY_ENDPOINT,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (!/^http:\/\//i.test(endpoint)) return false;
	if (
		(env.TUXEVIL_ROTATOR_TELEMETRY_INSECURE_OK ??
			env.PI_ROTATOR_TELEMETRY_INSECURE_OK) === "1"
	)
		return false;
	if (warnedAboutInsecureTelemetry) return true;
	warnedAboutInsecureTelemetry = true;
	telemetryLogger.log(
		"warn",
		`Telemetry endpoint uses plain HTTP (${endpoint}). This leaks the operator's IP on every heartbeat. ` +
		`Set TUXEVIL_ROTATOR_TELEMETRY_URL to an https:// endpoint, or TUXEVIL_ROTATOR_TELEMETRY_INSECURE_OK=1 to silence this warning.`,
	);
	return true;
}

// ── Feature tracking (set by other modules) ──────────────────────────
const _featuresUsed = new Set<string>();

export function trackFeature(feature: string): void {
	_featuresUsed.add(feature);
}

export function getFeaturesSnapshot(): Record<string, boolean> {
	return {
		dashboard: _featuresUsed.has("dashboard"),
		freshWindowToggle: _featuresUsed.has("freshWindowToggle"),
		hostedLogin: _featuresUsed.has("hostedLogin"),
	};
}

// ── Install ID (persisted random UUID — no PII) ─────────────────────
function getOrCreateInstallId(): string {
	const idPath = join(getConfigDir(), ".telemetry-id");
	try {
		if (existsSync(idPath)) {
			const existing = readFileSync(idPath, "utf-8").trim();
			if (existing.length > 0) return existing;
		}
	} catch { /* regenerate */ }

	const id = randomUUID();
	try {
		writeFileSync(idPath, id, "utf-8");
	} catch { /* best effort */ }
	return id;
}

// ── First-run notice ─────────────────────────────────────────────────
function isFirstRun(): boolean {
	const idPath = join(getConfigDir(), ".telemetry-id");
	return !existsSync(idPath);
}

function printTelemetryNotice(): void {
	console.log();
	console.log("  ╭──────────────────────────────────────────────────────────╮");
	console.log("  │  Anonymous telemetry is enabled to help improve the      │");
	console.log("  │  rotator. No emails, tokens, project IDs, request bodies │");
	console.log("  │  or error text are sent — only aggregate usage stats.    │");
	console.log("  │                                                          │");
	console.log("  │  Flag events help us improve the anti-flag algorithm     │");
	console.log("  │  for everyone. Consider keeping telemetry on!            │");
	console.log("  │                                                          │");
	console.log("  │  Opt out anytime:  TUXEVIL_ROTATOR_TELEMETRY=off              │");
	console.log("  │  Details: github.com/tuxevil/tuxevil-rotator      │");
	console.log("  ╰──────────────────────────────────────────────────────────╯");
	console.log();
}

// ── Metrics supplier (injected by caller) ────────────────────────────
export interface TelemetryMetrics {
	accountCount: number;
	modelsUsed: string[];
	totalRequests: number;
	uptimeSeconds: number;
	routingHealthState: string;
	flaggedCount: number;
	disabledCount: number;
	proCount: number;
	freeCount: number;
	tokensByModel: Record<string, { input: number; output: number; requests: number }>;
}

// ── Heartbeat payload ────────────────────────────────────────────────
export interface TelemetryPayload {
	event: "boot" | "heartbeat" | "shutdown";
	installId: string;
	version: string;
	nodeVersion: string;
	os: string;
	arch: string;
	ts: string;
	accountCount: number;
	modelsUsed: string[];
	totalRequests: number;
	uptimeSeconds: number;
	routingHealthState: string;
	flaggedCount: number;
	disabledCount: number;
	proCount: number;
	freeCount: number;
	tokensByModel: Record<string, { input: number; output: number; requests: number }>;
	featuresUsed: Record<string, boolean>;
}

// ── Flag event payload ───────────────────────────────────────────────
// Sent immediately when an account gets flagged by Google.
// This is the most important telemetry signal — it drives anti-flag
// algorithm improvements that benefit all users.
//
// NO PII in the payload: no email, raw error body, projectId, or request body.
// Reason code and bounded message are filtered before transmission.
export interface FlagEventData {
	// What triggered it
	flagHttpStatus: number;                  // 401 or 403
	flagPatternsMatched: FlagPattern[];      // which known patterns matched
	flagReasonCode?: string;                 // upstream reason, e.g. VALIDATION_REQUIRED
	flagReasonMessage?: string;              // bounded message after privacy filtering

	// What was happening
	model: string;                           // model key being requested
	timerType: "fresh" | "5h" | "7d" | "monthly" | "unknown";  // quota window state
	accountQuotaPercent: number;             // quota % at time of flag (-1 if unknown)

	// Account state (anonymous — no email)
	wasProAccount: boolean;                  // was the account in Pro tier
	accountTotalRequests: number;            // lifetime requests on this account
	accountRequestsLastHour: number;         // requests in the last 60min on this account
	accountConcurrentAtFlag: number;         // in-flight requests when flag hit

	// Pool state
	poolSize: number;                        // total accounts
	poolHealthyCount: number;                // accounts still routing after this flag
	protectivePauseTriggered: boolean;       // did this flag trigger a protective pause

	// Timing
	uptimeSeconds: number;                   // process uptime
	timeSinceLastFlagSeconds: number;        // seconds since the previous flag (-1 if first)
}

export interface FlagTelemetryPayload {
	event: "flag";
	installId: string;
	version: string;
	ts: string;
	flag: FlagEventData;
}

// ── Module-level reporter reference for flag reporting ───────────────
let _activeReporter: TelemetryReporter | null = null;

export function setActiveReporter(reporter: TelemetryReporter): void {
	_activeReporter = reporter;
}

/**
 * Report a flag event. Called from proxy.ts when an account gets flagged.
 * Fire-and-forget: never throws, never blocks, never affects proxy flow.
 */
export function reportFlagEvent(data: FlagEventData): void {
	_activeReporter?.reportFlag(data);
}

// ── Reporter ─────────────────────────────────────────────────────────
export class TelemetryReporter {
	private installId: string = "";
	private timer: ReturnType<typeof setInterval> | null = null;
	private getMetrics: () => TelemetryMetrics;
	private enabled: boolean;
	private lastFlagTimestamp: number = 0;

	constructor(getMetrics: () => TelemetryMetrics) {
		this.getMetrics = getMetrics;
		this.enabled = isTelemetryEnabled();
	}

	async start(): Promise<void> {
		if (!this.enabled) {
			telemetryLogger.log("debug", "Telemetry disabled by user");
			return;
		}

		const firstRun = isFirstRun();
		this.installId = getOrCreateInstallId();

		if (firstRun) {
			printTelemetryNotice();
		}

		telemetryLogger.log("debug", `Telemetry active (id=${this.installId.slice(0, 8)}…)`);

		await this.send("boot");

		this.timer = setInterval(() => void this.send("heartbeat"), HEARTBEAT_INTERVAL_MS);
		this.timer.unref(); // don't prevent process exit
	}

	async shutdown(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (!this.enabled) return;
		await this.send("shutdown");
	}

	/**
	 * Send a flag event immediately. Called via reportFlagEvent().
	 */
	reportFlag(data: FlagEventData): void {
		if (!this.enabled) return;

		const now = Date.now();
		data.timeSinceLastFlagSeconds = this.lastFlagTimestamp > 0
			? Math.round((now - this.lastFlagTimestamp) / 1000)
			: -1;
		this.lastFlagTimestamp = now;

		const payload: FlagTelemetryPayload = {
			event: "flag",
			installId: this.installId,
			version: getVersion(),
			ts: new Date().toISOString(),
			flag: data,
		};

		// Fire-and-forget
		void this.sendPayload(payload).catch(() => {
			// Telemetry failures must never terminate the proxy.
		});

		telemetryLogger.log("info",
			`Flag event reported: ${data.flagHttpStatus} [${data.flagPatternsMatched.join(",")}] model=${data.model}`,
		);
	}

	private buildPayload(event: TelemetryPayload["event"]): TelemetryPayload {
		const metrics = this.getMetrics();
		return {
			event,
			installId: this.installId,
			version: getVersion(),
			nodeVersion: process.version,
			os: process.platform,
			arch: process.arch,
			ts: new Date().toISOString(),
			...metrics,
			featuresUsed: getFeaturesSnapshot(),
		};
	}

	private async send(event: TelemetryPayload["event"]): Promise<void> {
		try {
			const payload = this.buildPayload(event);
			await this.sendPayload(payload);
			telemetryLogger.log("debug", `Telemetry ${event} sent`);
		} catch {
			// Fire-and-forget — never crash, never surface errors to user.
			// Telemetry failures must be completely invisible.
		}
	}

	private async sendPayload(payload: TelemetryPayload | FlagTelemetryPayload): Promise<void> {
		await fetch(TELEMETRY_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
	}

	// ── For testing ──────────────────────────────────────────────────
	/** Expose payload builder for tests (does NOT send) */
	_buildPayloadForTest(event: TelemetryPayload["event"]): TelemetryPayload {
		if (!this.installId) this.installId = getOrCreateInstallId();
		return this.buildPayload(event);
	}

	/** Expose flag payload builder for tests (does NOT send) */
	_buildFlagPayloadForTest(data: FlagEventData): FlagTelemetryPayload {
		if (!this.installId) this.installId = getOrCreateInstallId();
		return {
			event: "flag",
			installId: this.installId,
			version: getVersion(),
			ts: new Date().toISOString(),
			flag: data,
		};
	}
}
