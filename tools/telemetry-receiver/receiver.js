#!/usr/bin/env node

// ── Tuxevil Rotator — Telemetry Receiver ──────────────────────
//
// Minimal HTTP server that receives anonymous telemetry events
// and stores them as JSONL (one file per day).
//
// Zero dependencies — runs on Node.js 18+ with native http/fs.
//
// Usage:
//   PORT=3800 DATA_DIR=./data node receiver.js
//
// Endpoints:
//   POST /v1/events         — Receive a telemetry payload
//   GET  /v1/stats          — Aggregate stats (protected by STATS_TOKEN)
//   GET  /v1/public-stats   — Public aggregate stats for badges (no auth, 5-min cache)
//   GET  /stats              — Public aggregate stats page
//   GET  /v1/health         — Health check
//
// Environment:
//   PORT         — Listen port (default: 3800)
//   DATA_DIR     — JSONL storage directory (default: ./data)
//   STATS_TOKEN  — Bearer token to access /v1/stats (required for stats)

import { createServer } from "node:http";
import {
	appendFileSync,
	writeFileSync,
	mkdirSync,
	existsSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PORT || "3800", 10);
const DATA_DIR = process.env.DATA_DIR || "./data";
const STATS_TOKEN = process.env.STATS_TOKEN || "";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function isStatsAuthorized(req) {
	return STATS_TOKEN.length > 0 &&
		req.headers.authorization === "Bearer " + STATS_TOKEN;
}

function sendUnauthorized(res) {
	res.writeHead(401, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Unauthorized" }));
}

function requireStatsAuth(req, res) {
	if (!STATS_TOKEN) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "STATS_TOKEN not configured" }));
		return false;
	}
	if (!isStatsAuthorized(req)) {
		sendUnauthorized(res);
		return false;
	}
	return true;
}

// ── Notifications Storage ────────────────────────────────────────────
const NOTIFICATIONS_FILE = join(DATA_DIR, "notifications.json");

function loadNotifications() {
	try {
		if (existsSync(NOTIFICATIONS_FILE)) {
			return JSON.parse(readFileSync(NOTIFICATIONS_FILE, "utf-8"));
		}
	} catch { /* corrupted file, start fresh */ }
	return [];
}

function saveNotifications(notifications) {
	writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2), "utf-8");
}

const NOTIFICATION_TYPES = new Set(["info", "warning", "critical"]);
const MAX_NOTIFICATION_STRING_LEN = 2048;

function isOptionalNotificationString(value) {
	return value === undefined || value === null ||
		(typeof value === "string" && value.length <= MAX_NOTIFICATION_STRING_LEN);
}

function isSafeNotificationUrl(value) {
	if (value === undefined || value === null || value === "") return true;
	if (typeof value !== "string" || value.length > MAX_NOTIFICATION_STRING_LEN) return false;
	try {
		const parsed = new URL(value, "http://localhost");
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isValidNotificationInput(data) {
	if (typeof data !== "object" || data === null) return false;
	if (data.id !== undefined && (typeof data.id !== "string" || data.id.length > MAX_NOTIFICATION_STRING_LEN)) return false;
	if (typeof data.title !== "string" || data.title.length === 0 || data.title.length > MAX_NOTIFICATION_STRING_LEN) return false;
	if (typeof data.message !== "string" || data.message.length === 0 || data.message.length > MAX_NOTIFICATION_STRING_LEN) return false;
	if (data.type !== undefined && !NOTIFICATION_TYPES.has(data.type)) return false;
	if (!isOptionalNotificationString(data.createdAt)) return false;
	if (!isOptionalNotificationString(data.expiresAt)) return false;
	if (!isOptionalNotificationString(data.minVersion)) return false;
	if (!isOptionalNotificationString(data.maxVersion)) return false;
	if (!isSafeNotificationUrl(data.actionUrl)) return false;
	if (!isOptionalNotificationString(data.actionLabel)) return false;
	return true;
}

/**
 * Simple semver comparison: returns true if a < b.
 */
function semverLt(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const av = pa[i] ?? 0;
		const bv = pb[i] ?? 0;
		if (av < bv) return true;
		if (av > bv) return false;
	}
	return false;
}

function semverLte(a, b) {
	return a === b || semverLt(a, b);
}

/**
 * Filter notifications for a client with a given version.
 * Removes expired notifications and applies version targeting.
 */
function getActiveNotifications(clientVersion) {
	const all = loadNotifications();
	const now = new Date().toISOString();
	return all.filter((n) => {
		// Filter expired
		if (n.expiresAt && n.expiresAt < now) return false;
		// Version targeting
		if (clientVersion) {
			if (n.minVersion && semverLt(clientVersion, n.minVersion)) return false;
			if (n.maxVersion && !semverLte(clientVersion, n.maxVersion)) return false;
		}
		return true;
	}).map((n) => ({
		id: n.id,
		type: n.type || "info",
		title: n.title,
		message: n.message,
		createdAt: n.createdAt,
		actionUrl: n.actionUrl || null,
		actionLabel: n.actionLabel || null,
	}));
}

// ── Validation ───────────────────────────────────────────────────────
const ALLOWED_EVENTS = new Set(["boot", "heartbeat", "shutdown", "flag"]);
const MAX_BODY_BYTES = 4096;
const MAX_MODELS = 20;
const MAX_STRING_LEN = 128;

function isCorePayload(data) {
	if (typeof data !== "object" || data === null) return false;
	if (typeof data.installId !== "string" || data.installId.length > 64) return false;
	if (typeof data.version !== "string" || data.version.length > MAX_STRING_LEN) return false;
	if (typeof data.ts !== "string" || data.ts.length > 30) return false;

	return true;
}

function isHeartbeatPayload(data) {
	if (!isCorePayload(data)) return false;
	if (typeof data.nodeVersion !== "string" || data.nodeVersion.length > MAX_STRING_LEN) return false;
	if (typeof data.os !== "string" || data.os.length > MAX_STRING_LEN) return false;
	if (typeof data.arch !== "string" || data.arch.length > MAX_STRING_LEN) return false;
	if (typeof data.accountCount !== "number" || data.accountCount < 0 || data.accountCount > 1000) return false;
	if (!Array.isArray(data.modelsUsed) || data.modelsUsed.length > MAX_MODELS) return false;
	if (typeof data.totalRequests !== "number" || data.totalRequests < 0) return false;
	if (typeof data.uptimeSeconds !== "number" || data.uptimeSeconds < 0) return false;
	if (typeof data.routingHealthState !== "string" || data.routingHealthState.length > 30) return false;

	// Reject if any email-like string is detected anywhere
	const serialized = JSON.stringify(data);
	if (serialized.includes("@") && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]/.test(serialized)) {
		return false;
	}

	return true;
}

function isFlagPayload(data) {
	if (!isCorePayload(data)) return false;
	if (data.event !== "flag") return false;
	if (typeof data.flag !== "object" || data.flag === null) return false;
	const flag = data.flag;
	if (typeof flag.flagHttpStatus !== "number") return false;
	if (!Array.isArray(flag.flagPatternsMatched)) return false;
	if (typeof flag.model !== "string") return false;
	if (typeof flag.timerType !== "string") return false;
	if (typeof flag.accountQuotaPercent !== "number") return false;
	if (typeof flag.wasProAccount !== "boolean") return false;
	if (typeof flag.accountTotalRequests !== "number") return false;
	if (typeof flag.accountRequestsLastHour !== "number") return false;
	if (typeof flag.accountConcurrentAtFlag !== "number") return false;
	if (typeof flag.poolSize !== "number") return false;
	if (typeof flag.poolHealthyCount !== "number") return false;
	if (typeof flag.protectivePauseTriggered !== "boolean") return false;
	if (typeof flag.uptimeSeconds !== "number") return false;
	if (typeof flag.timeSinceLastFlagSeconds !== "number") return false;
	if (flag.flagReasonCode !== undefined &&
		(typeof flag.flagReasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(flag.flagReasonCode))) return false;
	if (flag.flagReasonMessage !== undefined && !isSafeFlagReasonMessage(flag.flagReasonMessage)) return false;

	const serialized = JSON.stringify(data);
	if (serialized.includes("@") && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]/.test(serialized)) {
		return false;
	}

	return true;
}

function isSafeFlagReasonMessage(message) {
	return typeof message === "string" && message.length > 0 && message.length <= 160 &&
		!/(?:https?:\/\/|@|bearer\s|access[_ -]?token|refresh[_ -]?token|api[_ -]?key)/i.test(message);
}

function isValidPayload(data) {
	if (typeof data !== "object" || data === null) return false;
	if (!ALLOWED_EVENTS.has(data.event)) return false;
	if (data.event === "flag") return isFlagPayload(data);
	return isHeartbeatPayload(data);
}

// ── Storage ──────────────────────────────────────────────────────────
function getDailyFile() {
	const date = new Date().toISOString().slice(0, 10);
	return join(DATA_DIR, `${date}.jsonl`);
}

function storeEvent(payload) {
	// Sanitize: keep only known fields
	const clean = {
		event: payload.event,
		installId: payload.installId,
		version: payload.version,
		nodeVersion: payload.nodeVersion,
		os: payload.os,
		arch: payload.arch,
		ts: payload.ts,
		receivedAt: new Date().toISOString(),
		accountCount: payload.accountCount,
		modelsUsed: payload.modelsUsed,
		totalRequests: payload.totalRequests,
		uptimeSeconds: payload.uptimeSeconds,
		routingHealthState: payload.routingHealthState,
		flaggedCount: payload.flaggedCount ?? 0,
		disabledCount: payload.disabledCount ?? 0,
		proCount: payload.proCount ?? 0,
		freeCount: payload.freeCount ?? 0,
		tokensByModel: sanitizeTokensByModel(payload.tokensByModel),
		featuresUsed: payload.featuresUsed ?? {},
	};

	appendFileSync(getDailyFile(), JSON.stringify(clean) + "\n", "utf-8");

	// Flag events also go to a dedicated file for easy analysis
	if (payload.event === "flag" && payload.flag) {
		const flagClean = {
			installId: payload.installId,
			version: payload.version,
			ts: payload.ts,
			receivedAt: new Date().toISOString(),
			...sanitizeFlagData(payload.flag),
		};
		const flagFile = getDailyFile().replace(".jsonl", "-flags.jsonl");
		appendFileSync(flagFile, JSON.stringify(flagClean) + "\n", "utf-8");
	}
}

function sanitizeFlagData(flag) {
	const ALLOWED_PATTERNS = new Set([
		"infring", "suspend", "abus", "terminat",
		"violat", "banned", "policy", "forbidden", "verif",
		"blocked_401",
	]);
	return {
		flagHttpStatus: typeof flag.flagHttpStatus === "number" ? flag.flagHttpStatus : 0,
		...(typeof flag.flagReasonCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(flag.flagReasonCode)
			? { flagReasonCode: flag.flagReasonCode } : {}),
		...(isSafeFlagReasonMessage(flag.flagReasonMessage)
			? { flagReasonMessage: flag.flagReasonMessage } : {}),
		flagPatternsMatched: Array.isArray(flag.flagPatternsMatched)
			? flag.flagPatternsMatched.filter((p) => ALLOWED_PATTERNS.has(p))
			: [],
		model: typeof flag.model === "string" ? flag.model.slice(0, 64) : "unknown",
		timerType: typeof flag.timerType === "string" ? flag.timerType.slice(0, 10) : "unknown",
		accountQuotaPercent: typeof flag.accountQuotaPercent === "number" ? flag.accountQuotaPercent : -1,
		wasProAccount: !!flag.wasProAccount,
		accountTotalRequests: typeof flag.accountTotalRequests === "number" ? flag.accountTotalRequests : 0,
		accountRequestsLastHour: typeof flag.accountRequestsLastHour === "number" ? flag.accountRequestsLastHour : 0,
		accountConcurrentAtFlag: typeof flag.accountConcurrentAtFlag === "number" ? flag.accountConcurrentAtFlag : 0,
		poolSize: typeof flag.poolSize === "number" ? flag.poolSize : 0,
		poolHealthyCount: typeof flag.poolHealthyCount === "number" ? flag.poolHealthyCount : 0,
		protectivePauseTriggered: !!flag.protectivePauseTriggered,
		uptimeSeconds: typeof flag.uptimeSeconds === "number" ? flag.uptimeSeconds : 0,
		timeSinceLastFlagSeconds: typeof flag.timeSinceLastFlagSeconds === "number" ? flag.timeSinceLastFlagSeconds : -1,
	};
}

function sanitizeTokensByModel(raw) {
	if (typeof raw !== "object" || raw === null) return {};
	const MAX_MODELS = 20;
	const clean = Object.create(null);
	let count = 0;
	for (const [model, data] of Object.entries(raw)) {
		if (count >= MAX_MODELS) break;
		if (typeof model !== "string" || model.length > 64) continue;
		if (typeof data !== "object" || data === null) continue;
		clean[model] = {
			input: typeof data.input === "number" && data.input >= 0 ? data.input : 0,
			output: typeof data.output === "number" && data.output >= 0 ? data.output : 0,
			requests: typeof data.requests === "number" && data.requests >= 0 ? data.requests : 0,
		};
		count++;
	}
	return clean;
}

// Pricing per 1M tokens (USD) — mirrors MODEL_PRICING in the rotator
const MODEL_PRICING = {
	"claude-opus-4-6-thinking": { inputPer1M: 5.0, outputPer1M: 25.0 },
	"claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
	"claude-opus-5-5": { inputPer1M: 4.0, outputPer1M: 20.0, cachingPer1M: 0.2 },
	"claude-sonnet-5-5": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-3.1-pro": { inputPer1M: 2.0, outputPer1M: 12.0 },
	"gemini-3.1-pro-low": { inputPer1M: 2.0, outputPer1M: 12.0 },
	"gemini-3.1-pro-high": { inputPer1M: 2.0, outputPer1M: 12.0 },
	"gemini-3-flash": { inputPer1M: 0.5, outputPer1M: 3.0 },
	"gemini-3.6-flash": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.6-flash-high": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.6-flash-medium": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.6-flash-low": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.6-flash-tiered": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	// Gemini introductory pricing: see docs/model-pricing.md (2026-11-23).
	"gemini-3.7-flash-tiered": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	// Gemini 3.8 Flash uses the same introductory window and doubles on 2027-01-01.
	"gemini-3.8-flash": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.8-flash-tiered": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.8-flash-low": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.8-flash-medium": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-3.8-flash-high": { inputPer1M: 0.75, outputPer1M: 3.75, cachingPer1M: 0.075, cachingStoragePer1MPerHour: 0.5 },
	"gemini-4-carbon": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-4-argon": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-4-argon-disabled": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-4-argon-low": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-4-argon-medium": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-4-argon-high": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gemini-4-neon": { inputPer1M: 3.0, outputPer1M: 15.0, cachingPer1M: 0.15 },
	"gemini-4-neon-low": { inputPer1M: 3.0, outputPer1M: 15.0, cachingPer1M: 0.15 },
	"gemini-4-neon-medium": { inputPer1M: 3.0, outputPer1M: 15.0, cachingPer1M: 0.15 },
	"gemini-4-neon-high": { inputPer1M: 3.0, outputPer1M: 15.0, cachingPer1M: 0.15 },
	"gemini-4-neon-xhigh": { inputPer1M: 3.0, outputPer1M: 15.0, cachingPer1M: 0.15 },
	"gemini-4-hydrogen": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gemini-4-hydrogen-low": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gemini-4-hydrogen-medium": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gemini-4-hydrogen-high": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gemini-4-hydrogen-xhigh": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gemini-4-hydrogen-tiered": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gemini-4-hydrogen-sonar": { inputPer1M: 1.5, outputPer1M: 7.5, cachingPer1M: 0.075 },
	"gpt-oss-120b-medium": { inputPer1M: 2.0, outputPer1M: 10.0 },

	// Ollama Cloud standard-price models — mirrors MODEL_PRICING in src/types.ts
	"beam": { inputPer1M: 0.125, outputPer1M: 0.40, cachingPer1M: 0.015 },
	"gpt-oss:20b": { inputPer1M: 0.07, outputPer1M: 0.30, cachingPer1M: 0.035 },
	"gpt-oss:120b": { inputPer1M: 0.15, outputPer1M: 0.60, cachingPer1M: 0.014 },
	"deepseek-v4-flash:preview":   { inputPer1M: 0.14,  outputPer1M: 0.28 },
	"deepseek-v4-flash:0731": { inputPer1M: 0.14, outputPer1M: 0.28, cachingPer1M: 0.0028 },
	"deepseek-v4.1-flash": { inputPer1M: 0.30, outputPer1M: 1.20, cachingPer1M: 0.006 },
	"deepseek-v4.1-flash:1017": { inputPer1M: 0.30, outputPer1M: 1.20, cachingPer1M: 0.006 },
	"deepseek-v4-pro": { inputPer1M: 1.32, outputPer1M: 3.96, cachingPer1M: 0.044 },
	"deepseek-v4-pro:0813": { inputPer1M: 1.74, outputPer1M: 3.48 },
	"qwen3.5:397b": { inputPer1M: 0.60, outputPer1M: 3.60 },
	"glm-5.1": { inputPer1M: 0.80, outputPer1M: 2.56 },
	"glm-5.2": { inputPer1M: 1.40, outputPer1M: 4.40, cachingPer1M: 0.26 },
	"glm-5.3": { inputPer1M: 1.40, outputPer1M: 4.40, cachingPer1M: 0.26 },
	"glm-5.3-flash": { inputPer1M: 0.15, outputPer1M: 0.50, cachingPer1M: 0.03 },
	"gemma4": { inputPer1M: 0.14, outputPer1M: 0.40, cachingPer1M: 0.05 },
	"gemma4:31b": { inputPer1M: 0.14, outputPer1M: 0.40, cachingPer1M: 0.05 },
	"hy4": { inputPer1M: 0.834, outputPer1M: 2.501, cachingPer1M: 0.042 },
	"inkling-2-small": { inputPer1M: 0.30, outputPer1M: 1.00, cachingPer1M: 0.03 },
	"kimi-k2.6": { inputPer1M: 0.95, outputPer1M: 4.00, cachingPer1M: 0.16 },
	"kimi-k2.7-code": { inputPer1M: 0.95, outputPer1M: 4.00, cachingPer1M: 0.19 },
	"kimi-k3": { inputPer1M: 3.00, outputPer1M: 15.00, cachingPer1M: 0.30 },
	"kimi-k3.1-pro": { inputPer1M: 2.00, outputPer1M: 10.00, cachingPer1M: 0.20 },
	"mimo-v2.6-flash": { inputPer1M: 0.14, outputPer1M: 0.28, cachingPer1M: 0.0028 },
	"mimo-v2.6-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cachingPer1M: 0.0036 },
	"minimax-m2.7": { inputPer1M: 0.30, outputPer1M: 1.20, cachingPer1M: 0.06 },
	"minimax-m3": { inputPer1M: 0.60, outputPer1M: 2.40, cachingPer1M: 0.12 },
	"minimax-m3.1-flash": { inputPer1M: 0.15, outputPer1M: 0.60, cachingPer1M: 0.015 },
	"mistral-large-4": { inputPer1M: 0.70, outputPer1M: 2.10, cachingPer1M: 0.07 },
	"mistral-large-3": { inputPer1M: 0.50, outputPer1M: 1.50 },
	"mistral-large-3:675b": { inputPer1M: 0.50, outputPer1M: 1.50 },
	"muse-spark-open": { inputPer1M: 1.25, outputPer1M: 4.25, cachingPer1M: 0.15 },
	"nemotron-3-nano": { inputPer1M: 0.06, outputPer1M: 0.24 },
	"nemotron-3-nano:30b": { inputPer1M: 0.06, outputPer1M: 0.24 },
	"nemotron-3-super": { inputPer1M: 0.015, outputPer1M: 0.60, cachingPer1M: 0.015 },
	"nemotron-3-ultra": { inputPer1M: 0.10, outputPer1M: 3.00, cachingPer1M: 0.10 },

	// OpenCode Zen free models — mirrors MODEL_PRICING in src/types.ts
	"big-pickle": { inputPer1M: 0.00, outputPer1M: 0.00 },
	"mimo-v2.5-free": { inputPer1M: 0.00, outputPer1M: 0.00 },
	"ling-3.0-flash-fin-free": { inputPer1M: 0.00, outputPer1M: 0.00 },
	"nemotron-3-ultra-free": { inputPer1M: 0.00, outputPer1M: 0.00 },
	"nemotron-3.5-lightning-free": { inputPer1M: 0.00, outputPer1M: 0.00 },
	"muse-spark-1.3-contributor-free": { inputPer1M: 0.00, outputPer1M: 0.00 },
	"ling-3.0-tiny-free":          { inputPer1M: 0.05,  outputPer1M: 0.20 },
	"laguna-s-2.1-free":           { inputPer1M: 0.20,  outputPer1M: 0.80 },

	// OpenAI Codex models — mirrors MODEL_PRICING in src/types.ts
	"gpt-6.2-astra": { inputPer1M: 8.0, outputPer1M: 40.0, cachingPer1M: 0.4 },
	"gpt-6.2-sol": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gpt-6.1-sol": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.1 },
	"gpt-6.1-terra": { inputPer1M: 1.0, outputPer1M: 5.0, cachingPer1M: 0.05 },
	"gpt-6-astra": { inputPer1M: 10.0, outputPer1M: 50.0, cachingPer1M: 1.0 },
	"gpt-6-sol": { inputPer1M: 2.0, outputPer1M: 10.0, cachingPer1M: 0.2 },
	"gpt-6-luna": { inputPer1M: 0.1, outputPer1M: 0.5, cachingPer1M: 0.01 },
	"gpt-5.6-sol": { inputPer1M: 4.0, outputPer1M: 20.0, cachingPer1M: 0.40 },
	"gpt-5.6-terra": { inputPer1M: 2.0, outputPer1M: 12.0, cachingPer1M: 0.20 },
	"gpt-5.6-luna": { inputPer1M: 0.20, outputPer1M: 1.20, cachingPer1M: 0.02 },
};

function getModelPricing(model) {
	if (MODEL_PRICING[model]) return MODEL_PRICING[model];
	const lower = (model || "").toLowerCase();
	if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];
	if (lower.includes("opus")) {
		if (lower.includes("5-5") || lower.includes("5.5")) return MODEL_PRICING["claude-opus-5-5"];
		return MODEL_PRICING["claude-opus-4-6-thinking"];
	}
	if (lower.includes("sonnet")) {
		if (lower.includes("5-5") || lower.includes("5.5")) return MODEL_PRICING["claude-sonnet-5-5"];
		return MODEL_PRICING["claude-sonnet-4-6"];
	}
	if (lower.includes("4-carbon") || lower.includes("4.0-carbon")) return MODEL_PRICING["gemini-4-carbon"];
	if (lower.includes("4-argon") || lower.includes("4.0-argon")) return MODEL_PRICING["gemini-4-argon"];
	if (lower.includes("4-neon") || lower.includes("4.0-neon")) return MODEL_PRICING["gemini-4-neon"];
	if (lower.includes("4-hydrogen") || lower.includes("4.0-hydrogen")) return MODEL_PRICING["gemini-4-hydrogen"];
	if (lower.includes("3.8-flash")) return MODEL_PRICING["gemini-3.8-flash-high"];
	if (lower.includes("3.7-flash")) return MODEL_PRICING["gemini-3.7-flash-tiered"];
	if (lower.includes("3.6-flash")) return MODEL_PRICING["gemini-3.6-flash-high"];
	if (lower.includes("flash")) return MODEL_PRICING["gemini-3-flash"];
	if (lower.includes("pro")) return MODEL_PRICING["gemini-3.1-pro"];
	return null;
}

function calculateSavings(tokensByModel) {
	let totalUsd = 0;
	const byModel = Object.create(null);
	for (const [model, data] of Object.entries(tokensByModel)) {
		const pricing = getModelPricing(model);
		if (!pricing) continue;
		const inputUsd = (data.input / 1_000_000) * pricing.inputPer1M;
		const outputUsd = (data.output / 1_000_000) * pricing.outputPer1M;
		byModel[model] = { inputUsd: Math.round(inputUsd * 100) / 100, outputUsd: Math.round(outputUsd * 100) / 100, totalUsd: Math.round((inputUsd + outputUsd) * 100) / 100 };
		totalUsd += inputUsd + outputUsd;
	}
	return { totalUsd: Math.round(totalUsd * 100) / 100, byModel };
}

// ── Stats ────────────────────────────────────────────────────────────
// ── Stats filtering ───────────────────────────────────────────────────
function parseQueryString(url) {
	const idx = url.indexOf("?");
	if (idx === -1) return {};
	const params = Object.create(null);
	for (const part of url.slice(idx + 1).split("&")) {
		const separator = part.indexOf("=");
		const rawKey = separator === -1 ? part : part.slice(0, separator);
		const rawValue = separator === -1 ? "" : part.slice(separator + 1);
		try {
			const k = decodeURIComponent(rawKey);
			if (k) params[k] = decodeURIComponent(rawValue);
		} catch {
			// Ignore malformed query components.
		}
	}
	return params;
}

// Collect all raw events + flag events from JSONL files
function loadAllEvents() {
	const allFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith(".jsonl") && !f.endsWith("-flags.jsonl")).sort();
	const flagFiles = readdirSync(DATA_DIR).filter((f) => f.endsWith("-flags.jsonl")).sort();
	const events = [];
	const flagEvents = [];
	for (const file of allFiles) {
		const lines = readFileSync(join(DATA_DIR, file), "utf-8").split("\n").filter(Boolean);
		for (const line of lines) {
			try { events.push({ file, ev: JSON.parse(line) }); } catch { /* skip */ }
		}
	}
	for (const file of flagFiles) {
		const lines = readFileSync(join(DATA_DIR, file), "utf-8").split("\n").filter(Boolean);
		for (const line of lines) {
			try { flagEvents.push({ file, fl: JSON.parse(line) }); } catch { /* skip */ }
		}
	}
	return { events, flagEvents, allFiles, flagFiles };
}

// Extract filter options from all events (unfiltered, for populating dropdowns)
function buildFilterOptions(events, flagEvents) {
	const installIds = new Set();
	const versions = new Set();
	const osList = new Set();
	const models = new Set();
	const dates = new Set();
	for (const { ev, file } of events) {
		if (ev.installId) installIds.add(ev.installId);
		if (ev.version) versions.add(ev.version);
		if (ev.os) osList.add(ev.os);
		for (const m of ev.modelsUsed || []) models.add(m);
		const date = file.replace(".jsonl", "");
		if (date) dates.add(date);
	}
	return {
		installIds: [...installIds].sort(),
		versions: [...versions].sort(),
		os: [...osList].sort(),
		models: [...models].sort(),
		dateRange: { from: [...dates].sort()[0] ?? null, to: [...dates].sort().at(-1) ?? null },
	};
}


// ── Per-install list ─────────────────────────────────────────────────
// Returns one summary row per unique installId based on their latest
// heartbeat/boot event + flag count over the same filtered window.
function computeInstallList(filters = {}) {
	const { events: allEvents, flagEvents: allFlagEvents } = loadAllEvents();

	// Apply same filters as computeStats
	const events = allEvents.filter(({ ev, file }) => {
		if (filters.installId && ev.installId !== filters.installId) return false;
		if (filters.version   && ev.version   !== filters.version)   return false;
		if (filters.os        && ev.os        !== filters.os)        return false;
		if (filters.model     && !(ev.modelsUsed || []).includes(filters.model)) return false;
		const date = file.replace('.jsonl', '');
		if (filters.from && date < filters.from) return false;
		if (filters.to   && date > filters.to)   return false;
		return true;
	});

	const flagEvents = allFlagEvents.filter(({ fl, file }) => {
		if (filters.installId && fl.installId !== filters.installId) return false;
		const date = file.replace('-flags.jsonl', '');
		if (filters.from && date < filters.from) return false;
		if (filters.to   && date > filters.to)   return false;
		return true;
	});

	// Latest heartbeat snapshot per install
	const latest = Object.create(null); // installId -> ev
	for (const { ev } of events) {
		const prev = latest[ev.installId];
		if (!prev || ev.ts >= prev.ts) latest[ev.installId] = ev;
	}

	// First seen per install
	const firstSeen = Object.create(null);
	for (const { ev } of events) {
		if (!firstSeen[ev.installId] || ev.ts < firstSeen[ev.installId])
			firstSeen[ev.installId] = ev.ts;
	}

	// Flag counts per install
	const flagsByInstall = Object.create(null);
	for (const { fl } of flagEvents) {
		flagsByInstall[fl.installId] = (flagsByInstall[fl.installId] || 0) + 1;
	}

	// Total requests per install (max across all events — it's cumulative)
	const maxRequests = Object.create(null);
	for (const { ev } of events) {
		const cur = maxRequests[ev.installId] || 0;
		if ((ev.totalRequests || 0) > cur) maxRequests[ev.installId] = ev.totalRequests || 0;
	}

	const list = Object.values(latest).map((ev) => {
		const tokens = ev.tokensByModel && typeof ev.tokensByModel === 'object'
			? ev.tokensByModel : {};
		const savings = calculateSavings(tokens);
		return {
			installId:          ev.installId,
			version:            ev.version || '?',
			os:                 ev.os || '?',
			arch:               ev.arch || '?',
			accountCount:       ev.accountCount || 0,
			totalRequests:      maxRequests[ev.installId] || 0,
			routingHealthState: ev.routingHealthState || 'unknown',
			flaggedCount:       ev.flaggedCount || 0,
			disabledCount:      ev.disabledCount || 0,
			proCount:           ev.proCount || 0,
			freeCount:          ev.freeCount || 0,
			tokensByModel:      tokens,
			savingsUsd:         savings.totalUsd,
			flagEvents:         flagsByInstall[ev.installId] || 0,
			lastSeen:           ev.ts,
			firstSeen:          firstSeen[ev.installId] || ev.ts,
			featuresUsed:       ev.featuresUsed || {},
		};
	});

	// Sort by totalRequests desc by default
	list.sort((a, b) => b.totalRequests - a.totalRequests);
	return list;
}

function computeStats(filters = {}) {
	const { events: allEvents, flagEvents: allFlagEvents, allFiles } = loadAllEvents();

	// Apply filters to main events
	const events = allEvents.filter(({ ev, file }) => {
		if (filters.installId && ev.installId !== filters.installId) return false;
		if (filters.version && ev.version !== filters.version) return false;
		if (filters.os && ev.os !== filters.os) return false;
		if (filters.model && !(ev.modelsUsed || []).includes(filters.model)) return false;
		const date = file.replace(".jsonl", "");
		if (filters.from && date < filters.from) return false;
		if (filters.to && date > filters.to) return false;
		return true;
	});

	// Apply filters to flag events (by installId, date)
	const flagEvents = allFlagEvents.filter(({ fl, file }) => {
		if (filters.installId && fl.installId !== filters.installId) return false;
		if (filters.model && fl.model !== filters.model) return false;
		const date = file.replace("-flags.jsonl", "");
		if (filters.from && date < filters.from) return false;
		if (filters.to && date > filters.to) return false;
		return true;
	});

	const uniqueInstalls = new Set();
	let totalEvents = 0;
	let totalBoots = 0;
	let totalFlags = 0;
	const versionCounts = Object.create(null);
	const osCounts = Object.create(null);
	const archCounts = Object.create(null);
	const modelCounts = Object.create(null);
	const healthCounts = Object.create(null);
	let totalAccounts = 0;
	let totalRequests = 0;
	let featuresCount = { dashboard: 0, proAdvisor: 0, freshWindowToggle: 0, hostedLogin: 0 };

	// tokensByModel is CUMULATIVE per install (each heartbeat sends total-since-boot).
	// To avoid multi-counting, track the LATEST snapshot per installId and sum those.
	const latestTokenSnapshotByInstall = Object.create(null); // installId → { ts, tokensByModel }
	const latestEventByInstall = Object.create(null); // installId → ev
	const dailyMap = Object.create(null); // YYYY-MM-DD → { date, events, installs: Set, boots, flags }

	function ensureDay(date) {
		if (!dailyMap[date]) {
			dailyMap[date] = { date, events: 0, installs: new Set(), boots: 0, flags: 0 };
		}
		return dailyMap[date];
	}

	for (const { ev, file } of events) {
		totalEvents++;
		uniqueInstalls.add(ev.installId);
		if (ev.event === "boot") totalBoots++;
		if (ev.event === "flag") totalFlags++;
		versionCounts[ev.version] = (versionCounts[ev.version] || 0) + 1;
		osCounts[ev.os] = (osCounts[ev.os] || 0) + 1;
		archCounts[ev.arch] = (archCounts[ev.arch] || 0) + 1;
		healthCounts[ev.routingHealthState] = (healthCounts[ev.routingHealthState] || 0) + 1;
		totalAccounts += ev.accountCount || 0;
		totalRequests += ev.totalRequests || 0;

		const day = ensureDay(file.replace(".jsonl", ""));
		day.events++;
		if (ev.installId) day.installs.add(ev.installId);
		if (ev.event === "boot") day.boots++;
		if (ev.event === "flag") day.flags++;

		const prevEv = latestEventByInstall[ev.installId];
		if (!prevEv || (ev.ts || "") >= (prevEv.ts || "")) {
			latestEventByInstall[ev.installId] = ev;
		}

		// Keep only the most recent token snapshot per install
		if (ev.tokensByModel && typeof ev.tokensByModel === "object") {
			const prev = latestTokenSnapshotByInstall[ev.installId];
			if (!prev || ev.ts >= prev.ts) {
				latestTokenSnapshotByInstall[ev.installId] = { ts: ev.ts, tokensByModel: ev.tokensByModel };
			}
		}
		for (const m of ev.modelsUsed || []) modelCounts[m] = (modelCounts[m] || 0) + 1;
		if (ev.featuresUsed) {
			for (const [k, v] of Object.entries(ev.featuresUsed)) {
				if (v && k in featuresCount) featuresCount[k]++;
			}
		}
	}

	// Fleet summary from latest snapshot per unique install
	const nowMs = Date.now();
	const DAY_MS = 24 * 60 * 60 * 1000;
	const fleet = {
		active24h: 0,
		active7d: 0,
		totalAccounts: 0,
		proAccounts: 0,
		freeAccounts: 0,
		flaggedAccounts: 0,
		disabledAccounts: 0,
		healthByInstall: Object.create(null),
		osByInstall: Object.create(null),
		versionByInstall: Object.create(null),
	};
	for (const ev of Object.values(latestEventByInstall)) {
		const tsMs = Date.parse(ev.ts || ev.receivedAt || "");
		if (Number.isFinite(tsMs)) {
			if (nowMs - tsMs <= DAY_MS) fleet.active24h++;
			if (nowMs - tsMs <= 7 * DAY_MS) fleet.active7d++;
		}
		fleet.totalAccounts += ev.accountCount || 0;
		fleet.proAccounts += ev.proCount || 0;
		fleet.freeAccounts += ev.freeCount || 0;
		fleet.flaggedAccounts += ev.flaggedCount || 0;
		fleet.disabledAccounts += ev.disabledCount || 0;
		const health = ev.routingHealthState || "unknown";
		fleet.healthByInstall[health] = (fleet.healthByInstall[health] || 0) + 1;
		const osKey = ev.os || "unknown";
		fleet.osByInstall[osKey] = (fleet.osByInstall[osKey] || 0) + 1;
		const verKey = ev.version || "unknown";
		fleet.versionByInstall[verKey] = (fleet.versionByInstall[verKey] || 0) + 1;
	}

	// Aggregate latest token snapshot per install into global totals
	const globalTokensByModel = Object.create(null);
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalTokenRequests = 0;
	for (const { tokensByModel } of Object.values(latestTokenSnapshotByInstall)) {
		for (const [model, data] of Object.entries(tokensByModel)) {
			if (!globalTokensByModel[model]) globalTokensByModel[model] = { input: 0, output: 0, requests: 0 };
			globalTokensByModel[model].input += data.input || 0;
			globalTokensByModel[model].output += data.output || 0;
			globalTokensByModel[model].requests += data.requests || 0;
			totalInputTokens += data.input || 0;
			totalOutputTokens += data.output || 0;
			totalTokenRequests += data.requests || 0;
		}
	}

	// Flag aggregates
	const flagsByStatus = Object.create(null);
	const flagsByReasonCode = Object.create(null);
	const flagsByPattern = Object.create(null);
	const flagsByModel = Object.create(null);
	const flagsByTimerType = Object.create(null);
	let flagsOnProAccounts = 0;
	let flagsOnFreeAccounts = 0;
	let flagRequestsTotal = 0;
	let flagCount = 0;
	const uniqueFlagSignatures = new Set();

	for (const { fl, file } of flagEvents) {
		flagCount++;
		const day = ensureDay(file.replace("-flags.jsonl", ""));
		day.flags++;
		flagsByStatus[fl.flagHttpStatus] = (flagsByStatus[fl.flagHttpStatus] || 0) + 1;
		const reasonCode = fl.flagReasonCode || "UNKNOWN";
		flagsByReasonCode[reasonCode] = (flagsByReasonCode[reasonCode] || 0) + 1;
		for (const p of fl.flagPatternsMatched || []) flagsByPattern[p] = (flagsByPattern[p] || 0) + 1;
		if (fl.model) flagsByModel[fl.model] = (flagsByModel[fl.model] || 0) + 1;
		if (fl.timerType) flagsByTimerType[fl.timerType] = (flagsByTimerType[fl.timerType] || 0) + 1;
		if (fl.wasProAccount) flagsOnProAccounts++;
		else flagsOnFreeAccounts++;
		flagRequestsTotal += fl.accountTotalRequests || 0;
		const signature = JSON.stringify({
			status: fl.flagHttpStatus,
			reasonCode: fl.flagReasonCode || "",
			patterns: [...(fl.flagPatternsMatched || [])].sort(),
			model: fl.model || "",
			timerType: fl.timerType || "",
			quota: fl.accountQuotaPercent,
			pro: !!fl.wasProAccount,
			pause: !!fl.protectivePauseTriggered,
		});
		uniqueFlagSignatures.add(signature);
	}

	const avgRequestsBeforeFlag = flagCount > 0 ? Math.round(flagRequestsTotal / flagCount) : 0;
	const uniqueFlagIncidents = uniqueFlagSignatures.size;
	const recentIncidents = flagEvents
		.map(({ fl }) => ({
			installId: fl.installId,
			version: fl.version || "?",
			ts: fl.ts,
			receivedAt: fl.receivedAt,
			flagHttpStatus: fl.flagHttpStatus,
			flagReasonCode: fl.flagReasonCode || "UNKNOWN",
			flagReasonMessage: fl.flagReasonMessage || "",
			flagPatternsMatched: fl.flagPatternsMatched || [],
			model: fl.model || "unknown",
			timerType: fl.timerType || "unknown",
			accountQuotaPercent: fl.accountQuotaPercent ?? -1,
			wasProAccount: !!fl.wasProAccount,
			accountTotalRequests: fl.accountTotalRequests ?? 0,
			accountRequestsLastHour: fl.accountRequestsLastHour ?? 0,
			accountConcurrentAtFlag: fl.accountConcurrentAtFlag ?? 0,
			poolSize: fl.poolSize ?? 0,
			poolHealthyCount: fl.poolHealthyCount ?? 0,
			protectivePauseTriggered: !!fl.protectivePauseTriggered,
			uptimeSeconds: fl.uptimeSeconds ?? 0,
			timeSinceLastFlagSeconds: fl.timeSinceLastFlagSeconds ?? -1,
		}))
		.sort((a, b) => String(b.receivedAt || b.ts).localeCompare(String(a.receivedAt || a.ts)))
		.slice(0, 50);

	const daily = Object.values(dailyMap)
		.sort((a, b) => a.date.localeCompare(b.date))
		.map((d) => ({
			date: d.date,
			events: d.events,
			installs: d.installs.size,
			boots: d.boots,
			flags: d.flags,
		}));

	// Build filter options from ALL events (unfiltered) for dropdown population
	const filterOptions = buildFilterOptions(allEvents, allFlagEvents);

	return {
		filters: { ...filters },
		filterOptions,
		period: {
			from: allFiles[0]?.replace(".jsonl", "") ?? null,
			to: allFiles[allFiles.length - 1]?.replace(".jsonl", "") ?? null,
		},
		uniqueInstalls: uniqueInstalls.size,
		totalEvents,
		totalBoots,
		avgAccountsPerEvent: totalEvents > 0 ? Math.round(totalAccounts / totalEvents * 10) / 10 : 0,
		totalRequestsAcrossAll: totalRequests,
		fleet,
		daily,
		tokens: {
			totalInput: totalInputTokens,
			totalOutput: totalOutputTokens,
			totalRequests: totalTokenRequests,
		},
		tokensByModel: globalTokensByModel,
		savings: calculateSavings(globalTokensByModel),
		versions: versionCounts,
		os: osCounts,
		arch: archCounts,
		modelsUsed: modelCounts,
		routingHealth: healthCounts,
		featuresUsed: featuresCount,
		flags: {
			totalFlags: totalFlags + flagCount,
			uniqueIncidents: uniqueFlagIncidents,
			byHttpStatus: flagsByStatus,
			byReasonCode: flagsByReasonCode,
			recentIncidents,
			byPattern: flagsByPattern,
			byModel: flagsByModel,
			byTimerType: flagsByTimerType,
			onProAccounts: flagsOnProAccounts,
			onFreeAccounts: flagsOnFreeAccounts,
			avgRequestsBeforeFlag,
		},
	};
}

// ── Public stats cache (5-minute TTL, no auth required) ──────────────
let publicStatsCache = null;
let publicStatsCacheTs = 0;
const PUBLIC_STATS_TTL_MS = 5 * 60 * 1000; // 5 minutes

function formatLargeNumber(n) {
	if (n >= 1_000_000_000) return `${Math.floor(n / 1_000_000_000 * 10) / 10}B`;
	if (n >= 1_000_000) return `${Math.floor(n / 1_000_000 * 10) / 10}M`;
	if (n >= 1_000) return `${Math.floor(n / 1_000 * 10) / 10}K`;
	return String(n);
}

function getPublicStats() {
	const now = Date.now();
	if (publicStatsCache && now - publicStatsCacheTs < PUBLIC_STATS_TTL_MS) {
		return publicStatsCache;
	}
	try {
		const stats = computeStats({});
		const savingsTotal = stats.savings?.totalUsd ?? 0;
		const requests = stats.totalRequestsAcrossAll ?? 0;
		const installs = stats.uniqueInstalls ?? 0;

		// Aggregate total input/output tokens across all models
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		for (const data of Object.values(stats.tokensByModel ?? {})) {
			totalInputTokens += data.input || 0;
			totalOutputTokens += data.output || 0;
		}
		const totalTokens = totalInputTokens + totalOutputTokens;

		const modelEntries = Object.entries(stats.tokensByModel ?? {})
			.map(([model, data]) => {
				const input = data.input || 0;
				const output = data.output || 0;
				const total = input + output;
				return {
					model,
					input,
					output,
					total,
					requests: data.requests || 0,
					savingsUsd: stats.savings?.byModel?.[model]?.totalUsd ?? 0,
					sharePct: totalTokens > 0 ? Math.round((total / totalTokens) * 1000) / 10 : 0,
				};
			})
			.sort((a, b) => b.total - a.total);

		const dailyTrend = (stats.daily || []).slice(-14).map((d) => ({
			date: d.date,
			installs: d.installs,
			events: d.events,
		}));

		publicStatsCache = {
			installs,
			installsFormatted: formatLargeNumber(installs),
			requests,
			requestsFormatted: formatLargeNumber(requests),
			savingsUsd: savingsTotal,
			savingsFormatted: `$${formatLargeNumber(Math.round(savingsTotal))}`,
			tokensInput: totalInputTokens,
			tokensInputFormatted: formatLargeNumber(totalInputTokens),
			tokensOutput: totalOutputTokens,
			tokensOutputFormatted: formatLargeNumber(totalOutputTokens),
			totalTokens,
			totalTokensFormatted: formatLargeNumber(totalTokens),
			activeInstalls24h: stats.fleet?.active24h ?? 0,
			activeInstalls7d: stats.fleet?.active7d ?? 0,
			modelsTracked: modelEntries.length,
			catalogModels: Object.keys(MODEL_PRICING).length,
			topModels: modelEntries.slice(0, 8),
			osDistribution: stats.fleet?.osByInstall ?? {},
			dailyTrend,
			period: stats.period ?? { from: null, to: null },
			updatedAt: new Date().toISOString(),
		};
		publicStatsCacheTs = now;
	} catch {
		// Return last cache or zeros on failure
		if (!publicStatsCache) {
			publicStatsCache = {
				installs: 0, installsFormatted: "0",
				requests: 0, requestsFormatted: "0",
				savingsUsd: 0, savingsFormatted: "$0",
				tokensInput: 0, tokensInputFormatted: "0",
				tokensOutput: 0, tokensOutputFormatted: "0",
				totalTokens: 0, totalTokensFormatted: "0",
				activeInstalls24h: 0, activeInstalls7d: 0,
				modelsTracked: 0, catalogModels: Object.keys(MODEL_PRICING).length,
				topModels: [], osDistribution: {}, dailyTrend: [],
				period: { from: null, to: null },
				updatedAt: new Date().toISOString(),
			};
		}
	}
	return publicStatsCache;
}

// ── Shared Cyberpunk / Retro-Console CSS ─────────────────────────────
function buildSharedCyberCss() {
	return `
:root{
  color-scheme:dark;
  --bg:#05080d;
  --bg-2:#080d15;
  --panel:#0a111c;
  --panel-2:#0f1928;
  --panel-3:#152338;
  --line:#1b2d44;
  --line-hi:#2c4a6e;
  --text:#e6f1ff;
  --text-2:#9fb8d4;
  --muted:#6d88a6;
  --cyan:#00f0ff;
  --cyan-dim:rgba(0,240,255,.12);
  --green:#39ff9c;
  --green-dim:rgba(57,255,156,.12);
  --amber:#ffb800;
  --amber-dim:rgba(255,184,0,.12);
  --red:#ff3b6b;
  --red-dim:rgba(255,59,107,.13);
  --violet:#b26bff;
  --violet-dim:rgba(178,107,255,.13);
  --mono:'JetBrains Mono','Cascadia Mono','SF Mono',ui-monospace,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --radius:6px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{font-size:14px;scroll-behavior:smooth}
body{
  font-family:var(--sans);
  font-size:14px;
  line-height:1.5;
  background:var(--bg);
  color:var(--text);
  min-height:100vh;
  overflow-x:hidden;
  position:relative;
  background-image:
    radial-gradient(ellipse 80% 45% at 50% -10%, rgba(0,240,255,.09), transparent 65%),
    linear-gradient(rgba(0,240,255,.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0,240,255,.028) 1px, transparent 1px);
  background-size:100% 100%, 32px 32px, 32px 32px;
}
body::after{
  content:'';
  position:fixed;
  inset:0;
  pointer-events:none;
  z-index:9999;
  background:repeating-linear-gradient(0deg, rgba(0,0,0,.09) 0px, rgba(0,0,0,.09) 1px, transparent 1px, transparent 3px);
  opacity:.42;
}
@media (prefers-reduced-motion:reduce){
  body::after{display:none}
  *{animation:none!important;transition:none!important}
}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--line-hi);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--cyan)}
a{color:var(--cyan);text-decoration:none}
a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;background:none;border:0}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--cyan);
  outline-offset:2px;
}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.kbd{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:22px;height:22px;padding:0 6px;
  font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--cyan);background:rgba(0,240,255,.07);
  border:1px solid rgba(0,240,255,.28);border-radius:4px;
}

/* ── Topbar ── */
.topbar{
  position:sticky;top:0;z-index:100;
  background:rgba(5,8,13,.88);
  backdrop-filter:blur(12px);
  border-bottom:1px solid var(--line);
}
.topbar::after{
  content:'';display:block;height:1px;
  background:linear-gradient(90deg, transparent, rgba(0,240,255,.45) 20%, rgba(57,255,156,.35) 50%, rgba(178,107,255,.4) 80%, transparent);
}
.topbar-inner{
  max-width:1360px;margin:0 auto;padding:12px 24px;
  display:flex;align-items:center;gap:16px;flex-wrap:wrap;
}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none!important;flex-shrink:0}
.brand-mark{
  width:32px;height:32px;border-radius:5px;
  border:1px solid rgba(0,240,255,.55);
  background:linear-gradient(135deg, rgba(0,240,255,.18), rgba(57,255,156,.12));
  box-shadow:0 0 18px rgba(0,240,255,.2), inset 0 0 10px rgba(0,240,255,.12);
  display:grid;place-items:center;
  font-family:var(--mono);font-size:14px;font-weight:800;color:var(--cyan);
}
.brand-text strong{
  display:block;font-family:var(--mono);font-size:14px;font-weight:800;
  color:#fff;letter-spacing:.04em;
}
.brand-text small{
  display:block;font-family:var(--mono);font-size:11px;
  color:var(--cyan);letter-spacing:.08em;text-transform:uppercase;opacity:.82;
}
.nav-links{display:flex;align-items:center;gap:6px;margin-left:8px}
.nav-link{
  font-family:var(--mono);font-size:12px;font-weight:700;
  letter-spacing:.04em;text-transform:uppercase;
  color:var(--text-2);padding:7px 12px;border-radius:5px;
  border:1px solid transparent;text-decoration:none!important;
  transition:color .15s,border-color .15s,background .15s;
  white-space:nowrap;
}
.nav-link:hover{color:#fff;background:rgba(0,240,255,.06);border-color:var(--line-hi)}
.nav-link.active{
  color:var(--cyan);background:var(--cyan-dim);
  border-color:rgba(0,240,255,.42);
  box-shadow:0 0 12px rgba(0,240,255,.12);
}
.top-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}

/* ── Connection / Status Badges ── */
.connection{
  display:inline-flex;align-items:center;gap:8px;
  padding:6px 11px;border-radius:5px;
  border:1px solid var(--line);background:var(--panel);
  font-family:var(--mono);font-size:12px;font-weight:700;
  color:var(--muted);white-space:nowrap;
}
.connection-dot{
  width:8px;height:8px;border-radius:50%;
  background:var(--muted);flex-shrink:0;
}
.connection.connected{color:var(--green);border-color:rgba(57,255,156,.35);background:rgba(57,255,156,.07)}
.connection.connected .connection-dot{background:var(--green);box-shadow:0 0 8px var(--green)}
.connection.connecting{color:var(--amber);border-color:rgba(255,184,0,.35);background:rgba(255,184,0,.07)}
.connection.connecting .connection-dot{background:var(--amber);animation:cyberPulse 1.1s ease-in-out infinite}
.connection.error{color:var(--red);border-color:rgba(255,59,107,.4);background:rgba(255,59,107,.08)}
.connection.error .connection-dot{background:var(--red);box-shadow:0 0 8px var(--red)}
.pill-tag{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 9px;border-radius:4px;
  font-family:var(--mono);font-size:11px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;
  border:1px solid var(--line-hi);background:var(--panel-2);color:var(--text-2);
}
.pill-tag.cyan{color:var(--cyan);border-color:rgba(0,240,255,.35);background:var(--cyan-dim)}
.pill-tag.green{color:var(--green);border-color:rgba(57,255,156,.35);background:var(--green-dim)}
.pill-tag.amber{color:var(--amber);border-color:rgba(255,184,0,.35);background:var(--amber-dim)}
.pill-tag.red{color:var(--red);border-color:rgba(255,59,107,.4);background:var(--red-dim)}
.pill-tag.violet{color:var(--violet);border-color:rgba(178,107,255,.4);background:var(--violet-dim)}

/* ── Buttons ── */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:7px;
  padding:8px 14px;border-radius:5px;
  font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.03em;
  border:1px solid var(--line-hi);background:var(--panel-2);color:var(--text);
  transition:background .15s,border-color .15s,color .15s,box-shadow .15s,transform .12s;
  white-space:nowrap;
}
.btn:hover:not(:disabled){border-color:var(--cyan);color:#fff;background:var(--panel-3)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-cyber{
  background:rgba(0,240,255,.14);border-color:rgba(0,240,255,.55);color:var(--cyan);
}
.btn-cyber:hover:not(:disabled){
  background:var(--cyan);color:#041018;box-shadow:0 0 18px rgba(0,240,255,.32);
}
.btn-green{
  background:rgba(57,255,156,.12);border-color:rgba(57,255,156,.48);color:var(--green);
}
.btn-green:hover:not(:disabled){background:var(--green);color:#04140c;box-shadow:0 0 16px rgba(57,255,156,.28)}
.btn-amber{
  background:rgba(255,184,0,.11);border-color:rgba(255,184,0,.45);color:var(--amber);
}
.btn-amber:hover:not(:disabled){background:var(--amber);color:#171000}
.btn-danger{
  background:rgba(255,59,107,.1);border-color:rgba(255,59,107,.42);color:var(--red);
}
.btn-danger:hover:not(:disabled){background:var(--red);color:#fff;box-shadow:0 0 14px rgba(255,59,107,.3)}
.btn-sm{padding:5px 10px;font-size:11px}

/* ── Shell & Panels ── */
.shell{max-width:1360px;margin:0 auto;padding:22px 24px 56px}
.panel{
  position:relative;
  background:linear-gradient(180deg, rgba(15,25,40,.92), rgba(10,17,28,.96));
  border:1px solid var(--line);
  border-radius:var(--radius);
  padding:18px 20px;
  box-shadow:0 12px 32px rgba(0,0,0,.35);
}
.panel::before{
  content:'';position:absolute;top:-1px;left:14px;right:14px;height:1px;
  background:linear-gradient(90deg, transparent, rgba(0,240,255,.35), transparent);
  pointer-events:none;
}
.panel-head{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  margin-bottom:14px;flex-wrap:wrap;
}
.panel-kicker{
  font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--cyan);letter-spacing:.1em;text-transform:uppercase;
}
.panel-title{
  font-family:var(--mono);font-size:15px;font-weight:800;color:#fff;
  letter-spacing:.02em;margin-top:2px;
}

/* ── Inputs ── */
.field-input,select,input[type=text],input[type=password],input[type=search],input[type=date],input[type=datetime-local],textarea{
  background:#060b12;
  border:1px solid var(--line-hi);
  border-radius:5px;
  padding:9px 12px;
  color:var(--text);
  font-size:13px;
  transition:border-color .15s,box-shadow .15s;
}
.field-input::placeholder,input::placeholder,textarea::placeholder{color:#4f6885}
select:focus,input:focus,textarea:focus{
  outline:none;border-color:var(--cyan);
  box-shadow:0 0 0 3px rgba(0,240,255,.12);
}

/* ── Tables ── */
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:5px;background:rgba(5,9,15,.65)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{
  text-align:left;padding:10px 12px;
  font-family:var(--mono);font-size:11px;font-weight:700;
  text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);background:rgba(15,25,40,.85);
  border-bottom:1px solid var(--line-hi);white-space:nowrap;
}
td{
  padding:10px 12px;border-bottom:1px solid rgba(27,45,68,.55);
  color:var(--text);vertical-align:middle;
}
tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(0,240,255,.045)}
.empty{
  border:1px dashed var(--line-hi);border-radius:6px;
  padding:28px 18px;text-align:center;
  font-family:var(--mono);font-size:13px;color:var(--muted);
}

/* ── KPI Cards ── */
.kpi{
  position:relative;overflow:hidden;
  background:linear-gradient(155deg, rgba(15,25,40,.95), rgba(8,14,23,.96));
  border:1px solid var(--line);border-radius:var(--radius);
  padding:16px 18px;
  transition:border-color .15s,transform .15s;
}
.kpi::before{
  content:'';position:absolute;left:0;top:0;bottom:0;width:3px;
  background:var(--accent,var(--cyan));opacity:.85;
}
.kpi:hover{border-color:var(--line-hi)}
.kpi-label{
  font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--muted);text-transform:uppercase;letter-spacing:.08em;
}
.kpi-value{
  font-family:var(--mono);font-variant-numeric:tabular-nums;
  font-size:clamp(24px,3vw,32px);font-weight:800;line-height:1.15;
  color:var(--accent,#fff);margin-top:8px;letter-spacing:-.02em;
  text-shadow:0 0 20px rgba(0,240,255,.12);
}
.kpi-sub{
  font-family:var(--mono);font-size:11px;color:var(--text-2);
  margin-top:6px;opacity:.85;
}
.kpi.c-cyan{--accent:var(--cyan)}
.kpi.c-green{--accent:var(--green)}
.kpi.c-amber{--accent:var(--amber)}
.kpi.c-red{--accent:var(--red)}
.kpi.c-violet{--accent:var(--violet)}

/* ── Drawer & Modal ── */
.drawer-backdrop,.modal-backdrop{
  position:fixed;inset:0;z-index:500;
  background:rgba(2,5,10,.72);backdrop-filter:blur(4px);
  display:none;align-items:center;justify-content:center;
}
.drawer-backdrop.open,.modal-backdrop.open{display:flex}
.drawer-backdrop{justify-content:flex-end;align-items:stretch}
.drawer{
  width:min(540px,100vw);height:100%;overflow-y:auto;
  background:var(--panel);border-left:1px solid rgba(0,240,255,.35);
  box-shadow:-16px 0 48px rgba(0,0,0,.6);
  padding:22px;display:flex;flex-direction:column;gap:16px;
}
.modal{
  width:min(520px,92vw);max-height:85vh;overflow-y:auto;
  background:var(--panel);border:1px solid rgba(0,240,255,.4);
  border-radius:8px;padding:22px;box-shadow:0 24px 64px rgba(0,0,0,.7);
}
.drawer-head,.modal-head{
  display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  padding-bottom:14px;border-bottom:1px solid var(--line);
}
.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.detail-cell{
  background:rgba(5,9,15,.72);border:1px solid var(--line);border-radius:5px;padding:10px 12px;
}
.detail-cell span{
  display:block;font-family:var(--mono);font-size:11px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.06em;
}
.detail-cell strong{
  display:block;font-family:var(--mono);font-size:13px;color:#fff;
  margin-top:4px;overflow-wrap:anywhere;
}

/* ── Toast Stack ── */
.toast-stack{
  position:fixed;right:20px;bottom:20px;z-index:800;
  display:flex;flex-direction:column;gap:8px;max-width:min(380px,calc(100vw - 32px));
}
.toast{
  padding:11px 14px;border-radius:5px;
  font-family:var(--mono);font-size:12px;font-weight:600;
  background:var(--panel-2);border:1px solid var(--cyan);color:var(--text);
  box-shadow:0 10px 28px rgba(0,0,0,.55);
}
.toast.ok{border-color:var(--green);color:var(--green)}
.toast.err{border-color:var(--red);color:var(--red)}

/* ── Progress / Spark Bars ── */
.bar-track{height:7px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--cyan),var(--green))}

@keyframes cyberPulse{50%{opacity:.35}}
@keyframes blinkCursor{50%{opacity:0}}
.cursor-blink{display:inline-block;width:8px;height:14px;background:var(--cyan);vertical-align:-2px;margin-left:4px;animation:blinkCursor 1.1s steps(1) infinite}

@media (max-width:720px){
  .topbar-inner{padding:10px 14px;gap:10px}
  .nav-links{order:3;width:100%;margin-left:0;overflow-x:auto;padding-top:4px;border-top:1px solid rgba(27,45,68,.55)}
  .shell{padding:14px 14px 44px}
  .panel{padding:14px}
  .detail-grid{grid-template-columns:1fr}
}
`;
}

// ── Public stats page ─────────────────────────────────────────────────
function buildPublicStatsHtml() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="description" content="Anonymous usage statistics for Tuxevil Rotator">
<title>TUXEVIL // Public Telemetry</title>
<style>
${buildSharedCyberCss()}
.status-strip{
  display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding:12px 16px;margin-bottom:18px;
  background:rgba(10,17,28,.9);border:1px solid var(--line);border-radius:var(--radius);
}
.status-left{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.status-title{font-family:var(--mono);font-size:15px;font-weight:800;color:#fff;letter-spacing:.03em}
.status-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.status-msg{font-family:var(--mono);font-size:12px;color:var(--text-2)}
.status-msg.error{color:var(--red)}
.stats-grid{
  display:grid;
  grid-template-columns:repeat(5,minmax(0,1fr));
  gap:12px;margin-bottom:18px;
}
.stat{min-height:118px;display:flex;flex-direction:column;justify-content:space-between}
.stat-value{font-size:clamp(24px,2.8vw,34px)!important}
.viz-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,.75fr);gap:14px;margin-bottom:14px}
.viz-stack{display:flex;flex-direction:column;gap:14px}
.model-row{display:grid;grid-template-columns:minmax(130px,1.2fr) minmax(80px,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(27,45,68,.5)}
.model-row:last-child{border-bottom:none}
.model-name{font-family:var(--mono);font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-val{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--cyan);text-align:right;white-space:nowrap}
.seg-group{display:inline-flex;border:1px solid var(--line-hi);border-radius:5px;overflow:hidden}
.seg-btn{
  padding:5px 10px;font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--muted);background:var(--bg-2);border-right:1px solid var(--line);
}
.seg-btn:last-child{border-right:none}
.seg-btn.active{background:var(--cyan-dim);color:var(--cyan)}
.ratio-bar{height:14px;border-radius:4px;overflow:hidden;display:flex;background:rgba(255,255,255,.06);border:1px solid var(--line);margin:10px 0}
.ratio-in{background:linear-gradient(90deg,#00b8d4,var(--cyan));height:100%;transition:width .4s ease}
.ratio-out{background:linear-gradient(90deg,#8b5cf6,var(--violet));height:100%;transition:width .4s ease}
.ratio-legend{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-family:var(--mono);font-size:12px}
.os-list{display:flex;flex-direction:column;gap:10px}
.os-item-top{display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px;margin-bottom:4px}
.pulse-svg{width:100%;height:148px;display:block}
.pulse-meta{display:flex;justify-content:space-between;gap:10px;margin-top:8px;font-family:var(--mono);font-size:11px;color:var(--muted)}
.pulse-tooltip{font-family:var(--mono);font-size:12px;color:var(--cyan);min-height:18px}
.embed-drawer{margin-top:14px;display:none}
.embed-drawer.open{display:block}
.code-box{
  background:#04070c;border:1px solid var(--line-hi);border-radius:5px;
  padding:11px 12px;font-family:var(--mono);font-size:12px;color:var(--green);
  overflow-x:auto;white-space:pre;margin-top:8px;
}
.footer{
  display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  margin-top:24px;padding-top:14px;border-top:1px solid var(--line);
  font-family:var(--mono);font-size:12px;color:var(--muted);
}
@media (max-width:1020px){
  .stats-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .viz-grid{grid-template-columns:1fr}
}
@media (max-width:600px){
  .stats-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stats-grid .stat:last-child{grid-column:1/-1}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/stats">
      <span class="brand-mark" aria-hidden="true">&gt;_</span>
      <span class="brand-text">
        <strong>TUXEVIL//ROTATOR</strong>
        <small>PUBLIC TELEMETRY</small>
      </span>
    </a>
    <nav class="nav-links" aria-label="Telemetry navigation">
      <a class="nav-link active" href="/stats">PUBLIC STATS</a>
      <a class="nav-link" href="/dashboard">CONTROL ROOM</a>
      <a class="nav-link" href="/notifications">BROADCASTS</a>
    </nav>
    <div class="top-right">
      <span class="connection connected" id="pubLiveBadge"><span class="connection-dot"></span><span id="pubLiveLabel">LIVE</span></span>
      <button class="btn btn-cyber btn-sm" id="syncBtn" type="button">[R] SYNC</button>
      <button class="btn btn-sm" id="toggleBadgesBtn" type="button">&lt;/&gt; API</button>
    </div>
  </div>
</header>

<main class="shell">
  <section class="status-strip" aria-label="Telemetry sync status">
    <div class="status-left">
      <span class="pill-tag cyan">SYS://ANONYMOUS_TELEMETRY</span>
      <span class="status-title">COMMUNITY FLEET PULSE<span class="cursor-blink" aria-hidden="true"></span></span>
    </div>
    <div class="status-right">
      <span class="status-msg" id="status" role="status" aria-live="polite">Syncing live telemetry...</span>
      <span class="pill-tag" id="countdownPill">NEXT 05:00</span>
    </div>
  </section>

  <section class="stats-grid" aria-label="Public usage statistics">
    <article class="kpi stat c-violet">
      <div class="kpi-label">Installations</div>
      <div class="kpi-value stat-value" id="installs">-</div>
      <div class="kpi-sub" id="installsSub">active 7d: —</div>
    </article>
    <article class="kpi stat c-green">
      <div class="kpi-label">Requests routed</div>
      <div class="kpi-value stat-value" id="requests">-</div>
      <div class="kpi-sub" id="requestsSub">cumulative</div>
    </article>
    <article class="kpi stat c-amber">
      <div class="kpi-label">Estimated savings</div>
      <div class="kpi-value stat-value" id="savings">-</div>
      <div class="kpi-sub" id="savingsSub">vs paid APIs</div>
    </article>
    <article class="kpi stat c-cyan">
      <div class="kpi-label">Input tokens</div>
      <div class="kpi-value stat-value" id="tokensInput">-</div>
      <div class="kpi-sub" id="tokensInputSub">prompt volume</div>
    </article>
    <article class="kpi stat c-cyan">
      <div class="kpi-label">Output tokens</div>
      <div class="kpi-value stat-value" id="tokensOutput">-</div>
      <div class="kpi-sub" id="tokensOutputSub">completion volume</div>
    </article>
  </section>

  <div class="viz-grid">
    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-kicker">MODEL MATRIX</div>
          <div class="panel-title">Top routed models</div>
        </div>
        <div class="seg-group" role="tablist" aria-label="Model metric">
          <button class="seg-btn active" type="button" data-metric="tokens">TOKENS</button>
          <button class="seg-btn" type="button" data-metric="requests">REQUESTS</button>
          <button class="seg-btn" type="button" data-metric="savings">USD</button>
        </div>
      </div>
      <div id="topModelsList"><div class="empty">Awaiting telemetry payload...</div></div>
    </section>

    <div class="viz-stack">
      <section class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">14D PULSE</div>
            <div class="panel-title">Daily active nodes</div>
          </div>
          <div class="pulse-tooltip" id="pulseHover">Hover bars to inspect</div>
        </div>
        <div id="pulseChartWrap"><div class="empty">No daily series yet</div></div>
        <div class="pulse-meta"><span id="periodFrom">—</span><span id="periodTo">—</span></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">TRAFFIC SPLIT</div>
            <div class="panel-title">Token balance &amp; OS nodes</div>
          </div>
          <span class="pill-tag green" id="totalTokensBadge">TOTAL —</span>
        </div>
        <div class="ratio-bar" aria-label="Input vs output token ratio">
          <div class="ratio-in" id="ratioIn" style="width:50%"></div>
          <div class="ratio-out" id="ratioOut" style="width:50%"></div>
        </div>
        <div class="ratio-legend">
          <span style="color:var(--cyan)" id="ratioInLabel">IN —%</span>
          <span style="color:var(--violet)" id="ratioOutLabel">OUT —%</span>
        </div>
        <div style="margin-top:16px" class="os-list" id="osList"></div>
      </section>
    </div>
  </div>

  <section class="panel embed-drawer" id="embedDrawer">
    <div class="panel-head">
      <div>
        <div class="panel-kicker">INTEGRATION</div>
        <div class="panel-title">Public JSON &amp; Shields.io Badges</div>
      </div>
      <div style="display:flex;gap:8px">
        <a class="btn btn-sm" href="/v1/public-stats" target="_blank" rel="noopener">OPEN /v1/public-stats</a>
        <button class="btn btn-cyber btn-sm" id="copyBadgeBtn" type="button">COPY MARKDOWN</button>
      </div>
    </div>
    <div class="code-box" id="badgeCode"></div>
  </section>

  <footer class="footer">
    <span>ZERO-PII ANONYMOUS AGGREGATE // 5M CACHE // <span id="catalogInfo">—</span></span>
    <span style="display:flex;gap:14px">
      <a href="/v1/public-stats">RAW JSON</a>
      <a href="https://github.com/tuxevil/tuxevil-rotator" target="_blank" rel="noopener">GITHUB</a>
    </span>
  </footer>
</main>

<div class="toast-stack" id="toastStack" aria-live="polite"></div>

<script>
const REFRESH_MS = 5 * 60 * 1000;
const fields = [
  ["installs", "installsFormatted"],
  ["requests", "requestsFormatted"],
  ["savings", "savingsFormatted"],
  ["tokensInput", "tokensInputFormatted"],
  ["tokensOutput", "tokensOutputFormatted"],
];
let _pubStats = null;
let _modelMetric = "tokens";
let _nextRefreshAt = Date.now() + REFRESH_MS;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fmtCompact(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (Math.floor(n / 1e8) / 10) + "B";
  if (n >= 1e6) return (Math.floor(n / 1e5) / 10) + "M";
  if (n >= 1e3) return (Math.floor(n / 1e2) / 10) + "K";
  return n.toLocaleString();
}
function toast(msg, kind) {
  const stack = $("toastStack");
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(function() { el.remove(); }, 3200);
}
function formatUpdatedAt(value) {
  if (!value) return "SYNCED JUST NOW";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "SYNCED JUST NOW" : "SYNCED " + date.toLocaleTimeString();
}

function renderModels() {
  const wrap = $("topModelsList");
  const list = (_pubStats && _pubStats.topModels) || [];
  if (!list.length) {
    wrap.innerHTML = '<div class="empty">No model token telemetry recorded yet.</div>';
    return;
  }
  const sorted = list.slice().sort(function(a, b) {
    if (_modelMetric === "requests") return (b.requests || 0) - (a.requests || 0);
    if (_modelMetric === "savings") return (b.savingsUsd || 0) - (a.savingsUsd || 0);
    return (b.total || 0) - (a.total || 0);
  });
  const maxVal = Math.max.apply(null, sorted.map(function(m) {
    if (_modelMetric === "requests") return m.requests || 0;
    if (_modelMetric === "savings") return m.savingsUsd || 0;
    return m.total || 0;
  }).concat([1]));

  wrap.innerHTML = sorted.map(function(m) {
    const val = _modelMetric === "requests" ? (m.requests || 0)
      : _modelMetric === "savings" ? (m.savingsUsd || 0) : (m.total || 0);
    const pct = Math.max(3, Math.round((val / maxVal) * 100));
    const label = _modelMetric === "requests" ? fmtCompact(val) + " req"
      : _modelMetric === "savings" ? "$" + Number(val).toFixed(2)
      : fmtCompact(val) + " (" + (m.sharePct || 0) + "%)";
    return '<div class="model-row">' +
      '<div class="model-name" title="' + esc(m.model) + '">' + esc(m.model) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="model-val">' + esc(label) + '</div>' +
    '</div>';
  }).join("");
}

function renderPulse(trend) {
  const wrap = $("pulseChartWrap");
  if (!trend || !trend.length) {
    wrap.innerHTML = '<div class="empty">Awaiting daily history...</div>';
    return;
  }
  const w = 520, h = 140, padB = 14, padT = 10;
  const maxInst = Math.max.apply(null, trend.map(function(d) { return d.installs || 0; }).concat([1]));
  const maxEv = Math.max.apply(null, trend.map(function(d) { return d.events || 0; }).concat([1]));
  const step = w / trend.length;
  const bw = Math.max(8, step - 6);
  let bars = "";
  let linePts = [];
  trend.forEach(function(d, idx) {
    const x = idx * step + (step - bw) / 2;
    const bh = Math.max(4, Math.round(((d.installs || 0) / maxInst) * (h - padB - padT)));
    const y = h - padB - bh;
    const ey = h - padB - Math.max(4, Math.round(((d.events || 0) / maxEv) * (h - padB - padT)));
    linePts.push((x + bw / 2).toFixed(1) + "," + ey.toFixed(1));
    bars += '<rect class="pulse-bar" data-idx="' + idx + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" fill="rgba(0,240,255,0.45)" stroke="#00f0ff" stroke-width="1" style="cursor:pointer"></rect>';
  });
  const polyline = trend.length > 1
    ? '<polyline fill="none" stroke="#39ff9c" stroke-width="2" points="' + linePts.join(" ") + '"></polyline>'
    : "";
  wrap.innerHTML = '<svg class="pulse-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="14-day daily active nodes">' +
    '<line x1="0" y1="' + (h - padB) + '" x2="' + w + '" y2="' + (h - padB) + '" stroke="#1b2d44" stroke-width="1"></line>' +
    bars + polyline + '</svg>';
  $("periodFrom").textContent = trend[0].date;
  $("periodTo").textContent = trend[trend.length - 1].date + "  (cyan: nodes / green: events)";
  wrap.querySelectorAll(".pulse-bar").forEach(function(rect) {
    rect.addEventListener("mouseenter", function() {
      const d = trend[Number(rect.getAttribute("data-idx"))];
      if (d) $("pulseHover").textContent = d.date + " :: " + d.installs + " nodes / " + d.events + " events";
    });
  });
}

function renderSplitAndOs(stats) {
  const inp = Number(stats.tokensInput || 0);
  const out = Number(stats.tokensOutput || 0);
  const tot = inp + out;
  const inPct = tot > 0 ? Math.round((inp / tot) * 1000) / 10 : 50;
  const outPct = tot > 0 ? Math.round((out / tot) * 1000) / 10 : 50;
  $("ratioIn").style.width = inPct + "%";
  $("ratioOut").style.width = outPct + "%";
  $("ratioInLabel").textContent = "IN " + inPct + "% (" + (stats.tokensInputFormatted || "0") + ")";
  $("ratioOutLabel").textContent = "OUT " + outPct + "% (" + (stats.tokensOutputFormatted || "0") + ")";
  $("totalTokensBadge").textContent = "TOTAL " + (stats.totalTokensFormatted || fmtCompact(tot));

  const osMap = stats.osDistribution || {};
  const entries = Object.entries(osMap).sort(function(a, b) { return b[1] - a[1]; });
  const osTot = entries.reduce(function(acc, e) { return acc + e[1]; }, 0);
  const osEl = $("osList");
  if (!entries.length) {
    osEl.innerHTML = '<div class="empty" style="padding:14px">No OS distribution yet</div>';
    return;
  }
  const osLabels = { linux: "Linux", darwin: "macOS", win32: "Windows" };
  osEl.innerHTML = entries.slice(0, 5).map(function(pair) {
    const name = osLabels[pair[0]] || pair[0];
    const count = pair[1];
    const pct = osTot > 0 ? Math.round((count / osTot) * 100) : 0;
    return '<div><div class="os-item-top"><span>' + esc(name) + '</span><span style="color:var(--green)">' + count + ' (' + pct + '%)</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(4, pct) + '%"></div></div></div>';
  }).join("");
}

function buildBadgesSnippet() {
  const base = encodeURIComponent(location.origin + "/v1/public-stats");
  const lines = [
    "[![Installations](https://img.shields.io/badge/dynamic/json?url=" + base + "&query=%24.installsFormatted&label=installations&color=00f0ff)](" + location.origin + "/stats)",
    "[![Requests](https://img.shields.io/badge/dynamic/json?url=" + base + "&query=%24.requestsFormatted&label=requests&color=39ff9c)](" + location.origin + "/stats)",
    "[![Savings](https://img.shields.io/badge/dynamic/json?url=" + base + "&query=%24.savingsFormatted&label=savings&color=ffb800)](" + location.origin + "/stats)"
  ];
  $("badgeCode").textContent = lines.join("\\n");
}

async function loadStats(manual) {
  const status = $("status");
  const btn = $("syncBtn");
  btn.disabled = true;
  $("pubLiveBadge").className = "connection connecting";
  $("pubLiveLabel").textContent = "SYNCING";
  try {
    const response = await fetch("/v1/public-stats", { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const stats = await response.json();
    _pubStats = stats;
    for (const [elementId, field] of fields) {
      $(elementId).textContent = stats[field] ?? "-";
    }
    $("installsSub").textContent = "24h: " + (stats.activeInstalls24h ?? 0) + " / 7d: " + (stats.activeInstalls7d ?? 0);
    $("requestsSub").textContent = Number(stats.requests || 0).toLocaleString() + " total";
    $("savingsSub").textContent = "$" + Number(stats.savingsUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " USD";
    $("tokensInputSub").textContent = Number(stats.tokensInput || 0).toLocaleString();
    $("tokensOutputSub").textContent = Number(stats.tokensOutput || 0).toLocaleString();
    $("catalogInfo").textContent = (stats.modelsTracked ?? 0) + " ACTIVE / " + (stats.catalogModels ?? 0) + " PRICED MODELS";
    renderModels();
    renderPulse(stats.dailyTrend || []);
    renderSplitAndOs(stats);
    status.className = "status-msg";
    status.textContent = formatUpdatedAt(stats.updatedAt);
    $("pubLiveBadge").className = "connection connected";
    $("pubLiveLabel").textContent = "LIVE";
    _nextRefreshAt = Date.now() + REFRESH_MS;
    if (manual) toast("Telemetry synced", "ok");
  } catch (error) {
    status.className = "status-msg error";
    status.textContent = "OFFLINE :: retrying in 5m (" + (error.message || "error") + ")";
    $("pubLiveBadge").className = "connection error";
    $("pubLiveLabel").textContent = "ERROR";
  } finally {
    btn.disabled = false;
  }
}

document.querySelectorAll(".seg-btn").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".seg-btn").forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    _modelMetric = btn.getAttribute("data-metric") || "tokens";
    renderModels();
  });
});
$("syncBtn").addEventListener("click", function() { loadStats(true); });
$("toggleBadgesBtn").addEventListener("click", function() {
  $("embedDrawer").classList.toggle("open");
});
$("copyBadgeBtn").addEventListener("click", function() {
  navigator.clipboard?.writeText($("badgeCode").textContent).then(function() {
    toast("Shields.io markdown copied", "ok");
  }).catch(function() { toast("Copy failed", "err"); });
});
document.addEventListener("keydown", function(e) {
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === "r" || e.key === "R") { e.preventDefault(); loadStats(true); }
});
setInterval(function() {
  const left = Math.max(0, Math.round((_nextRefreshAt - Date.now()) / 1000));
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  $("countdownPill").textContent = "NEXT " + mm + ":" + ss;
}, 1000);

buildBadgesSnippet();
loadStats(false);
setInterval(function() { loadStats(false); }, REFRESH_MS);
</script>
</body>
</html>`;
}

// ── Rate limiting (simple in-memory per-IP) ──────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 12; // 12 requests per minute per IP

function isRateLimited(ip) {
	const now = Date.now();
	let entry = rateLimitMap.get(ip);
	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		entry = { windowStart: now, count: 0 };
		rateLimitMap.set(ip, entry);
	}
	entry.count++;
	return entry.count > RATE_LIMIT_MAX;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
	const now = Date.now();
	for (const [ip, entry] of rateLimitMap) {
		if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
			rateLimitMap.delete(ip);
		}
	}
}, 5 * 60_000).unref();

// ── Dashboard HTML ───────────────────────────────────────────────────
function buildDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TUXEVIL // Telemetry Control Room</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
${buildSharedCyberCss()}
.auth-panel{margin-bottom:18px;border-color:rgba(0,240,255,.35)}
.auth-panel.collapsed{display:none}
.auth-row{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
.auth-title{font-family:var(--mono);font-size:17px;font-weight:800;color:#fff;margin-top:4px}
.auth-note{font-size:13px;color:var(--text-2);margin-top:3px}
.token-form{display:flex;gap:8px;flex:1;min-width:min(100%,380px);max-width:560px}
.token-form input{flex:1;min-width:0;font-family:var(--mono)}
.subnav-bar{
  display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;
  margin-bottom:14px;
}
.view-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.view-tab{
  display:inline-flex;align-items:center;gap:7px;
  padding:8px 13px;border-radius:5px;
  border:1px solid var(--line);background:var(--panel);
  font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.03em;
  color:var(--text-2);transition:all .15s;
}
.view-tab:hover{color:#fff;border-color:var(--line-hi);background:var(--panel-2)}
.view-tab.active{
  color:var(--cyan);border-color:rgba(0,240,255,.5);
  background:var(--cyan-dim);box-shadow:0 0 14px rgba(0,240,255,.12);
}
.tab-count{
  padding:1px 6px;border-radius:3px;font-size:11px;
  background:rgba(255,255,255,.08);color:var(--text);
}
.tab-count.alert{background:var(--red-dim);color:var(--red);border:1px solid rgba(255,59,107,.4)}
.toolbar-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.preset-group{display:inline-flex;border:1px solid var(--line-hi);border-radius:5px;overflow:hidden}
.preset-btn{
  padding:6px 10px;font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--muted);background:var(--panel);border-right:1px solid var(--line);
}
.preset-btn:last-child{border-right:none}
.preset-btn:hover{color:#fff}
.preset-btn.active{background:var(--cyan-dim);color:var(--cyan)}
.filter-bar{
  margin-bottom:14px;padding:14px 16px;
  background:rgba(10,17,28,.94);border:1px solid var(--line-hi);border-radius:var(--radius);
  display:none;flex-direction:column;gap:12px;
}
.filter-bar.open{display:flex}
.filter-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;align-items:end}
.filter-group{display:flex;flex-direction:column;gap:5px;min-width:0}
.filter-group label{
  font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--muted);text-transform:uppercase;letter-spacing:.07em;
}
.filter-group select,.filter-group input{width:100%;min-width:0}
.filter-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.active-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.filter-chip{
  display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:4px;
  font-family:var(--mono);font-size:11px;font-weight:700;
  background:var(--green-dim);border:1px solid rgba(57,255,156,.38);color:var(--green);
}
.filter-chip button{color:var(--green);font-weight:800;font-size:13px;line-height:1;padding:0 2px}
.filter-chip button:hover{color:#fff}
.error-banner{
  background:var(--red-dim);border:1px solid rgba(255,59,107,.45);border-radius:6px;
  padding:12px 14px;color:var(--red);font-family:var(--mono);font-size:13px;margin-bottom:14px;
}
.kpi-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}
.flag-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}
.charts-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}
.charts-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:14px}
.chart-box{
  min-width:0;background:rgba(8,14,23,.9);border:1px solid var(--line);
  border-radius:var(--radius);padding:16px;
}
.chart-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.chart-box h3{
  font-family:var(--mono);font-size:12px;font-weight:700;
  color:var(--text-2);text-transform:uppercase;letter-spacing:.07em;
}
.chart-canvas-wrap{position:relative;height:215px}
.chart-canvas-wrap.tall{height:245px}
.savings-hero{display:grid;grid-template-columns:minmax(240px,.7fr) minmax(0,1.3fr);gap:14px;margin-bottom:14px}
.savings-big{
  font-family:var(--mono);font-size:clamp(30px,4vw,44px);font-weight:800;
  color:var(--green);letter-spacing:-.03em;margin:8px 0 4px;
  text-shadow:0 0 24px rgba(57,255,156,.2);
}
.ratio-bar{height:12px;border-radius:4px;overflow:hidden;display:flex;background:rgba(255,255,255,.07);border:1px solid var(--line);margin:10px 0 8px}
.ratio-in{background:linear-gradient(90deg,#00b8d4,var(--cyan));height:100%}
.ratio-out{background:linear-gradient(90deg,#8b5cf6,var(--violet));height:100%}
.pane{display:none}
.pane.active{display:block}
.toolbar-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.toolbar-inline input[type=search]{min-width:220px;flex:1;max-width:340px}
.chip-filter{
  padding:6px 10px;border-radius:4px;border:1px solid var(--line);
  background:var(--panel);font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--muted);
}
.chip-filter:hover{color:#fff;border-color:var(--line-hi)}
.chip-filter.active{border-color:rgba(0,240,255,.48);background:var(--cyan-dim);color:var(--cyan)}
.health-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.click-row{cursor:pointer}
.click-row:hover td{background:rgba(0,240,255,.07)!important}
.mini-bar{display:flex;align-items:center;gap:8px}
.mini-bar .bar-track{width:56px;height:5px;flex-shrink:0}
.sort-th{cursor:pointer;user-select:none}
.sort-th:hover{color:#fff}
.sort-th.active{color:var(--cyan)}
.sync-note{font-family:var(--mono);font-size:11px;color:var(--muted)}
.kbd-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.kbd-item{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:rgba(5,9,15,.7);border:1px solid var(--line);border-radius:5px;font-size:13px}
@media (max-width:1120px){
  .kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .filter-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .charts-3{grid-template-columns:repeat(2,minmax(0,1fr))}
  .savings-hero{grid-template-columns:1fr}
}
@media (max-width:720px){
  .kpi-grid,.flag-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .filter-grid,.charts-3,.charts-2{grid-template-columns:1fr}
  .toolbar-inline input[type=search]{max-width:none;width:100%}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">&gt;_</span>
      <span class="brand-text">
        <strong>TUXEVIL//ROTATOR</strong>
        <small>OPS TELEMETRY</small>
      </span>
    </a>
    <nav class="nav-links" aria-label="Operator navigation">
      <a class="nav-link active" href="/dashboard">CONTROL ROOM</a>
      <a class="nav-link" href="/notifications">BROADCASTS</a>
      <a class="nav-link" href="/stats">PUBLIC STATS</a>
    </nav>
    <div class="top-right">
      <button class="connection" id="dashboardConnection" type="button" title="Toggle token settings">
        <span class="connection-dot"></span>
        <span id="dashboardConnectionLabel">DISCONNECTED</span>
      </button>
      <button class="btn btn-sm" id="autoBtn" type="button" title="Toggle 60s auto-sync">AUTO: ON</button>
      <button class="btn btn-cyber btn-sm" id="refreshBtn" type="button">[R] SYNC</button>
      <button class="btn btn-sm" id="helpBtn" type="button" title="Keyboard shortcuts">?</button>
    </div>
  </div>
</header>

<main class="shell">
  <section class="panel auth-panel" id="authStrip">
    <div class="auth-row">
      <div>
        <div class="panel-kicker">OPERATOR ACCESS // PRIVATE</div>
        <div class="auth-title">Telemetry control room</div>
        <div class="auth-note">Authenticate with <code class="mono">STATS_TOKEN</code> (shared across Control Room &amp; Broadcasts).</div>
      </div>
      <form class="token-form" id="dashboardAuthForm">
        <label class="sr-only" for="tok">STATS_TOKEN</label>
        <input type="password" id="tok" autocomplete="current-password" placeholder="Paste STATS_TOKEN..." />
        <button class="btn btn-sm" id="toggleTokVis" type="button" title="Show/hide token">SHOW</button>
        <button class="btn btn-cyber" id="loadBtn" type="submit">CONNECT</button>
        <button class="btn btn-danger btn-sm" id="disconnectBtn" type="button" style="display:none">LOGOUT</button>
      </form>
    </div>
  </section>

  <div class="error-banner" id="err" style="display:none"></div>

  <div id="workspace" style="display:none">
    <div class="subnav-bar">
      <div class="view-tabs" id="viewTabs" role="tablist">
        <button class="view-tab active" id="vtAgg" type="button" data-view="agg"><span class="kbd">1</span> OVERVIEW</button>
        <button class="view-tab" id="vtFlags" type="button" data-view="flags"><span class="kbd">2</span> FLAGS <span class="tab-count" id="flagsTabBadge">0</span></button>
        <button class="view-tab" id="vtModels" type="button" data-view="models"><span class="kbd">3</span> MODELS &amp; USD</button>
        <button class="view-tab" id="vtList" type="button" data-view="list"><span class="kbd">4</span> INSTALLS <span class="tab-count" id="installsTabBadge">0</span></button>
      </div>
      <div class="toolbar-right">
        <div class="preset-group" aria-label="Quick date range">
          <button class="preset-btn active" type="button" data-range="all">ALL</button>
          <button class="preset-btn" type="button" data-range="1">24H</button>
          <button class="preset-btn" type="button" data-range="7">7D</button>
          <button class="preset-btn" type="button" data-range="30">30D</button>
        </div>
        <button class="btn btn-sm" id="toggleFilterBtn" type="button">[F] FILTERS <span class="tab-count" id="filterCountBadge" style="display:none">0</span></button>
        <button class="btn btn-sm" id="exportJsonBtn" type="button">JSON</button>
        <span class="sync-note" id="ts">—</span>
      </div>
    </div>

    <div class="filter-bar" id="filterBar">
      <div class="filter-grid">
        <div class="filter-group"><label for="fInstall">Install ID</label><select id="fInstall"><option value="">All installs</option></select></div>
        <div class="filter-group"><label for="fVersion">Version</label><select id="fVersion"><option value="">All versions</option></select></div>
        <div class="filter-group"><label for="fOS">OS</label><select id="fOS"><option value="">All OS</option></select></div>
        <div class="filter-group"><label for="fModel">Model</label><select id="fModel"><option value="">All models</option></select></div>
        <div class="filter-group"><label for="fFrom">From</label><input type="date" id="fFrom" /></div>
        <div class="filter-group"><label for="fTo">To</label><input type="date" id="fTo" /></div>
      </div>
      <div class="filter-foot">
        <span class="sync-note" id="filterActive">No active filters</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm" id="clearFiltersBtn" type="button">CLEAR</button>
          <button class="btn btn-cyber btn-sm" id="applyFiltersBtn" type="button">APPLY FILTERS</button>
        </div>
      </div>
    </div>

    <div class="active-chips" id="activeFilterChips" style="display:none"></div>

    <div id="app">
      <!-- VIEW 1: OVERVIEW -->
      <section class="pane active" id="pane-agg">
        <div class="kpi-grid" id="kpis"></div>
        <div class="chart-box" style="margin-bottom:14px">
          <div class="chart-head">
            <h3>DAILY TELEMETRY PULSE (ACTIVE NODES &amp; FLAGS)</h3>
            <span class="sync-note" id="timelineSpan">—</span>
          </div>
          <div class="chart-canvas-wrap tall"><canvas id="cTimeline"></canvas></div>
        </div>
        <div class="charts-3">
          <div class="chart-box">
            <div class="chart-head">
              <h3>ROUTING HEALTH</h3>
              <button class="btn btn-sm" id="healthModeBtn" type="button" title="Toggle Installs vs Events">BY INSTALLS</button>
            </div>
            <div class="chart-canvas-wrap"><canvas id="cHealth"></canvas></div>
          </div>
          <div class="chart-box"><div class="chart-head"><h3>VERSIONS</h3></div><div class="chart-canvas-wrap"><canvas id="cVersions"></canvas></div></div>
          <div class="chart-box"><div class="chart-head"><h3>OPERATING SYSTEMS</h3></div><div class="chart-canvas-wrap"><canvas id="cOS"></canvas></div></div>
        </div>
      </section>

      <!-- VIEW 2: FLAGS & FORENSICS -->
      <section class="pane" id="pane-flags">
        <div class="flag-kpis" id="flagKpis"></div>
        <div class="charts-2">
          <div class="chart-box"><div class="chart-head"><h3>BY PROVIDER REASON</h3></div><div class="chart-canvas-wrap"><canvas id="cFlagReasons"></canvas></div></div>
          <div class="chart-box"><div class="chart-head"><h3>BY MATCHED PATTERN</h3></div><div class="chart-canvas-wrap"><canvas id="cPatterns"></canvas></div></div>
          <div class="chart-box"><div class="chart-head"><h3>BY MODEL</h3></div><div class="chart-canvas-wrap"><canvas id="cFlagModels"></canvas></div></div>
          <div class="chart-box"><div class="chart-head"><h3>BY TIMER TYPE</h3></div><div class="chart-canvas-wrap"><canvas id="cTimerType"></canvas></div></div>
        </div>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">INCIDENT LOG // CLICK ROW FOR FORENSICS</div>
              <div class="panel-title">Recent flag incidents</div>
            </div>
            <input type="search" id="flagSearch" placeholder="Filter reason, model, install, HTTP..." style="width:min(300px,100%)" />
          </div>
          <div id="flagIncidents"></div>
        </section>
      </section>

      <!-- VIEW 3: MODELS & SAVINGS -->
      <section class="pane" id="pane-models">
        <div class="savings-hero">
          <div class="panel">
            <div class="panel-kicker">EFFICIENCY // AVOIDED SPEND</div>
            <div class="savings-big" id="savTotal">$0.00</div>
            <div class="sync-note" id="savSub">Estimated USD saved across filtered cohort</div>
            <div class="ratio-bar" style="margin-top:16px">
              <div class="ratio-in" id="dashRatioIn" style="width:50%"></div>
              <div class="ratio-out" id="dashRatioOut" style="width:50%"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:12px">
              <span style="color:var(--cyan)" id="dashInTok">IN 0</span>
              <span style="color:var(--violet)" id="dashOutTok">OUT 0</span>
            </div>
          </div>
          <div class="charts-2" style="margin-bottom:0">
            <div class="chart-box"><div class="chart-head"><h3>ACTIVE MODELS</h3></div><div class="chart-canvas-wrap"><canvas id="cModels"></canvas></div></div>
            <div class="chart-box"><div class="chart-head"><h3>FEATURES USED</h3></div><div class="chart-canvas-wrap"><canvas id="cFeatures"></canvas></div></div>
          </div>
        </div>
        <section class="panel" style="margin-bottom:14px">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">ESTIMATED SAVINGS BREAKDOWN</div>
              <div class="panel-title">Savings by model</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="search" id="modelSearch" placeholder="Filter models..." style="width:200px" />
              <button class="btn btn-sm" id="exportModelsCsvBtn" type="button">CSV</button>
            </div>
          </div>
          <div id="savTable"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">TOKEN CONSUMPTION</div>
              <div class="panel-title">Volume by model</div>
            </div>
          </div>
          <div id="tokTable"></div>
        </section>
      </section>

      <!-- VIEW 4: INSTALLATIONS -->
      <section class="pane" id="installsView">
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-kicker">FLEET EXPLORER // CLICK ROW TO INSPECT</div>
              <div class="panel-title">Connected installations <span class="pill-tag cyan" id="installCount" style="margin-left:8px">0</span></div>
            </div>
            <button class="btn btn-sm" id="exportInstallsCsvBtn" type="button">EXPORT CSV</button>
          </div>
          <div class="toolbar-inline">
            <label class="sr-only" for="installSearch">Search installations</label>
            <input type="search" id="installSearch" placeholder="Search install ID, version, OS..." />
            <button class="chip-filter active" type="button" data-health="all">ALL</button>
            <button class="chip-filter" type="button" data-health="healthy">HEALTHY</button>
            <button class="chip-filter" type="button" data-health="degraded">DEGRADED</button>
            <button class="chip-filter" type="button" data-health="flagged">HAS FLAGS</button>
            <span style="margin-left:auto;display:flex;gap:5px;flex-wrap:wrap">
              <button class="chip-filter active" id="isort-requests" type="button" data-sort="requests">REQ</button>
              <button class="chip-filter" id="isort-savings" type="button" data-sort="savings">USD</button>
              <button class="chip-filter" id="isort-accounts" type="button" data-sort="accounts">ACCT</button>
              <button class="chip-filter" id="isort-flags" type="button" data-sort="flags">FLAGS</button>
              <button class="chip-filter" id="isort-lastseen" type="button" data-sort="lastseen">SEEN</button>
            </span>
          </div>
          <div id="installTableWrap"></div>
        </section>
      </section>
    </div>
  </div>
</main>

<div class="drawer-backdrop" id="detailDrawerWrap" aria-hidden="true">
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
    <div class="drawer-head">
      <div>
        <div class="panel-kicker" id="drawerKicker">INSPECTOR</div>
        <div class="panel-title" id="drawerTitle">Details</div>
      </div>
      <button class="btn btn-sm" id="closeDrawerBtn" type="button">[ESC] CLOSE</button>
    </div>
    <div id="drawerBody"></div>
  </aside>
</div>

<div class="modal-backdrop" id="kbdModal" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="kbdModalTitle">
    <div class="modal-head">
      <div>
        <div class="panel-kicker">CONSOLE BINDINGS</div>
        <div class="panel-title" id="kbdModalTitle">Keyboard shortcuts</div>
      </div>
      <button class="btn btn-sm" id="closeKbdBtn" type="button">ESC</button>
    </div>
    <div class="kbd-list">
      <div class="kbd-item"><span>Switch views (Overview / Flags / Models / Installs)</span><span><span class="kbd">1</span> <span class="kbd">2</span> <span class="kbd">3</span> <span class="kbd">4</span></span></div>
      <div class="kbd-item"><span>Sync telemetry now</span><span class="kbd">R</span></div>
      <div class="kbd-item"><span>Toggle filter bar</span><span class="kbd">F</span></div>
      <div class="kbd-item"><span>Focus search in current view</span><span class="kbd">/</span></div>
      <div class="kbd-item"><span>Close drawer or modal</span><span class="kbd">ESC</span></div>
      <div class="kbd-item"><span>Toggle this help</span><span class="kbd">?</span></div>
    </div>
  </div>
</div>

<div class="toast-stack" id="toastStack" aria-live="polite"></div>

<script>
const C=['#00f0ff','#39ff9c','#ffb800','#b26bff','#ff3b6b','#38bdf8','#f472b6','#a3e635'];
const R=['#ff3b6b','#ffb800','#f472b6','#b26bff','#fb7185','#f97316'];
const charts={};
let _token='';
let _lastStats=null;
let _installs=[];
let _view='agg';
let _healthMode='installs';
let _autoRefresh=true;
let _installSort='requests';
let _installSortDir=-1;
let _installHealthFilter='all';
let _rangePreset='all';

function $(i){return document.getElementById(i)}
function fmt(n){return n==null?'—':Number(n).toLocaleString()}
function fmtCompact(n){
  n=Number(n||0);
  if(n>=1e9)return (Math.floor(n/1e8)/10)+'B';
  if(n>=1e6)return (Math.floor(n/1e5)/10)+'M';
  if(n>=1e3)return (Math.floor(n/1e2)/10)+'K';
  return n.toLocaleString();
}
function usd(n){return '$'+Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function relTime(iso){
  if(!iso)return '—';
  const ms=Date.parse(iso);
  if(!Number.isFinite(ms))return iso;
  const diff=Math.max(0,Math.floor((Date.now()-ms)/1000));
  if(diff<60)return diff+'s ago';
  if(diff<3600)return Math.floor(diff/60)+'m ago';
  if(diff<86400)return Math.floor(diff/3600)+'h ago';
  return Math.floor(diff/86400)+'d ago';
}
function fmtUptime(sec){
  sec=Number(sec||0);
  if(sec<0)return '—';
  if(sec<60)return sec+'s';
  if(sec<3600)return Math.floor(sec/60)+'m';
  const h=Math.floor(sec/3600);
  const m=Math.floor((sec%3600)/60);
  return h+'h '+m+'m';
}
function toast(msg,kind){
  const stack=$('toastStack');
  if(!stack)return;
  const el=document.createElement('div');
  el.className='toast'+(kind?' '+kind:'');
  el.textContent=msg;
  stack.appendChild(el);
  setTimeout(function(){el.remove();},3000);
}
function downloadFile(name,content,mime){
  const blob=new Blob([content],{type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download=name;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function csvEscape(v){
  const s=String(v==null?'':v);
  return /[",\\n\\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
}

function mkChart(id,type,labels,datasets,extraOpts){
  if(typeof Chart==='undefined')return;
  if(charts[id])charts[id].destroy();
  const canvas=$(id);
  const ctx=canvas&&canvas.getContext('2d');
  if(!ctx)return;
  const isPie=type==='doughnut'||type==='pie';
  const baseOpts={
    responsive:true,
    maintainAspectRatio:false,
    animation:{duration:260},
    plugins:{
      legend:{
        display:isPie||datasets.length>1,
        position:isPie?'right':'top',
        labels:{color:'#9fb8d4',boxWidth:10,padding:10,font:{family:"'JetBrains Mono',monospace",size:11}}
      },
      tooltip:{
        backgroundColor:'#0a111c',
        borderColor:'#00f0ff',
        borderWidth:1,
        titleColor:'#00f0ff',
        bodyColor:'#e6f1ff',
        titleFont:{family:"'JetBrains Mono',monospace",size:11},
        bodyFont:{family:"'JetBrains Mono',monospace",size:11}
      }
    },
    scales:isPie?undefined:{
      x:{ticks:{color:'#6d88a6',font:{family:"'JetBrains Mono',monospace",size:10}},grid:{color:'rgba(27,45,68,0.5)'}},
      y:{ticks:{color:'#6d88a6',font:{family:"'JetBrains Mono',monospace",size:10}},grid:{color:'rgba(27,45,68,0.5)'},beginAtZero:true}
    }
  };
  if(extraOpts&&extraOpts.scales)baseOpts.scales=extraOpts.scales;
  charts[id]=new Chart(ctx,{type:type,data:{labels:labels,datasets:datasets},options:baseOpts});
}

function setDashboardConnection(state,label){
  const el=$('dashboardConnection');
  if(!el)return;
  el.className='connection'+(state?' '+state:'');
  $('dashboardConnectionLabel').textContent=label;
  const disc=$('disconnectBtn');
  if(disc)disc.style.display=state==='connected'?'':'none';
}

function showErr(msg){
  const el=$('err');
  if(!el)return;
  el.textContent='ERROR :: '+msg;
  el.style.display='';
}
function hideErr(){
  const el=$('err');
  if(el)el.style.display='none';
}

function saveToken(t){
  _token=t;
  localStorage.setItem('st',t);
  localStorage.setItem('notif_token',t);
}
function clearToken(){
  _token='';
  localStorage.removeItem('st');
  localStorage.removeItem('notif_token');
  $('tok').value='';
  $('workspace').style.display='none';
  $('authStrip').classList.remove('collapsed');
  setDashboardConnection('','DISCONNECTED');
  toast('Disconnected','');
}

async function load(event){
  if(event)event.preventDefault();
  const t=$('tok').value.trim();
  if(!t)return;
  saveToken(t);
  setDashboardConnection('connecting','CONNECTING...');
  $('loadBtn').disabled=true;
  try{
    const ok=await go(currentFilters());
    if(ok){
      $('authStrip').classList.add('collapsed');
      toast('Connected to Control Room','ok');
    }
  }finally{$('loadBtn').disabled=false;}
}

function buildParams(f){
  const p=new URLSearchParams();
  if(f.installId)p.set('installId',f.installId);
  if(f.version)p.set('version',f.version);
  if(f.os)p.set('os',f.os);
  if(f.model)p.set('model',f.model);
  if(f.from)p.set('from',f.from);
  if(f.to)p.set('to',f.to);
  return p.toString();
}

function currentFilters(){
  const f={};
  const i=$('fInstall').value;if(i)f.installId=i;
  const v=$('fVersion').value;if(v)f.version=v;
  const o=$('fOS').value;if(o)f.os=o;
  const m=$('fModel').value;if(m)f.model=m;
  const fr=$('fFrom').value;if(fr)f.from=fr;
  const to=$('fTo').value;if(to)f.to=to;
  return f;
}

function updateFilterChips(f){
  const entries=Object.entries(f);
  const badge=$('filterCountBadge');
  if(entries.length){
    badge.style.display='';
    badge.textContent=String(entries.length);
    $('filterActive').textContent='Active: '+entries.map(function(e){return e[0]+'='+e[1];}).join(' | ');
  }else{
    badge.style.display='none';
    $('filterActive').textContent='No active filters';
  }
  const wrap=$('activeFilterChips');
  if(!entries.length){wrap.style.display='none';wrap.innerHTML='';return;}
  wrap.style.display='flex';
  wrap.innerHTML=entries.map(function(pair){
    return '<span class="filter-chip">'+esc(pair[0])+'='+esc(pair[1])+' <button type="button" data-clear-key="'+esc(pair[0])+'" aria-label="Remove filter">&times;</button></span>';
  }).join('')+'<button class="btn btn-sm" type="button" id="clearAllChipsBtn">CLEAR ALL</button>';
}

async function go(filters,manual){
  const qs=buildParams(filters);
  const url='/v1/stats'+(qs?'?'+qs:'');
  const rb=$('refreshBtn');
  if(rb)rb.disabled=true;
  try{
    const r=await fetch(url,{headers:{'Authorization':'Bearer '+_token}});
    if(r.status===401){
      $('workspace').style.display='none';
      $('authStrip').classList.remove('collapsed');
      setDashboardConnection('error','INVALID TOKEN');
      showErr('Unauthorized — check STATS_TOKEN');
      return false;
    }
    if(!r.ok){
      setDashboardConnection('error','HTTP '+r.status);
      showErr('Server error '+r.status);
      return false;
    }
    const d=await r.json();
    _lastStats=d;
    hideErr();
    $('workspace').style.display='block';
    $('ts').textContent='SYNC '+new Date().toLocaleTimeString();
    setDashboardConnection('connected','CONNECTED');
    updateFilterChips(filters);
    render(d);
    if(_view==='list')await loadInstalls();
    if(manual)toast('Telemetry synced','ok');
    return true;
  }catch(e){
    setDashboardConnection('error','OFFLINE');
    showErr(e.message||'Request failed');
    return false;
  }finally{if(rb)rb.disabled=false;}
}

function populateDropdowns(opts){
  const cur={install:$('fInstall').value,ver:$('fVersion').value,os:$('fOS').value,model:$('fModel').value};
  fillSelect('fInstall',opts.installIds||[],'All installs',cur.install);
  fillSelect('fVersion',opts.versions||[],'All versions',cur.ver);
  fillSelect('fOS',opts.os||[],'All OS',cur.os);
  fillSelect('fModel',opts.models||[],'All models',cur.model);
}
function fillSelect(id,items,placeholder,selected){
  const el=$(id);
  el.innerHTML='<option value="">'+placeholder+'</option>';
  items.forEach(function(it){
    const o=document.createElement('option');
    o.value=it;o.textContent=it;
    if(it===selected)o.selected=true;
    el.appendChild(o);
  });
}

function render(d){
  if(d.filterOptions)populateDropdowns(d.filterOptions);
  const fl=d.flags||{};
  const fleet=d.fleet||{};
  const tok=d.tokens||{totalInput:0,totalOutput:0,totalRequests:0};
  const sv=d.savings||{totalUsd:0,byModel:{}};

  const totalFlags=fl.totalFlags||0;
  const fBadge=$('flagsTabBadge');
  fBadge.textContent=String(totalFlags);
  fBadge.className='tab-count'+(totalFlags>0?' alert':'');
  $('installsTabBadge').textContent=String(d.uniqueInstalls||0);

  $('kpis').innerHTML=[
    {l:'Unique Installs',v:fmt(d.uniqueInstalls),sub:'24h: '+fmt(fleet.active24h||0)+' | 7d: '+fmt(fleet.active7d||0),c:'c-cyan'},
    {l:'Requests Routed',v:fmtCompact(d.totalRequestsAcrossAll),sub:fmt(d.totalRequestsAcrossAll)+' total | '+fmt(d.totalEvents)+' ev',c:'c-amber'},
    {l:'Estimated Savings',v:usd(sv.totalUsd),sub:Object.keys(sv.byModel||{}).length+' priced models',c:'c-green'},
    {l:'Token Volume',v:fmtCompact((tok.totalInput||0)+(tok.totalOutput||0)),sub:'IN '+fmtCompact(tok.totalInput)+' / OUT '+fmtCompact(tok.totalOutput),c:'c-violet'},
    {l:'Fleet Accounts',v:fmt(fleet.totalAccounts||0),sub:'P:'+fmt(fleet.proAccounts||0)+' F:'+fmt(fleet.freeAccounts||0)+(fleet.flaggedAccounts?' | FLG:'+fleet.flaggedAccounts:''),c:fleet.flaggedAccounts?'c-amber':'c-cyan'},
    {l:'Flag Signals',v:fmt(totalFlags),sub:fmt(fl.uniqueIncidents||0)+' unique | avg '+fmt(fl.avgRequestsBeforeFlag||0)+' req',c:totalFlags>0?'c-red':'c-green'}
  ].map(function(k){
    return '<article class="kpi '+k.c+'"><div class="kpi-label">'+esc(k.l)+'</div><div class="kpi-value">'+esc(k.v)+'</div><div class="kpi-sub">'+esc(k.sub)+'</div></article>';
  }).join('');

  const daily=d.daily||[];
  $('timelineSpan').textContent=daily.length?(daily[0].date+' -> '+daily[daily.length-1].date+' ('+daily.length+'d)'):'No daily data';
  mkChart('cTimeline','bar',daily.map(function(x){return x.date;}),[
    {type:'bar',label:'Active Installs',data:daily.map(function(x){return x.installs;}),backgroundColor:'rgba(0,240,255,0.45)',borderColor:'#00f0ff',borderWidth:1,yAxisID:'y'},
    {type:'line',label:'Flags',data:daily.map(function(x){return x.flags;}),borderColor:'#ff3b6b',backgroundColor:'rgba(255,59,107,0.2)',tension:0.25,pointRadius:3,yAxisID:'y1'}
  ],{
    scales:{
      x:{ticks:{color:'#6d88a6',font:{family:"'JetBrains Mono',monospace",size:10}},grid:{color:'rgba(27,45,68,0.45)'}},
      y:{position:'left',beginAtZero:true,ticks:{color:'#00f0ff',font:{family:"'JetBrains Mono',monospace",size:10}},grid:{color:'rgba(27,45,68,0.45)'}},
      y1:{position:'right',beginAtZero:true,ticks:{color:'#ff3b6b',font:{family:"'JetBrains Mono',monospace",size:10}},grid:{drawOnChartArea:false}}
    }
  });

  const healthSrc=_healthMode==='installs'&&(fleet.healthByInstall&&Object.keys(fleet.healthByInstall).length)?fleet.healthByInstall:(d.routingHealth||{});
  const verSrc=_healthMode==='installs'&&(fleet.versionByInstall&&Object.keys(fleet.versionByInstall).length)?fleet.versionByInstall:(d.versions||{});
  const osSrc=_healthMode==='installs'&&(fleet.osByInstall&&Object.keys(fleet.osByInstall).length)?fleet.osByInstall:(d.os||{});
  const healthColors=Object.keys(healthSrc).map(function(k){
    if(k==='healthy')return '#39ff9c';
    if(k==='cooldown_wait'||k==='busy')return '#ffb800';
    if(k==='paused'||k==='stopped')return '#ff3b6b';
    return '#6d88a6';
  });
  mkChart('cHealth','doughnut',Object.keys(healthSrc),[{data:Object.values(healthSrc),backgroundColor:healthColors,borderColor:'#0a111c',borderWidth:2}]);
  mkChart('cVersions','bar',Object.keys(verSrc),[{label:_healthMode==='installs'?'Installs':'Events',data:Object.values(verSrc),backgroundColor:'rgba(0,240,255,0.6)',borderColor:'#00f0ff',borderWidth:1}]);
  mkChart('cOS','doughnut',Object.keys(osSrc),[{data:Object.values(osSrc),backgroundColor:C,borderColor:'#0a111c',borderWidth:2}]);

  $('flagKpis').innerHTML=[
    {l:'Total Flags',v:fmt(totalFlags),c:'c-red'},
    {l:'Unique Signatures',v:fmt(fl.uniqueIncidents||0),c:'c-amber'},
    {l:'Pro / Free Split',v:fmt(fl.onProAccounts||0)+' / '+fmt(fl.onFreeAccounts||0),c:'c-violet'},
    {l:'Avg Req Before Flag',v:fmt(fl.avgRequestsBeforeFlag||0),c:'c-cyan'}
  ].map(function(k){
    return '<article class="kpi '+k.c+'"><div class="kpi-label">'+esc(k.l)+'</div><div class="kpi-value">'+esc(k.v)+'</div></article>';
  }).join('');
  mkChart('cFlagReasons','bar',Object.keys(fl.byReasonCode||{}),[{label:'Flags',data:Object.values(fl.byReasonCode||{}),backgroundColor:R}]);
  mkChart('cPatterns','bar',Object.keys(fl.byPattern||{}),[{label:'Matches',data:Object.values(fl.byPattern||{}),backgroundColor:R}]);
  mkChart('cFlagModels','doughnut',Object.keys(fl.byModel||{}),[{data:Object.values(fl.byModel||{}),backgroundColor:C,borderColor:'#0a111c',borderWidth:2}]);
  mkChart('cTimerType','doughnut',Object.keys(fl.byTimerType||{}),[{data:Object.values(fl.byTimerType||{}),backgroundColor:['#00f0ff','#ffb800','#39ff9c','#ff3b6b'],borderColor:'#0a111c',borderWidth:2}]);
  renderFlagIncidents();

  $('savTotal').textContent=usd(sv.totalUsd);
  const totTok=(tok.totalInput||0)+(tok.totalOutput||0);
  const inPct=totTok>0?Math.round(((tok.totalInput||0)/totTok)*1000)/10:50;
  const outPct=totTok>0?Math.round(((tok.totalOutput||0)/totTok)*1000)/10:50;
  $('dashRatioIn').style.width=inPct+'%';
  $('dashRatioOut').style.width=outPct+'%';
  $('dashInTok').textContent='IN '+inPct+'% ('+fmtCompact(tok.totalInput)+')';
  $('dashOutTok').textContent='OUT '+outPct+'% ('+fmtCompact(tok.totalOutput)+')';
  mkChart('cModels','doughnut',Object.keys(d.modelsUsed||{}),[{data:Object.values(d.modelsUsed||{}),backgroundColor:C,borderColor:'#0a111c',borderWidth:2}]);
  mkChart('cFeatures','bar',Object.keys(d.featuresUsed||{}),[{label:'Events',data:Object.values(d.featuresUsed||{}),backgroundColor:'rgba(178,107,255,0.65)',borderColor:'#b26bff',borderWidth:1}]);
  renderModelTables();
}

function renderFlagIncidents(){
  const wrap=$('flagIncidents');
  const all=(_lastStats&&_lastStats.flags&&_lastStats.flags.recentIncidents)||[];
  const q=(($('flagSearch')||{}).value||'').trim().toLowerCase();
  const list=all.map(function(item,idx){return {item:item,idx:idx};}).filter(function(entry){
    if(!q)return true;
    const i=entry.item;
    return [i.flagReasonCode,i.flagReasonMessage,i.model,i.installId,String(i.flagHttpStatus),(i.flagPatternsMatched||[]).join(' ')].join(' ').toLowerCase().indexOf(q)!==-1;
  });
  if(!list.length){
    wrap.innerHTML='<div class="empty">'+(all.length?'No flag incidents match that query.':'No flag incidents recorded in this cohort.')+'</div>';
    return;
  }
  wrap.innerHTML='<div class="table-wrap"><table><thead><tr><th>When</th><th>Install</th><th>HTTP</th><th>Provider Reason</th><th>Message</th><th>Model</th><th>Vel/hr</th></tr></thead><tbody>'+
    list.map(function(entry){
      const i=entry.item;
      const shortId=(i.installId||'—').slice(0,8);
      const httpCls=i.flagHttpStatus===403?'red':'amber';
      return '<tr class="click-row" data-flag-idx="'+entry.idx+'">'+
        '<td class="mono" title="'+esc(i.receivedAt||i.ts||'')+'">'+esc(relTime(i.receivedAt||i.ts))+'</td>'+
        '<td class="mono" style="color:var(--cyan)">'+esc(shortId)+'</td>'+
        '<td><span class="pill-tag '+httpCls+'">'+esc(i.flagHttpStatus||'—')+'</span></td>'+
        '<td class="mono" style="color:var(--amber)">'+esc(i.flagReasonCode||'UNKNOWN')+'</td>'+
        '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(i.flagReasonMessage||'')+'">'+esc(i.flagReasonMessage||'—')+'</td>'+
        '<td class="mono" style="color:var(--green)">'+esc(i.model||'—')+'</td>'+
        '<td class="mono">'+esc(i.accountRequestsLastHour!=null?i.accountRequestsLastHour:'—')+'</td>'+
      '</tr>';
    }).join('')+
  '</tbody></table></div>';
}

function openFlagDrawer(idx){
  const list=(_lastStats&&_lastStats.flags&&_lastStats.flags.recentIncidents)||[];
  const i=list[idx];
  if(!i)return;
  $('drawerKicker').textContent='FLAG FORENSICS // HTTP '+String(i.flagHttpStatus||'?');
  $('drawerTitle').textContent=i.flagReasonCode||'UNKNOWN';
  const patterns=(i.flagPatternsMatched||[]).length
    ? i.flagPatternsMatched.map(function(p){return '<span class="pill-tag red">'+esc(p)+'</span>';}).join(' ')
    : '<span class="sync-note">None matched</span>';
  $('drawerBody').innerHTML=
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">'+
      '<button class="btn btn-cyber btn-sm" type="button" data-drill-id="'+esc(i.installId||'')+'">FILTER THIS INSTALL &rarr;</button>'+
      '<button class="btn btn-sm" type="button" data-copy-text="'+esc(i.installId||'')+'">COPY INSTALL ID</button>'+
    '</div>'+
    (i.flagReasonMessage?'<div class="panel" style="padding:12px;border-color:rgba(255,59,107,.4)"><div class="panel-kicker" style="color:var(--red)">PROVIDER MESSAGE</div><div class="mono" style="margin-top:6px;font-size:13px">'+esc(i.flagReasonMessage)+'</div></div>':'')+
    '<div class="detail-grid">'+
      '<div class="detail-cell"><span>Install ID</span><strong>'+esc(i.installId||'—')+'</strong></div>'+
      '<div class="detail-cell"><span>Timestamp</span><strong>'+esc(i.receivedAt||i.ts||'—')+'</strong></div>'+
      '<div class="detail-cell"><span>Model</span><strong style="color:var(--green)">'+esc(i.model||'—')+'</strong></div>'+
      '<div class="detail-cell"><span>Version / Timer</span><strong>v'+esc(i.version||'?')+' / '+esc(i.timerType||'?')+'</strong></div>'+
      '<div class="detail-cell"><span>Account Tier</span><strong>'+(i.wasProAccount?'PRO':'FREE')+'</strong></div>'+
      '<div class="detail-cell"><span>Quota at Flag</span><strong>'+(i.accountQuotaPercent>=0?i.accountQuotaPercent+'%':'—')+'</strong></div>'+
      '<div class="detail-cell"><span>Velocity (last hr)</span><strong style="color:var(--amber)">'+fmt(i.accountRequestsLastHour)+' req/hr</strong></div>'+
      '<div class="detail-cell"><span>Concurrent at Flag</span><strong>'+fmt(i.accountConcurrentAtFlag)+'</strong></div>'+
      '<div class="detail-cell"><span>Lifetime Requests</span><strong>'+fmt(i.accountTotalRequests)+'</strong></div>'+
      '<div class="detail-cell"><span>Pool Health</span><strong>'+fmt(i.poolHealthyCount)+' / '+fmt(i.poolSize)+' healthy</strong></div>'+
      '<div class="detail-cell"><span>Protective Pause</span><strong style="color:'+(i.protectivePauseTriggered?'var(--green)':'var(--muted)')+'">'+(i.protectivePauseTriggered?'TRIGGERED':'NO')+'</strong></div>'+
      '<div class="detail-cell"><span>Uptime / Since Prev</span><strong>'+esc(fmtUptime(i.uptimeSeconds))+' / '+esc(i.timeSinceLastFlagSeconds>=0?fmtUptime(i.timeSinceLastFlagSeconds):'first')+'</strong></div>'+
    '</div>'+
    '<div><div class="panel-kicker" style="margin-bottom:8px">MATCHED PATTERNS</div><div style="display:flex;gap:6px;flex-wrap:wrap">'+patterns+'</div></div>';
  openDrawer();
}

function renderModelTables(){
  if(!_lastStats)return;
  const q=(($('modelSearch')||{}).value||'').trim().toLowerCase();
  const svMap=(_lastStats.savings&&_lastStats.savings.byModel)||{};
  const svEntries=Object.entries(svMap).filter(function(e){return !q||e[0].toLowerCase().indexOf(q)!==-1;})
    .sort(function(a,b){return (b[1].totalUsd||0)-(a[1].totalUsd||0);});
  const maxUsd=Math.max.apply(null,svEntries.map(function(e){return e[1].totalUsd||0;}).concat([0.01]));
  $('savTable').innerHTML=svEntries.length
    ? '<div class="table-wrap"><table><thead><tr><th>Model</th><th>Input USD</th><th>Output USD</th><th>Total Saved</th><th>Share</th></tr></thead><tbody>'+
      svEntries.map(function(pair){
        const m=pair[0],v=pair[1];
        const pct=Math.max(3,Math.round(((v.totalUsd||0)/maxUsd)*100));
        return '<tr><td class="mono" style="color:var(--cyan)">'+esc(m)+'</td><td class="mono">'+usd(v.inputUsd)+'</td><td class="mono">'+usd(v.outputUsd)+'</td><td class="mono" style="color:var(--green);font-weight:800">'+usd(v.totalUsd)+'</td><td style="width:130px"><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div></td></tr>';
      }).join('')+'</tbody></table></div>'
    : '<div class="empty">No savings data for this filter.</div>';

  const tkMap=_lastStats.tokensByModel||{};
  const tkEntries=Object.entries(tkMap).filter(function(e){return !q||e[0].toLowerCase().indexOf(q)!==-1;})
    .sort(function(a,b){return ((b[1].input||0)+(b[1].output||0))-((a[1].input||0)+(a[1].output||0));});
  $('tokTable').innerHTML=tkEntries.length
    ? '<div class="table-wrap"><table><thead><tr><th>Model</th><th>Input Tokens</th><th>Output Tokens</th><th>Total Tokens</th><th>Requests</th></tr></thead><tbody>'+
      tkEntries.map(function(pair){
        const m=pair[0],v=pair[1];
        const tot=(v.input||0)+(v.output||0);
        return '<tr><td class="mono" style="color:var(--cyan)">'+esc(m)+'</td><td class="mono">'+fmt(v.input)+'</td><td class="mono">'+fmt(v.output)+'</td><td class="mono" style="font-weight:700">'+fmtCompact(tot)+'</td><td class="mono" style="color:var(--amber)">'+fmt(v.requests)+'</td></tr>';
      }).join('')+'</tbody></table></div>'
    : '<div class="empty">No token usage data for this filter.</div>';
}

function switchView(view){
  _view=view;
  document.querySelectorAll('.view-tab').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-view')===view);
  });
  ['agg','flags','models'].forEach(function(v){
    const pane=$('pane-'+v);
    if(pane)pane.classList.toggle('active',view===v);
  });
  $('installsView').classList.toggle('active',view==='list');
  if(view==='list'){
    loadInstalls();
  }else{
    setTimeout(function(){
      Object.values(charts).forEach(function(ch){try{ch.resize();}catch(e){}});
    },40);
  }
}

async function loadInstalls(){
  if(!_token)return;
  try{
    const qs=buildParams(currentFilters());
    const r=await fetch('/v1/installs'+(qs?'?'+qs:''),{headers:{'Authorization':'Bearer '+_token}});
    if(!r.ok){showErr('Failed to load installs: HTTP '+r.status);return;}
    _installs=await r.json();
    $('installCount').textContent=_installs.length+' NODES';
    $('installsTabBadge').textContent=String(_installs.length);
    renderInstallList();
  }catch(e){showErr(e.message);}
}

function setInstallSort(col){
  if(_installSort===col){_installSortDir=-_installSortDir;}
  else{_installSort=col;_installSortDir=-1;}
  ['requests','savings','accounts','flags','lastseen'].forEach(function(c){
    const b=$('isort-'+c);
    if(b)b.classList.toggle('active',c===_installSort);
  });
  renderInstallList();
}

function getFilteredInstalls(){
  const q=(($('installSearch')||{}).value||'').trim().toLowerCase();
  const rows=_installs.filter(function(r){
    if(_installHealthFilter==='healthy'&&r.routingHealthState!=='healthy')return false;
    if(_installHealthFilter==='degraded'&&r.routingHealthState==='healthy')return false;
    if(_installHealthFilter==='flagged'&&!(r.flagEvents>0||r.flaggedCount>0))return false;
    if(!q)return true;
    return [r.installId,r.version,r.os,r.arch,r.routingHealthState].join(' ').toLowerCase().indexOf(q)!==-1;
  });
  rows.sort(function(a,b){
    let av=0,bv=0;
    if(_installSort==='requests'){av=a.totalRequests;bv=b.totalRequests;}
    else if(_installSort==='savings'){av=a.savingsUsd;bv=b.savingsUsd;}
    else if(_installSort==='accounts'){av=a.accountCount;bv=b.accountCount;}
    else if(_installSort==='flags'){av=a.flagEvents;bv=b.flagEvents;}
    else if(_installSort==='lastseen'){av=a.lastSeen||'';bv=b.lastSeen||'';}
    if(av<bv)return _installSortDir;
    if(av>bv)return -_installSortDir;
    return 0;
  });
  return rows;
}

function renderInstallList(){
  const wrap=$('installTableWrap');
  if(!wrap)return;
  const rows=getFilteredInstalls();
  if(!rows.length){wrap.innerHTML='<div class="empty">No matching installations found.</div>';return;}
  const maxReq=Math.max.apply(null,rows.map(function(r){return r.totalRequests||0;}).concat([1]));
  const HC={healthy:'#39ff9c',cooldown_wait:'#ffb800',busy:'#00f0ff',paused:'#ff3b6b',stopped:'#ff3b6b'};
  function arr(c){return _installSort===c?(_installSortDir===-1?' &#8595;':' &#8593;'):'';}
  wrap.innerHTML='<div class="table-wrap"><table><thead><tr>'+
    '<th>Install ID</th>'+
    '<th class="sort-th'+(_installSort==='requests'?' active':'')+'" data-sort="requests">Requests'+arr('requests')+'</th>'+
    '<th class="sort-th'+(_installSort==='accounts'?' active':'')+'" data-sort="accounts">Accounts'+arr('accounts')+'</th>'+
    '<th class="sort-th'+(_installSort==='savings'?' active':'')+'" data-sort="savings">Savings'+arr('savings')+'</th>'+
    '<th class="sort-th'+(_installSort==='flags'?' active':'')+'" data-sort="flags">Flags'+arr('flags')+'</th>'+
    '<th>Health</th>'+
    '<th>Version / OS</th>'+
    '<th class="sort-th'+(_installSort==='lastseen'?' active':'')+'" data-sort="lastseen">Last Seen'+arr('lastseen')+'</th>'+
    '<th></th>'+
  '</tr></thead><tbody>'+
  rows.map(function(r){
    const hc=HC[r.routingHealthState]||'#6d88a6';
    const pct=Math.max(3,Math.round(((r.totalRequests||0)/maxReq)*100));
    const acctSub='P:'+r.proCount+' F:'+r.freeCount+(r.flaggedCount?' <span style="color:var(--red)">FLG:'+r.flaggedCount+'</span>':'');
    return '<tr class="click-row" data-install-id="'+esc(r.installId)+'">'+
      '<td class="mono"><strong style="color:var(--cyan)">'+esc(r.installId.slice(0,8))+'</strong><span style="color:var(--muted)">'+esc(r.installId.slice(8,14))+'…</span></td>'+
      '<td><div class="mini-bar"><span class="mono" style="font-weight:700">'+fmtCompact(r.totalRequests)+'</span><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div></div></td>'+
      '<td class="mono">'+esc(r.accountCount)+'<div style="font-size:11px;color:var(--muted)">'+acctSub+'</div></td>'+
      '<td class="mono" style="color:var(--green);font-weight:700">'+usd(r.savingsUsd)+'</td>'+
      '<td class="mono" style="color:'+(r.flagEvents>0?'var(--red)':'var(--muted)')+';font-weight:700">'+esc(r.flagEvents)+'</td>'+
      '<td class="mono" style="color:'+hc+'"><span class="health-dot" style="background:'+hc+'"></span>'+esc(r.routingHealthState||'?')+'</td>'+
      '<td class="mono"><span style="color:var(--cyan)">v'+esc(r.version)+'</span> <span style="color:var(--muted)">'+esc(r.os)+'/'+esc(r.arch)+'</span></td>'+
      '<td class="mono" style="color:var(--text-2)" title="'+esc(r.lastSeen||'')+'">'+esc(relTime(r.lastSeen))+'</td>'+
      '<td><button class="btn btn-sm" type="button" data-drill-id="'+esc(r.installId)+'">FILTER &rarr;</button></td>'+
    '</tr>';
  }).join('')+'</tbody></table></div>';
}

function openInstallDrawer(installId){
  const r=_installs.find(function(x){return x.installId===installId;});
  if(!r)return;
  $('drawerKicker').textContent='NODE INSPECTOR // v'+String(r.version||'?');
  $('drawerTitle').textContent=r.installId.slice(0,16)+'…';
  const feats=Object.entries(r.featuresUsed||{}).filter(function(e){return e[1];}).map(function(e){
    return '<span class="pill-tag violet">'+esc(e[0])+'</span>';
  }).join(' ')||'<span class="sync-note">No feature flags reported</span>';
  const modRows=Object.entries(r.tokensByModel||{}).sort(function(a,b){
    return ((b[1].input||0)+(b[1].output||0))-((a[1].input||0)+(a[1].output||0));
  }).map(function(pair){
    const m=pair[0],v=pair[1];
    return '<tr><td class="mono" style="color:var(--cyan)">'+esc(m)+'</td><td class="mono">'+fmtCompact(v.input)+'</td><td class="mono">'+fmtCompact(v.output)+'</td><td class="mono">'+fmt(v.requests)+'</td></tr>';
  }).join('');
  $('drawerBody').innerHTML=
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
      '<button class="btn btn-cyber btn-sm" type="button" data-drill-id="'+esc(r.installId)+'">DRILL INTO TELEMETRY &rarr;</button>'+
      '<button class="btn btn-sm" type="button" data-copy-text="'+esc(r.installId)+'">COPY FULL UUID</button>'+
    '</div>'+
    '<div class="detail-grid">'+
      '<div class="detail-cell"><span>Install ID</span><strong>'+esc(r.installId)+'</strong></div>'+
      '<div class="detail-cell"><span>Routing Health</span><strong>'+esc(r.routingHealthState)+'</strong></div>'+
      '<div class="detail-cell"><span>Platform</span><strong>'+esc(r.os)+' / '+esc(r.arch)+' (v'+esc(r.version)+')</strong></div>'+
      '<div class="detail-cell"><span>Requests / Savings</span><strong style="color:var(--green)">'+fmt(r.totalRequests)+' req / '+usd(r.savingsUsd)+'</strong></div>'+
      '<div class="detail-cell"><span>Accounts</span><strong>'+fmt(r.accountCount)+' (P:'+fmt(r.proCount)+' F:'+fmt(r.freeCount)+' FLG:'+fmt(r.flaggedCount)+' DIS:'+fmt(r.disabledCount)+')</strong></div>'+
      '<div class="detail-cell"><span>Flag Events</span><strong style="color:'+(r.flagEvents>0?'var(--red)':'var(--green)')+'">'+fmt(r.flagEvents)+'</strong></div>'+
      '<div class="detail-cell"><span>First Seen</span><strong>'+esc(r.firstSeen?new Date(r.firstSeen).toLocaleString():'—')+'</strong></div>'+
      '<div class="detail-cell"><span>Last Seen</span><strong>'+esc(r.lastSeen?new Date(r.lastSeen).toLocaleString():'—')+' ('+esc(relTime(r.lastSeen))+')</strong></div>'+
    '</div>'+
    '<div><div class="panel-kicker" style="margin-bottom:8px">FEATURES ENABLED</div><div style="display:flex;gap:6px;flex-wrap:wrap">'+feats+'</div></div>'+
    '<div><div class="panel-kicker" style="margin-bottom:8px">MODEL USAGE</div>'+(modRows?'<div class="table-wrap"><table><thead><tr><th>Model</th><th>In</th><th>Out</th><th>Req</th></tr></thead><tbody>'+modRows+'</tbody></table></div>':'<div class="empty">No token breakdown</div>')+'</div>';
  openDrawer();
}

function openDrawer(){
  const w=$('detailDrawerWrap');
  w.classList.add('open');
  w.setAttribute('aria-hidden','false');
}
function closeDrawer(){
  const w=$('detailDrawerWrap');
  w.classList.remove('open');
  w.setAttribute('aria-hidden','true');
}
function openKbdModal(){
  const m=$('kbdModal');
  m.classList.add('open');
  m.setAttribute('aria-hidden','false');
}
function closeKbdModal(){
  const m=$('kbdModal');
  m.classList.remove('open');
  m.setAttribute('aria-hidden','true');
}

function drillDown(installId){
  closeDrawer();
  switchView('agg');
  const sel=$('fInstall');
  if(sel){
    if(!Array.from(sel.options).some(function(o){return o.value===installId;})){
      const o=document.createElement('option');o.value=installId;o.textContent=installId;sel.appendChild(o);
    }
    sel.value=installId;
  }
  go(currentFilters(),true);
}

function applyRangePreset(range){
  _rangePreset=range;
  document.querySelectorAll('.preset-btn').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-range')===range);
  });
  if(range==='all'){
    $('fFrom').value='';
    $('fTo').value='';
  }else{
    const days=Number(range);
    const now=new Date();
    const from=new Date(now.getTime()-days*24*60*60*1000);
    $('fFrom').value=from.toISOString().slice(0,10);
    $('fTo').value=now.toISOString().slice(0,10);
  }
  go(currentFilters(),false);
}

$('dashboardAuthForm').addEventListener('submit',load);
$('disconnectBtn').addEventListener('click',clearToken);
$('dashboardConnection').addEventListener('click',function(){
  $('authStrip').classList.toggle('collapsed');
});
$('toggleTokVis').addEventListener('click',function(){
  const inp=$('tok');
  const show=inp.type==='password';
  inp.type=show?'text':'password';
  this.textContent=show?'HIDE':'SHOW';
});
$('refreshBtn').addEventListener('click',function(){if(_token)go(currentFilters(),true);});
$('autoBtn').addEventListener('click',function(){
  _autoRefresh=!_autoRefresh;
  this.textContent='AUTO: '+(_autoRefresh?'ON':'OFF');
  toast('Auto-sync '+(_autoRefresh?'enabled (60s)':'paused'),'');
});
$('helpBtn').addEventListener('click',openKbdModal);
$('closeKbdBtn').addEventListener('click',closeKbdModal);
$('kbdModal').addEventListener('click',function(e){if(e.target===this)closeKbdModal();});
$('closeDrawerBtn').addEventListener('click',closeDrawer);
$('detailDrawerWrap').addEventListener('click',function(e){if(e.target===this)closeDrawer();});

$('viewTabs').addEventListener('click',function(e){
  const btn=e.target.closest('.view-tab');
  if(btn)switchView(btn.getAttribute('data-view'));
});
document.querySelectorAll('.preset-btn').forEach(function(btn){
  btn.addEventListener('click',function(){applyRangePreset(btn.getAttribute('data-range'));});
});
$('toggleFilterBtn').addEventListener('click',function(){$('filterBar').classList.toggle('open');});
$('applyFiltersBtn').addEventListener('click',function(){go(currentFilters(),true);});
$('clearFiltersBtn').addEventListener('click',function(){
  ['fInstall','fVersion','fOS','fModel','fFrom','fTo'].forEach(function(id){$(id).value='';});
  applyRangePreset('all');
});
$('activeFilterChips').addEventListener('click',function(e){
  if(e.target.id==='clearAllChipsBtn'){$('clearFiltersBtn').click();return;}
  const key=e.target.getAttribute('data-clear-key');
  if(!key)return;
  const map={installId:'fInstall',version:'fVersion',os:'fOS',model:'fModel',from:'fFrom',to:'fTo'};
  if(map[key])$(map[key]).value='';
  go(currentFilters(),false);
});
$('healthModeBtn').addEventListener('click',function(){
  _healthMode=_healthMode==='installs'?'events':'installs';
  this.textContent=_healthMode==='installs'?'BY INSTALLS':'BY EVENTS';
  if(_lastStats)render(_lastStats);
});
$('flagSearch').addEventListener('input',renderFlagIncidents);
$('modelSearch').addEventListener('input',renderModelTables);
$('installSearch').addEventListener('input',renderInstallList);

$('flagIncidents').addEventListener('click',function(e){
  const row=e.target.closest('[data-flag-idx]');
  if(row)openFlagDrawer(Number(row.getAttribute('data-flag-idx')));
});
$('installTableWrap').addEventListener('click',function(e){
  const drill=e.target.closest('[data-drill-id]');
  if(drill){e.stopPropagation();drillDown(drill.getAttribute('data-drill-id'));return;}
  const sortTh=e.target.closest('[data-sort]');
  if(sortTh){setInstallSort(sortTh.getAttribute('data-sort'));return;}
  const row=e.target.closest('[data-install-id]');
  if(row)openInstallDrawer(row.getAttribute('data-install-id'));
});
$('drawerBody').addEventListener('click',function(e){
  const drill=e.target.closest('[data-drill-id]');
  if(drill){drillDown(drill.getAttribute('data-drill-id'));return;}
  const cp=e.target.closest('[data-copy-text]');
  if(cp){
    navigator.clipboard?.writeText(cp.getAttribute('data-copy-text')).then(function(){
      toast('Copied to clipboard','ok');
    });
  }
});
document.querySelectorAll('#installsView [data-health]').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('#installsView [data-health]').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active');
    _installHealthFilter=btn.getAttribute('data-health')||'all';
    renderInstallList();
  });
});
document.querySelectorAll('#installsView [data-sort]').forEach(function(btn){
  btn.addEventListener('click',function(){setInstallSort(btn.getAttribute('data-sort'));});
});

$('exportJsonBtn').addEventListener('click',function(){
  if(!_lastStats)return;
  downloadFile('telemetry-stats-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(_lastStats,null,2),'application/json');
  toast('Exported stats JSON','ok');
});
$('exportModelsCsvBtn').addEventListener('click',function(){
  if(!_lastStats)return;
  const sv=(_lastStats.savings&&_lastStats.savings.byModel)||{};
  const tk=_lastStats.tokensByModel||{};
  const models=Array.from(new Set(Object.keys(tk).concat(Object.keys(sv)))).sort();
  const lines=['model,input_tokens,output_tokens,requests,input_usd,output_usd,total_usd'];
  models.forEach(function(m){
    const t=tk[m]||{input:0,output:0,requests:0};
    const s=sv[m]||{inputUsd:0,outputUsd:0,totalUsd:0};
    lines.push([m,t.input,t.output,t.requests,s.inputUsd,s.outputUsd,s.totalUsd].map(csvEscape).join(','));
  });
  downloadFile('telemetry-models-'+new Date().toISOString().slice(0,10)+'.csv',lines.join('\\n'),'text/csv');
  toast('Exported models CSV','ok');
});
$('exportInstallsCsvBtn').addEventListener('click',function(){
  const rows=getFilteredInstalls();
  const lines=['install_id,version,os,arch,requests,accounts,pro,free,flagged,savings_usd,flag_events,health,last_seen'];
  rows.forEach(function(r){
    lines.push([r.installId,r.version,r.os,r.arch,r.totalRequests,r.accountCount,r.proCount,r.freeCount,r.flaggedCount,r.savingsUsd,r.flagEvents,r.routingHealthState,r.lastSeen].map(csvEscape).join(','));
  });
  downloadFile('telemetry-installs-'+new Date().toISOString().slice(0,10)+'.csv',lines.join('\\n'),'text/csv');
  toast('Exported installs CSV','ok');
});

document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){closeDrawer();closeKbdModal();return;}
  if(e.target&&/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
  if(e.key==='?'){e.preventDefault();openKbdModal();return;}
  if(!_token)return;
  if(e.key==='1'){switchView('agg');}
  else if(e.key==='2'){switchView('flags');}
  else if(e.key==='3'){switchView('models');}
  else if(e.key==='4'){switchView('list');}
  else if(e.key==='r'||e.key==='R'){e.preventDefault();go(currentFilters(),true);}
  else if(e.key==='f'||e.key==='F'){e.preventDefault();$('filterBar').classList.toggle('open');}
  else if(e.key==='/'){
    e.preventDefault();
    const target=_view==='list'?$('installSearch'):_view==='flags'?$('flagSearch'):_view==='models'?$('modelSearch'):null;
    if(target)target.focus();
  }
});

const saved=localStorage.getItem('st')||localStorage.getItem('notif_token');
if(saved){
  _token=saved;
  $('tok').value=saved;
  setDashboardConnection('connecting','CONNECTING...');
  go({}).then(function(ok){if(ok)$('authStrip').classList.add('collapsed');});
}
setInterval(function(){if(_token&&_autoRefresh)go(currentFilters(),false);},60000);
</script>
</body></html>`;
}

// ── Notifications Admin UI ───────────────────────────────────────────
function buildNotificationsAdminHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>TUXEVIL // Notification Manager</title>
<style>
${buildSharedCyberCss()}
.auth-panel{margin-bottom:18px;border-color:rgba(0,240,255,.35)}
.auth-panel.collapsed{display:none}
.auth-row{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
.auth-title{font-family:var(--mono);font-size:17px;font-weight:800;color:#fff;margin-top:4px}
.auth-note{font-size:13px;color:var(--text-2);margin-top:3px}
.token-form{display:flex;gap:8px;flex:1;min-width:min(100%,380px);max-width:560px}
.token-form input{flex:1;min-width:0;font-family:var(--mono)}
.flash{
  border-radius:5px;padding:11px 14px;margin-bottom:14px;
  font-family:var(--mono);font-size:13px;
}
.flash.error{background:var(--red-dim);border:1px solid rgba(255,59,107,.45);color:var(--red)}
.flash.success{background:var(--green-dim);border:1px solid rgba(57,255,156,.4);color:var(--green)}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}
.workspace{display:grid;grid-template-columns:minmax(0,1.22fr) minmax(320px,.78fr);gap:14px;align-items:start;margin-bottom:16px}
.templates-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.templates-label{font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-right:4px}
.sev-group{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.sev-btn{
  padding:9px 10px;border-radius:5px;border:1px solid var(--line-hi);
  background:#060b12;font-family:var(--mono);font-size:12px;font-weight:700;
  color:var(--text-2);text-align:center;transition:all .15s;
}
.sev-btn:hover{border-color:var(--cyan);color:#fff}
.sev-btn.active[data-sev="info"]{border-color:var(--cyan);background:var(--cyan-dim);color:var(--cyan);box-shadow:0 0 12px rgba(0,240,255,.15)}
.sev-btn.active[data-sev="warning"]{border-color:var(--amber);background:var(--amber-dim);color:var(--amber);box-shadow:0 0 12px rgba(255,184,0,.15)}
.sev-btn.active[data-sev="critical"]{border-color:var(--red);background:var(--red-dim);color:var(--red);box-shadow:0 0 12px rgba(255,59,107,.18)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 12px}
.form-group{display:flex;flex-direction:column;gap:6px;min-width:0}
.form-group.full{grid-column:1/-1}
.form-group label{
  font-family:var(--mono);font-size:11px;font-weight:700;
  color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;
  display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.hint{color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0}
.form-group input,.form-group textarea,.form-group select{width:100%;min-width:0}
.form-group textarea{min-height:110px;resize:vertical;line-height:1.55}
.expiry-presets{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}
.preset-mini{
  padding:3px 7px;border-radius:4px;border:1px solid var(--line);
  background:var(--bg-2);font-family:var(--mono);font-size:11px;color:var(--text-2);
}
.preset-mini:hover{border-color:var(--cyan);color:var(--cyan)}
.field-meta{display:flex;justify-content:space-between;align-items:center;gap:10px;font-family:var(--mono);font-size:11px;color:var(--muted)}
.char-bar{height:3px;background:var(--line);border-radius:2px;overflow:hidden;flex:1;max-width:140px}
.char-bar-fill{height:100%;background:var(--cyan);width:0%;transition:width .15s}
.form-divider{
  grid-column:1/-1;display:flex;align-items:center;gap:10px;
  font-family:var(--mono);font-size:11px;font-weight:700;color:var(--cyan);
  letter-spacing:.1em;text-transform:uppercase;margin-top:4px;
}
.form-divider::after{content:'';height:1px;background:var(--line);flex:1}
.form-actions{grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}
.url-status{font-family:var(--mono);font-size:11px}
.url-status.ok{color:var(--green)}
.url-status.bad{color:var(--red)}
.preview-panel{position:sticky;top:76px}
.preview-shell{
  background:#04080f;border:1px solid var(--line-hi);border-radius:6px;padding:10px;
}
.preview-chrome{
  display:flex;align-items:center;gap:6px;padding:2px 4px 10px;
  font-family:var(--mono);font-size:11px;color:var(--muted);
}
.preview-chrome i{width:7px;height:7px;border-radius:50%;background:var(--line-hi)}
.preview-chrome span{margin-left:4px}
.preview-card{
  border-radius:5px;padding:16px;display:flex;align-items:flex-start;gap:12px;
  min-height:138px;transition:all .15s;
}
.preview-card.p-info{background:linear-gradient(145deg, rgba(0,240,255,.12), rgba(10,17,28,.95));border:1px solid rgba(0,240,255,.45)}
.preview-card.p-warning{background:linear-gradient(145deg, rgba(255,184,0,.13), rgba(22,18,8,.95));border:1px solid rgba(255,184,0,.48)}
.preview-card.p-critical{background:linear-gradient(145deg, rgba(255,59,107,.15), rgba(28,10,16,.95));border:1px solid rgba(255,59,107,.5)}
.preview-icon{
  width:28px;height:28px;border-radius:4px;display:grid;place-items:center;
  font-family:var(--mono);font-size:13px;font-weight:800;flex-shrink:0;
}
.p-info .preview-icon{background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(0,240,255,.4)}
.p-warning .preview-icon{background:var(--amber-dim);color:var(--amber);border:1px solid rgba(255,184,0,.45)}
.p-critical .preview-icon{background:var(--red-dim);color:var(--red);border:1px solid rgba(255,59,107,.48)}
.preview-content{flex:1;min-width:0}
.preview-eyebrow{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.preview-title{font-family:var(--mono);font-size:15px;font-weight:800;line-height:1.3;margin-bottom:6px;overflow-wrap:anywhere}
.p-info .preview-title{color:var(--cyan)}
.p-warning .preview-title{color:var(--amber)}
.p-critical .preview-title{color:var(--red)}
.preview-msg{font-size:13px;color:var(--text-2);line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.preview-action{
  display:inline-flex;margin-top:12px;padding:6px 12px;border-radius:4px;
  font-family:var(--mono);font-size:12px;font-weight:700;text-decoration:none!important;
  border:1px solid rgba(255,255,255,.22);color:#fff;background:rgba(255,255,255,.08);
}
.preview-details{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.sim-box{
  margin-top:12px;padding:12px;border-radius:5px;
  background:rgba(5,9,15,.8);border:1px solid var(--line);
}
.sim-row{display:flex;align-items:center;gap:8px;margin-top:8px}
.sim-row input{flex:1;min-width:0;font-family:var(--mono);padding:7px 10px}
.list-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.list-tools input[type=search]{flex:1;min-width:200px}
.chip-filter{
  padding:6px 10px;border-radius:4px;border:1px solid var(--line);
  background:var(--panel);font-family:var(--mono);font-size:11px;font-weight:700;color:var(--muted);
}
.chip-filter:hover{color:#fff;border-color:var(--line-hi)}
.chip-filter.active{border-color:rgba(0,240,255,.48);background:var(--cyan-dim);color:var(--cyan)}
.notification-list{display:flex;flex-direction:column;gap:10px}
.notification-row{
  display:flex;position:relative;overflow:hidden;
  background:rgba(6,11,18,.88);border:1px solid var(--line);border-radius:6px;
  transition:border-color .15s,background .15s;
}
.notification-row:hover{border-color:var(--line-hi);background:rgba(12,20,33,.92)}
.notification-row.editing{border-color:var(--cyan);box-shadow:0 0 18px rgba(0,240,255,.14)}
.notification-accent{width:4px;background:var(--cyan);flex-shrink:0}
.notification-row.type-warning .notification-accent{background:var(--amber)}
.notification-row.type-critical .notification-accent{background:var(--red)}
.notification-main{flex:1;min-width:0;padding:14px 16px}
.notification-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.notification-title{font-family:var(--mono);font-size:14px;font-weight:800;color:#fff;overflow-wrap:anywhere}
.notification-message{font-size:13px;color:var(--text-2);line-height:1.55;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.notification-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px}
.notification-actions{display:flex;align-items:center;gap:6px;padding:14px 16px;flex-shrink:0;flex-wrap:wrap}
.sync-note{font-family:var(--mono);font-size:11px;color:var(--muted)}
.kbd-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.kbd-item{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:rgba(5,9,15,.7);border:1px solid var(--line);border-radius:5px;font-size:13px}
@media (max-width:980px){
  .workspace{grid-template-columns:1fr}
  .preview-panel{position:static}
  .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:650px){
  .form-grid{grid-template-columns:1fr}
  .form-divider,.form-group.full,.form-actions{grid-column:auto}
  .notification-row{flex-direction:column}
  .notification-accent{width:100%;height:3px}
  .notification-actions{padding:0 16px 14px}
}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/notifications">
      <span class="brand-mark" aria-hidden="true">&gt;_</span>
      <span class="brand-text">
        <strong>TUXEVIL//ROTATOR</strong>
        <small>BROADCAST OPS</small>
      </span>
    </a>
    <nav class="nav-links" aria-label="Operator navigation">
      <a class="nav-link" href="/dashboard">CONTROL ROOM</a>
      <a class="nav-link active" href="/notifications">BROADCASTS</a>
      <a class="nav-link" href="/stats">PUBLIC STATS</a>
    </nav>
    <div class="top-right">
      <button class="connection" id="connectionState" type="button" title="Toggle token settings">
        <span class="connection-dot" id="connectionDot"></span>
        <span id="connectionLabel">DISCONNECTED</span>
      </button>
      <button class="btn btn-cyber btn-sm" id="refreshBtn" type="button">[R] SYNC</button>
      <button class="btn btn-sm" id="helpBtn" type="button" title="Keyboard shortcuts">?</button>
    </div>
  </div>
</header>

<main class="shell">
  <section class="panel auth-panel" id="authStrip">
    <div class="auth-row">
      <div>
        <div class="panel-kicker">OPERATOR ACCESS // PRIVATE</div>
        <div class="auth-title">Notification Manager</div>
        <div class="auth-note">Authenticate with <code class="mono">STATS_TOKEN</code> to compose, target, and manage fleet broadcasts.</div>
      </div>
      <form class="token-form" id="authForm">
        <label class="sr-only" for="tok">STATS_TOKEN</label>
        <input type="password" id="tok" autocomplete="current-password" placeholder="Paste STATS_TOKEN..." />
        <button class="btn btn-sm" id="toggleTokVis" type="button">SHOW</button>
        <button class="btn btn-cyber" id="connectBtn" type="submit">CONNECT</button>
        <button class="btn btn-danger btn-sm" id="disconnectBtn" type="button" style="display:none">LOGOUT</button>
      </form>
    </div>
  </section>

  <div class="flash error" id="errMsg" style="display:none"></div>
  <div class="flash success" id="successMsg" style="display:none"></div>

  <div id="authedContent" style="display:none">
    <section class="metrics" aria-label="Notification summary">
      <article class="kpi c-cyan"><div class="kpi-label">Total Broadcasts</div><div class="kpi-value" id="metricTotal">0</div><div class="kpi-sub">saved in history</div></article>
      <article class="kpi c-green"><div class="kpi-label">Live Now</div><div class="kpi-value" id="metricActive">0</div><div class="kpi-sub">active on fleet</div></article>
      <article class="kpi c-amber"><div class="kpi-label">Scheduled Expiry</div><div class="kpi-value" id="metricExpiring">0</div><div class="kpi-sub">auto-sunset set</div></article>
      <article class="kpi c-red"><div class="kpi-label">Expired</div><div class="kpi-value" id="metricExpired">0</div><div class="kpi-sub">audit archive</div></article>
    </section>

    <div class="workspace">
      <section class="panel" id="composePanel">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">BROADCAST COMPOSER</div>
            <div class="panel-title" id="formTitle">Compose new broadcast</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="sync-note" id="lastSync">—</span>
            <span class="pill-tag cyan" id="formMode">NEW</span>
          </div>
        </div>

        <div class="templates-bar">
          <span class="templates-label">TEMPLATES:</span>
          <button class="btn btn-sm" type="button" data-tpl="release">RELEASE UPDATE</button>
          <button class="btn btn-sm" type="button" data-tpl="maint">MAINTENANCE</button>
          <button class="btn btn-sm" type="button" data-tpl="urgent">URGENT ALERT</button>
        </div>

        <form id="notificationForm">
          <input type="hidden" id="editId" value="" />
          <select id="nType" class="sr-only" aria-label="Severity">
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>

          <div class="form-grid">
            <div class="form-group full">
              <label>Severity</label>
              <div class="sev-group" id="sevGroup">
                <button class="sev-btn active" type="button" data-sev="info">[i] INFO</button>
                <button class="sev-btn" type="button" data-sev="warning">[!] WARNING</button>
                <button class="sev-btn" type="button" data-sev="critical">[!!] CRITICAL</button>
              </div>
            </div>

            <div class="form-group full">
              <label for="nTitle">Headline</label>
              <input type="text" id="nTitle" maxlength="2048" placeholder="Short operator headline..." />
            </div>

            <div class="form-group full">
              <label for="nMessage">Message</label>
              <textarea id="nMessage" maxlength="2048" placeholder="Explain what changed and what operators should do..."></textarea>
              <div class="field-meta">
                <span>Client broadcast payload</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <div class="char-bar"><div class="char-bar-fill" id="charBarFill"></div></div>
                  <span id="messageCount">0 / 2048</span>
                </div>
              </div>
            </div>

            <div class="form-divider">TARGETING &amp; SCHEDULE</div>

            <div class="form-group">
              <label for="nMinVer">Min version <span class="hint">inclusive</span></label>
              <input type="text" id="nMinVer" class="mono" maxlength="2048" placeholder="e.g. 4.0.0" />
            </div>
            <div class="form-group">
              <label for="nMaxVer">Max version <span class="hint">inclusive</span></label>
              <input type="text" id="nMaxVer" class="mono" maxlength="2048" placeholder="e.g. 4.4.7" />
            </div>

            <div class="form-group full">
              <label for="nExpires">Expiry <span class="hint">optional (local time)</span></label>
              <input type="datetime-local" id="nExpires" />
              <div class="expiry-presets">
                <button class="preset-mini" type="button" data-exp="24">+24H</button>
                <button class="preset-mini" type="button" data-exp="72">+3D</button>
                <button class="preset-mini" type="button" data-exp="168">+7D</button>
                <button class="preset-mini" type="button" data-exp="720">+30D</button>
                <button class="preset-mini" type="button" data-exp="0">NO EXPIRY</button>
              </div>
            </div>

            <div class="form-group">
              <label for="nActionUrl">Action URL <span class="url-status" id="urlStatus"></span></label>
              <input type="text" id="nActionUrl" class="mono" maxlength="2048" placeholder="https://github.com/..." />
            </div>
            <div class="form-group">
              <label for="nActionLabel">Action button label <span class="hint">optional</span></label>
              <input type="text" id="nActionLabel" maxlength="2048" placeholder="e.g. View Release Notes" />
            </div>

            <div class="form-actions">
              <button class="btn btn-cyber" id="btnSubmit" type="submit">PUBLISH BROADCAST</button>
              <button class="btn" id="btnCancel" type="button" style="display:none">CANCEL EDIT</button>
              <button class="btn btn-sm" id="btnReset" type="button" style="margin-left:auto">CLEAR FORM</button>
            </div>
          </div>
        </form>
      </section>

      <aside class="panel preview-panel" aria-label="Live notification preview">
        <div class="panel-head">
          <div>
            <div class="panel-kicker">LIVE CLIENT PREVIEW</div>
            <div class="panel-title">Broadcast card</div>
          </div>
          <span class="pill-tag green">REALTIME</span>
        </div>

        <div class="preview-shell">
          <div class="preview-chrome"><i></i><i></i><i></i><span>rotator://broadcast/live</span></div>
          <div class="preview-card p-info" id="previewCard">
            <span class="preview-icon" id="previewIcon">i</span>
            <div class="preview-content">
              <div class="preview-eyebrow" id="previewType">INFO UPDATE</div>
              <div class="preview-title" id="previewTitle">Broadcast headline</div>
              <div class="preview-msg" id="previewMsg">Message preview updates as you type.</div>
              <a class="preview-action" id="previewAction" href="#" style="display:none">Open link</a>
            </div>
          </div>
          <div class="preview-details">
            <div class="detail-cell"><span>Audience</span><strong id="previewAudience">All versions</strong></div>
            <div class="detail-cell"><span>Expiry</span><strong id="previewExpiry">No expiry</strong></div>
          </div>
        </div>

        <div class="sim-box">
          <div class="panel-kicker">VERSION TARGET SIMULATOR</div>
          <div class="sim-row">
            <label class="sr-only" for="simVersion">Test client version</label>
            <input type="text" id="simVersion" placeholder="Test version (e.g. 4.4.7)" value="4.4.7" />
            <span class="pill-tag green" id="simResult">MATCHES</span>
          </div>
        </div>
      </aside>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-kicker">BROADCAST ARCHIVE</div>
          <div class="panel-title">All notifications <span class="pill-tag cyan" id="notifCount" style="margin-left:8px">0</span></div>
        </div>
        <button class="btn btn-sm" id="syncListBtn" type="button">SYNC LIST</button>
      </div>
      <div class="list-tools">
        <label class="sr-only" for="notifSearch">Search notifications</label>
        <input type="search" id="notifSearch" placeholder="Search headline, message, version..." />
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="statusFilterChips">
          <button class="chip-filter active" type="button" data-status="all">ALL</button>
          <button class="chip-filter" type="button" data-status="active">LIVE</button>
          <button class="chip-filter" type="button" data-status="expired">EXPIRED</button>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap" id="typeFilterChips">
          <button class="chip-filter active" type="button" data-type="all">ANY SEV</button>
          <button class="chip-filter" type="button" data-type="info">INFO</button>
          <button class="chip-filter" type="button" data-type="warning">WARN</button>
          <button class="chip-filter" type="button" data-type="critical">CRIT</button>
        </div>
      </div>
      <div class="notification-list" id="notifTable"></div>
    </section>
  </div>
</main>

<div class="modal-backdrop" id="kbdModal" aria-hidden="true">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="kbdTitle">
    <div class="modal-head">
      <div>
        <div class="panel-kicker">CONSOLE BINDINGS</div>
        <div class="panel-title" id="kbdTitle">Keyboard shortcuts</div>
      </div>
      <button class="btn btn-sm" id="closeKbdBtn" type="button">ESC</button>
    </div>
    <div class="kbd-list">
      <div class="kbd-item"><span>Focus new broadcast headline</span><span class="kbd">N</span></div>
      <div class="kbd-item"><span>Sync notification list</span><span class="kbd">R</span></div>
      <div class="kbd-item"><span>Search archive</span><span class="kbd">/</span></div>
      <div class="kbd-item"><span>Cancel edit / close modal</span><span class="kbd">ESC</span></div>
      <div class="kbd-item"><span>Toggle shortcuts</span><span class="kbd">?</span></div>
    </div>
  </div>
</div>

<div class="toast-stack" id="toastStack" aria-live="polite"></div>

<script>
var _token = '';
var _notifications = [];
var _statusFilter = 'all';
var _typeFilter = 'all';
var _pendingDeleteId = '';

function $(i) { return document.getElementById(i); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, kind) {
  var stack = $('toastStack');
  if (!stack) return;
  var el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(function() { el.remove(); }, 3200);
}
function toLocalInputValue(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  var pad = function(n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function semverLt(a, b) {
  var pa = String(a || '').split('.').map(Number);
  var pb = String(b || '').split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var av = pa[i] || 0;
    var bv = pb[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}
function semverLte(a, b) { return a === b || semverLt(a, b); }

function setConnection(state, label) {
  var el = $('connectionState');
  el.className = 'connection' + (state ? ' ' + state : '');
  $('connectionLabel').textContent = label;
  var disc = $('disconnectBtn');
  if (disc) disc.style.display = state === 'connected' ? '' : 'none';
}

function saveToken(t) {
  _token = t;
  localStorage.setItem('st', t);
  localStorage.setItem('notif_token', t);
}
function clearToken() {
  _token = '';
  localStorage.removeItem('st');
  localStorage.removeItem('notif_token');
  $('tok').value = '';
  $('authedContent').style.display = 'none';
  $('authStrip').classList.remove('collapsed');
  setConnection('', 'DISCONNECTED');
  toast('Disconnected', '');
}

function authenticate(event) {
  if (event) event.preventDefault();
  var t = $('tok').value.trim();
  if (!t) return;
  saveToken(t);
  loadAll(true);
}

async function loadAll(manual) {
  setConnection('connecting', 'CONNECTING...');
  $('connectBtn').disabled = true;
  try {
    var r = await fetch('/v1/stats', { headers: { 'Authorization': 'Bearer ' + _token } });
    if (r.status === 401) throw new Error('Invalid STATS_TOKEN');
    if (!r.ok) throw new Error('Unable to connect (HTTP ' + r.status + ')');
    hideErr();
    $('authedContent').style.display = 'block';
    if (await refreshList(false)) {
      setConnection('connected', 'CONNECTED');
      $('authStrip').classList.add('collapsed');
      if (manual) toast('Connected to Broadcast Ops', 'ok');
    } else {
      setConnection('error', 'SYNC FAILED');
    }
  } catch (e) {
    $('authedContent').style.display = 'none';
    $('authStrip').classList.remove('collapsed');
    setConnection('error', 'AUTH FAILED');
    showErr(e.message);
  } finally {
    $('connectBtn').disabled = false;
  }
}

async function refreshList(manual) {
  if (!_token) return false;
  var rb = $('refreshBtn');
  if (rb) rb.disabled = true;
  try {
    var r = await fetch('/v1/notifications?all=true', {
      headers: { 'Authorization': 'Bearer ' + _token }
    });
    if (r.status === 401) {
      $('authedContent').style.display = 'none';
      $('authStrip').classList.remove('collapsed');
      setConnection('error', 'SESSION EXPIRED');
      throw new Error('Session expired. Re-authenticate.');
    }
    if (!r.ok) throw new Error('Failed to load notifications (HTTP ' + r.status + ')');
    _notifications = await r.json();
    _notifications.sort(function(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    renderTable();
    updateOverview();
    $('lastSync').textContent = 'SYNC ' + new Date().toLocaleTimeString();
    if (manual) toast('Broadcast list synced', 'ok');
    return true;
  } catch (e) {
    showErr(e.message);
    return false;
  } finally {
    if (rb) rb.disabled = false;
  }
}

function isExpired(n, now) {
  if (!n.expiresAt) return false;
  var ts = Date.parse(n.expiresAt);
  return Number.isFinite(ts) && ts <= now;
}
function formatDate(value) {
  if (!value) return 'Unknown date';
  var d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString();
}
function relExpiry(iso, now) {
  if (!iso) return 'No expiry';
  var ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'No expiry';
  var diff = Math.round((ts - now) / 1000);
  var abs = Math.abs(diff);
  var unit = abs < 3600 ? Math.max(1, Math.floor(abs / 60)) + 'm'
    : abs < 86400 ? Math.floor(abs / 3600) + 'h'
    : Math.floor(abs / 86400) + 'd';
  return diff <= 0 ? 'Expired ' + unit + ' ago' : 'Expires in ' + unit;
}
function audienceLabel(n) {
  if (n.minVersion && n.maxVersion) return 'v' + n.minVersion + ' .. v' + n.maxVersion;
  if (n.minVersion) return '>= v' + n.minVersion;
  if (n.maxVersion) return '<= v' + n.maxVersion;
  return 'All versions';
}

function updateOverview() {
  var now = Date.now();
  var expired = _notifications.filter(function(n) { return isExpired(n, now); }).length;
  var expiring = _notifications.filter(function(n) { return Boolean(n.expiresAt) && !isExpired(n, now); }).length;
  $('metricTotal').textContent = String(_notifications.length);
  $('metricActive').textContent = String(_notifications.length - expired);
  $('metricExpiring').textContent = String(expiring);
  $('metricExpired').textContent = String(expired);
}

function renderTable() {
  var tb = $('notifTable');
  var query = (($('notifSearch') || {}).value || '').trim().toLowerCase();
  var now = Date.now();
  var editId = $('editId').value;
  var rows = _notifications.map(function(n, index) { return { n: n, index: index }; }).filter(function(entry) {
    var n = entry.n;
    var expired = isExpired(n, now);
    var hay = [n.title, n.message, n.actionLabel, n.minVersion, n.maxVersion, n.id].filter(Boolean).join(' ').toLowerCase();
    if (query && hay.indexOf(query) === -1) return false;
    if (_statusFilter === 'active' && expired) return false;
    if (_statusFilter === 'expired' && !expired) return false;
    if (_typeFilter !== 'all' && n.type !== _typeFilter) return false;
    return true;
  });

  $('notifCount').textContent = rows.length + ' SHOWN';
  if (!rows.length) {
    tb.innerHTML = _notifications.length === 0
      ? '<div class="empty">No broadcasts yet. Compose the first announcement above.</div>'
      : '<div class="empty">No broadcasts match current filters.</div>';
    return;
  }

  tb.innerHTML = rows.map(function(entry) {
    var n = entry.n;
    var expired = isExpired(n, now);
    var type = ['info', 'warning', 'critical'].indexOf(n.type) !== -1 ? n.type : 'info';
    var typeColor = type === 'critical' ? 'red' : type === 'warning' ? 'amber' : 'cyan';
    var msg = String(n.message || '');
    var preview = msg.length > 260 ? msg.slice(0, 260) + '…' : msg;
    var confirming = _pendingDeleteId === n.id;
    return '<article class="notification-row type-' + type + (editId === n.id ? ' editing' : '') + '">' +
      '<div class="notification-accent"></div>' +
      '<div class="notification-main">' +
        '<div class="notification-top">' +
          '<div class="notification-title">' + esc(n.title || 'Untitled broadcast') + '</div>' +
          '<span class="pill-tag ' + (expired ? '' : 'green') + '">' + (expired ? 'EXPIRED' : 'LIVE') + '</span>' +
        '</div>' +
        '<div class="notification-message">' + esc(preview) + '</div>' +
        '<div class="notification-meta">' +
          '<span class="pill-tag ' + typeColor + '">' + type.toUpperCase() + '</span>' +
          '<span class="pill-tag">TARGET: ' + esc(audienceLabel(n)) + '</span>' +
          '<span class="pill-tag" title="' + esc(n.expiresAt ? formatDate(n.expiresAt) : 'No expiry') + '">' + esc(relExpiry(n.expiresAt, now)) + '</span>' +
          '<span class="pill-tag">CREATED ' + esc(formatDate(n.createdAt)) + '</span>' +
          (n.actionUrl ? '<span class="pill-tag violet">CTA: ' + esc(n.actionLabel || 'Link') + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="notification-actions">' +
        '<button class="btn btn-sm" type="button" data-action="edit" data-idx="' + entry.index + '">EDIT</button>' +
        '<button class="btn btn-sm" type="button" data-action="clone" data-idx="' + entry.index + '">CLONE</button>' +
        (!expired ? '<button class="btn btn-amber btn-sm" type="button" data-action="expire" data-idx="' + entry.index + '">EXPIRE</button>' : '') +
        '<button class="btn btn-danger btn-sm" type="button" data-action="delete" data-id="' + esc(n.id) + '">' + (confirming ? 'CONFIRM?' : 'DEL') + '</button>' +
      '</div>' +
    '</article>';
  }).join('');
}

function setSeverity(sev) {
  $('nType').value = sev;
  document.querySelectorAll('#sevGroup .sev-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-sev') === sev);
  });
  updatePreview();
}

function loadIntoComposer(n, isClone) {
  $('editId').value = isClone ? '' : (n.id || '');
  setSeverity(n.type || 'info');
  $('nTitle').value = (isClone ? '[COPY] ' : '') + (n.title || '');
  $('nMessage').value = n.message || '';
  $('nMinVer').value = n.minVersion || '';
  $('nMaxVer').value = n.maxVersion || '';
  $('nActionUrl').value = n.actionUrl || '';
  $('nActionLabel').value = n.actionLabel || '';
  $('nExpires').value = isClone ? '' : toLocalInputValue(n.expiresAt);
  if (isClone) {
    $('formTitle').textContent = 'Compose cloned broadcast';
    $('formMode').textContent = 'CLONE';
    $('formMode').className = 'pill-tag violet';
    $('btnSubmit').textContent = 'PUBLISH BROADCAST';
    $('btnCancel').style.display = 'none';
  } else {
    $('formTitle').textContent = 'Edit broadcast';
    $('formMode').textContent = 'EDITING';
    $('formMode').className = 'pill-tag amber';
    $('btnSubmit').textContent = 'SAVE CHANGES';
    $('btnCancel').style.display = '';
  }
  updatePreview();
  renderTable();
  $('composePanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('nTitle').focus();
}

function cancelEdit() {
  $('editId').value = '';
  setSeverity('info');
  $('nTitle').value = '';
  $('nMessage').value = '';
  $('nMinVer').value = '';
  $('nMaxVer').value = '';
  $('nActionUrl').value = '';
  $('nActionLabel').value = '';
  $('nExpires').value = '';
  $('formTitle').textContent = 'Compose new broadcast';
  $('formMode').textContent = 'NEW';
  $('formMode').className = 'pill-tag cyan';
  $('btnSubmit').textContent = 'PUBLISH BROADCAST';
  $('btnCancel').style.display = 'none';
  updatePreview();
  renderTable();
}

async function expireNow(idx) {
  var n = _notifications[idx];
  if (!n) return;
  try {
    var payload = {
      id: n.id,
      type: n.type || 'info',
      title: n.title,
      message: n.message,
      createdAt: n.createdAt,
      minVersion: n.minVersion || null,
      maxVersion: n.maxVersion || null,
      actionUrl: n.actionUrl || null,
      actionLabel: n.actionLabel || null,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    };
    var r = await fetch('/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token },
      body: JSON.stringify(payload)
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      toast('Broadcast expired (moved to archive)', 'ok');
      await refreshList(false);
    } else {
      showErr(result.error || 'Failed to expire broadcast');
    }
  } catch (e) { showErr(e.message); }
}

async function submitNotification(event) {
  if (event) event.preventDefault();
  var title = $('nTitle').value.trim();
  var message = $('nMessage').value.trim();
  if (!title || !message) { showErr('Headline and message are required'); return; }

  var payload = {
    type: $('nType').value,
    title: title,
    message: message,
    minVersion: $('nMinVer').value.trim() || null,
    maxVersion: $('nMaxVer').value.trim() || null,
    actionUrl: $('nActionUrl').value.trim() || null,
    actionLabel: $('nActionLabel').value.trim() || null,
    expiresAt: $('nExpires').value ? new Date($('nExpires').value).toISOString() : null
  };

  var editId = $('editId').value;
  if (editId) payload.id = editId;

  var button = $('btnSubmit');
  button.disabled = true;
  button.textContent = editId ? 'SAVING...' : 'PUBLISHING...';
  try {
    var r = await fetch('/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token },
      body: JSON.stringify(payload)
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      var msg = editId ? 'Broadcast updated' : 'Broadcast published to fleet';
      showSuccess(msg);
      toast(msg, 'ok');
      cancelEdit();
      await refreshList(false);
    } else {
      showErr(result.error || 'Failed to save notification');
    }
  } catch (e) {
    showErr(e.message);
  } finally {
    button.disabled = false;
    button.textContent = $('editId').value ? 'SAVE CHANGES' : 'PUBLISH BROADCAST';
  }
}

async function deleteNotif(id) {
  if (_pendingDeleteId !== id) {
    _pendingDeleteId = id;
    renderTable();
    setTimeout(function() {
      if (_pendingDeleteId === id) { _pendingDeleteId = ''; renderTable(); }
    }, 4500);
    return;
  }
  _pendingDeleteId = '';
  try {
    var r = await fetch('/v1/notifications/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + _token }
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      if ($('editId').value === id) cancelEdit();
      toast('Broadcast deleted', 'ok');
      await refreshList(false);
    } else {
      showErr(result.error || 'Failed to delete');
    }
  } catch (e) { showErr(e.message); }
}

var ICONS = { info: 'i', warning: '!', critical: '!!' };
var TYPE_LABELS = { info: 'INFO UPDATE', warning: 'WARNING', critical: 'CRITICAL ALERT' };

function updateSimulator() {
  var ver = ($('simVersion').value || '').trim();
  var minV = ($('nMinVer').value || '').trim();
  var maxV = ($('nMaxVer').value || '').trim();
  var badge = $('simResult');
  if (!ver) { badge.className = 'pill-tag'; badge.textContent = 'ENTER VER'; return; }
  var ok = true;
  if (minV && semverLt(ver, minV)) ok = false;
  if (maxV && !semverLte(ver, maxV)) ok = false;
  badge.className = 'pill-tag ' + (ok ? 'green' : 'red');
  badge.textContent = ok ? 'MATCHES' : 'EXCLUDED';
}

function updatePreview() {
  var type = $('nType').value;
  var title = $('nTitle').value || 'Broadcast headline';
  var msg = $('nMessage').value || 'Message preview updates as you type.';
  var actionUrl = $('nActionUrl').value.trim();
  var actionLabel = $('nActionLabel').value.trim() || 'Open link';
  $('previewCard').className = 'preview-card p-' + type;
  $('previewIcon').textContent = ICONS[type] || 'i';
  $('previewType').textContent = TYPE_LABELS[type] || 'INFO UPDATE';
  $('previewTitle').textContent = title;
  $('previewMsg').textContent = msg;
  var action = $('previewAction');
  var validUrl = !actionUrl || /^https?:\\/\\//i.test(actionUrl);
  var uStat = $('urlStatus');
  if (!actionUrl) { uStat.textContent = ''; uStat.className = 'url-status'; }
  else if (validUrl) { uStat.textContent = 'OK'; uStat.className = 'url-status ok'; }
  else { uStat.textContent = 'HTTP(S) ONLY'; uStat.className = 'url-status bad'; }
  action.textContent = actionLabel;
  action.href = validUrl && actionUrl ? actionUrl : '#';
  action.style.display = actionUrl ? 'inline-flex' : 'none';

  var minV = $('nMinVer').value.trim();
  var maxV = $('nMaxVer').value.trim();
  $('previewAudience').textContent = audienceLabel({ minVersion: minV, maxVersion: maxV });
  var exp = $('nExpires').value;
  $('previewExpiry').textContent = exp ? formatDate(new Date(exp).toISOString()) : 'No expiry';

  var len = ($('nMessage').value || '').length;
  $('messageCount').textContent = len + ' / 2048';
  $('charBarFill').style.width = Math.min(100, Math.round((len / 2048) * 100)) + '%';
  updateSimulator();
}

function showErr(m) { $('errMsg').textContent = 'ERROR :: ' + m; $('errMsg').style.display = ''; setTimeout(function() { $('errMsg').style.display = 'none'; }, 7000); }
function hideErr() { $('errMsg').style.display = 'none'; }
function showSuccess(m) { $('successMsg').textContent = 'OK :: ' + m; $('successMsg').style.display = ''; setTimeout(function() { $('successMsg').style.display = 'none'; }, 3500); }

function applyTemplate(name) {
  cancelEdit();
  if (name === 'release') {
    setSeverity('info');
    $('nTitle').value = 'New Tuxevil Rotator release available';
    $('nMessage').value = 'Update to the latest version for updated model pricing, routing improvements, and stability fixes.';
    $('nActionUrl').value = 'https://github.com/tuxevil/tuxevil-rotator/releases';
    $('nActionLabel').value = 'View Release';
  } else if (name === 'maint') {
    setSeverity('warning');
    $('nTitle').value = 'Scheduled telemetry maintenance';
    $('nMessage').value = 'Telemetry ingestion may pause briefly during maintenance. Local routing continues uninterrupted.';
  } else if (name === 'urgent') {
    setSeverity('critical');
    $('nTitle').value = 'Action required: upgrade recommended';
    $('nMessage').value = 'A provider change affects older rotator versions. Please upgrade immediately to keep accounts protected.';
  }
  updatePreview();
  $('nTitle').focus();
}

// Bindings
$('authForm').addEventListener('submit', authenticate);
$('disconnectBtn').addEventListener('click', clearToken);
$('connectionState').addEventListener('click', function() { $('authStrip').classList.toggle('collapsed'); });
$('toggleTokVis').addEventListener('click', function() {
  var inp = $('tok');
  var show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  this.textContent = show ? 'HIDE' : 'SHOW';
});
$('refreshBtn').addEventListener('click', function() { refreshList(true); });
$('syncListBtn').addEventListener('click', function() { refreshList(true); });
$('notificationForm').addEventListener('submit', submitNotification);
$('btnCancel').addEventListener('click', cancelEdit);
$('btnReset').addEventListener('click', cancelEdit);
$('previewAction').addEventListener('click', function(e) { e.preventDefault(); });

$('sevGroup').addEventListener('click', function(e) {
  var btn = e.target.closest('[data-sev]');
  if (btn) setSeverity(btn.getAttribute('data-sev'));
});
document.querySelectorAll('[data-tpl]').forEach(function(btn) {
  btn.addEventListener('click', function() { applyTemplate(btn.getAttribute('data-tpl')); });
});
document.querySelectorAll('[data-exp]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var hours = Number(btn.getAttribute('data-exp'));
    $('nExpires').value = hours > 0 ? toLocalInputValue(new Date(Date.now() + hours * 3600000).toISOString()) : '';
    updatePreview();
  });
});
['nTitle', 'nMessage', 'nMinVer', 'nMaxVer', 'nActionUrl', 'nActionLabel', 'nExpires'].forEach(function(id) {
  $(id).addEventListener('input', updatePreview);
  $(id).addEventListener('change', updatePreview);
});
$('simVersion').addEventListener('input', updateSimulator);
$('notifSearch').addEventListener('input', renderTable);
$('statusFilterChips').addEventListener('click', function(e) {
  var b = e.target.closest('[data-status]');
  if (!b) return;
  document.querySelectorAll('#statusFilterChips .chip-filter').forEach(function(x) { x.classList.remove('active'); });
  b.classList.add('active');
  _statusFilter = b.getAttribute('data-status');
  renderTable();
});
$('typeFilterChips').addEventListener('click', function(e) {
  var b = e.target.closest('[data-type]');
  if (!b) return;
  document.querySelectorAll('#typeFilterChips .chip-filter').forEach(function(x) { x.classList.remove('active'); });
  b.classList.add('active');
  _typeFilter = b.getAttribute('data-type');
  renderTable();
});
$('notifTable').addEventListener('click', function(e) {
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var act = btn.getAttribute('data-action');
  if (act === 'edit') loadIntoComposer(_notifications[Number(btn.getAttribute('data-idx'))], false);
  else if (act === 'clone') loadIntoComposer(_notifications[Number(btn.getAttribute('data-idx'))], true);
  else if (act === 'expire') expireNow(Number(btn.getAttribute('data-idx')));
  else if (act === 'delete') deleteNotif(btn.getAttribute('data-id'));
});
$('helpBtn').addEventListener('click', function() { $('kbdModal').classList.add('open'); $('kbdModal').setAttribute('aria-hidden', 'false'); });
$('closeKbdBtn').addEventListener('click', function() { $('kbdModal').classList.remove('open'); $('kbdModal').setAttribute('aria-hidden', 'true'); });
$('kbdModal').addEventListener('click', function(e) { if (e.target === this) { this.classList.remove('open'); this.setAttribute('aria-hidden', 'true'); } });

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    $('kbdModal').classList.remove('open');
    if ($('editId').value) cancelEdit();
    return;
  }
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === '?') { e.preventDefault(); $('kbdModal').classList.add('open'); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); if (_token) $('nTitle').focus(); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); if (_token) refreshList(true); }
  else if (e.key === '/') { e.preventDefault(); if (_token) $('notifSearch').focus(); }
});

var saved = localStorage.getItem('st') || localStorage.getItem('notif_token');
if (saved) { _token = saved; $('tok').value = saved; loadAll(false); }
updatePreview();
</script>
</body></html>`;
}

// ── HTTP Server ──────────────────────────────────────────────────────
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let rejected = false;
		req.on("data", (chunk) => {
			if (rejected) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				rejected = true;
				req.destroy();
				reject(new Error("Payload too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
		});
		req.on("error", reject);
	});
}

const server = createServer(async (req, res) => {
	const method = req.method?.toUpperCase();
	const url = req.url || "";

	// CORS
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Dashboard
	if (method === "GET" && (url === "/" || url === "/dashboard")) {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(buildDashboardHtml());
		return;
	}

	// Public stats page
	if (method === "GET" && url === "/stats") {
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache",
		});
		res.end(buildPublicStatsHtml());
		return;
	}

	// Notifications Admin UI
	if (method === "GET" && url === "/notifications") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(buildNotificationsAdminHtml());
		return;
	}

	// ── Notifications API ──────────────────────────────────────────
	// GET /v1/notifications — Public, returns active notifications
	// Add ?all=true to load all (including expired) for admin UI
	if (method === "GET" && url.startsWith("/v1/notifications")) {
		try {
			const q = parseQueryString(url);
			if (q.all === "true") {
				// Return ALL notifications (for admin management UI)
				if (!requireStatsAuth(req, res)) return;
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(loadNotifications()));
			} else {
				const clientVersion = q.version || null;
				const active = getActiveNotifications(clientVersion);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(active));
			}
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to load notifications" }));
		}
		return;
	}

	// POST /v1/notifications — Create/update notification (auth required)
	if (method === "POST" && url === "/v1/notifications") {
		if (!requireStatsAuth(req, res)) return;
		try {
			const body = await readBody(req);
			const data = JSON.parse(body);
			if (!isValidNotificationInput(data)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid notification fields" }));
				return;
			}
			const notifications = loadNotifications();
			const existingIdx = data.id ? notifications.findIndex((n) => n.id === data.id) : -1;
			const notification = {
				id: data.id || randomUUID(),
				type: data.type || "info",
				title: data.title,
				message: data.message,
				createdAt: data.createdAt || (existingIdx >= 0 ? notifications[existingIdx].createdAt : new Date().toISOString()),
				expiresAt: data.expiresAt || null,
				minVersion: data.minVersion || null,
				maxVersion: data.maxVersion || null,
				actionUrl: data.actionUrl || null,
				actionLabel: data.actionLabel || null,
			};
			// Update if id exists, otherwise add
			if (existingIdx >= 0) {
				notifications[existingIdx] = notification;
			} else {
				notifications.push(notification);
			}
			saveNotifications(notifications);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, notification }));
		} catch (err) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Bad request" }));
		}
		return;
	}

	// DELETE /v1/notifications/:id — Remove notification (auth required)
	if (method === "DELETE" && url.startsWith("/v1/notifications/")) {
		if (!requireStatsAuth(req, res)) return;
		try {
			const id = decodeURIComponent(url.slice("/v1/notifications/".length));
			const notifications = loadNotifications();
			const filtered = notifications.filter((n) => n.id !== id);
			if (filtered.length === notifications.length) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Notification not found" }));
				return;
			}
			saveNotifications(filtered);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, deleted: id }));
		} catch {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to delete notification" }));
		}
		return;
	}

	// Public stats (no auth required, 5-minute cache)
	if (method === "GET" && url === "/v1/public-stats") {
		const corsHeaders = {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=300",
			"Access-Control-Allow-Origin": "*",
		};
		try {
			const stats = getPublicStats();
			res.writeHead(200, corsHeaders);
			res.end(JSON.stringify(stats));
		} catch {
			res.writeHead(500, corsHeaders);
			res.end(JSON.stringify({ error: "Failed to compute public stats" }));
		}
		return;
	}

	// Health check
	if (method === "GET" && url === "/v1/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
		return;
	}

	// Installs list (protected)
	if (method === "GET" && url.startsWith("/v1/installs")) {
		if (!requireStatsAuth(req, res)) return;
		try {
			const q = parseQueryString(url);
			const filters = {};
			if (q.installId) filters.installId = q.installId;
			if (q.from)      filters.from      = q.from;
			if (q.to)        filters.to        = q.to;
			if (q.version)   filters.version   = q.version;
			if (q.os)        filters.os        = q.os;
			if (q.model)     filters.model     = q.model;
			const list = computeInstallList(filters);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(list));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to compute install list" }));
		}
		return;
	}

	// Stats (protected)
	if (method === "GET" && url.startsWith("/v1/stats")) {
		if (!requireStatsAuth(req, res)) return;
		try {
			const q = parseQueryString(url);
			const filters = {};
			if (q.installId) filters.installId = q.installId;
			if (q.version) filters.version = q.version;
			if (q.os) filters.os = q.os;
			if (q.model) filters.model = q.model;
			if (q.from) filters.from = q.from;
			if (q.to) filters.to = q.to;
			const stats = computeStats(filters);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(stats, null, 2));
		} catch (err) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Failed to compute stats" }));
		}
		return;
	}

	// Collect telemetry
	if (method === "POST" && url === "/v1/events") {
		const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
		if (isRateLimited(ip)) {
			res.writeHead(429, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Too many requests" }));
			return;
		}

		try {
			const body = await readBody(req);
			const data = JSON.parse(body);

			if (!isValidPayload(data)) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Invalid payload" }));
				return;
			}

			storeEvent(data);
			res.writeHead(202, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ accepted: true }));
		} catch (err) {
			if (err.message === "Payload too large") {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Payload too large" }));
			} else {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Bad request" }));
			}
		}
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`Telemetry receiver listening on 0.0.0.0:${PORT}`);
	console.log(`Data dir: ${DATA_DIR}`);
	console.log(`Stats: ${STATS_TOKEN ? "protected by STATS_TOKEN" : "⚠ STATS_TOKEN not set — /v1/stats disabled"}`);
});
