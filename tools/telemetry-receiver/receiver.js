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

	const serialized = JSON.stringify(data);
	if (serialized.includes("@") && /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]/.test(serialized)) {
		return false;
	}

	return true;
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
	"claude-opus-4-6-thinking": { inputPer1M: 5.00,  outputPer1M: 25.00 },
	"claude-sonnet-4-6":        { inputPer1M: 3.00,  outputPer1M: 15.00 },
	"gemini-3.1-pro":           { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3.1-pro-low":       { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3.1-pro-high":      { inputPer1M: 2.00,  outputPer1M: 12.00 },
	"gemini-3-flash":           { inputPer1M: 0.50,  outputPer1M: 3.00 },
	"gemini-3.5-flash":         { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-low":     { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-medium":  { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.5-flash-high":    { inputPer1M: 1.50,  outputPer1M: 9.00 },
	"gemini-3.6-flash":         { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-high":    { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-medium":  { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-low":     { inputPer1M: 1.50,  outputPer1M: 7.50 },
	"gemini-3.6-flash-tiered":  { inputPer1M: 1.50,  outputPer1M: 7.50 },
	// Gemini 3.7 Flash tiered — public Gemini API pricing, verified
	// 2026-08-13. Introductory rates through 2026-12-31; from 2027-01-01
	// these double to input 1.50 / output 7.50 per 1M tokens.
	"gemini-3.7-flash-tiered":  { inputPer1M: 0.75,  outputPer1M: 3.75 },
	"gpt-oss-120b-medium":      { inputPer1M: 2.00,  outputPer1M: 10.00 },

	// Ollama Cloud models — mirrors MODEL_PRICING in src/types.ts
	"gpt-oss:20b":                 { inputPer1M: 0.075, outputPer1M: 0.30 },
	"gpt-oss:120b":                { inputPer1M: 0.15,  outputPer1M: 0.60 },
	"deepseek-v4-flash:preview":   { inputPer1M: 0.14,  outputPer1M: 0.28 },
	"deepseek-v4-flash:0731":      { inputPer1M: 0.14,  outputPer1M: 0.28 },
	"deepseek-v4-pro":             { inputPer1M: 0.435, outputPer1M: 0.87 },
	"qwen3.5:397b":                { inputPer1M: 0.60,  outputPer1M: 3.60 },
	"glm-5.1":                     { inputPer1M: 0.80,  outputPer1M: 2.56 },
	"glm-5.2":                     { inputPer1M: 0.80,  outputPer1M: 2.56 },
	"gemma4:31b":                  { inputPer1M: 0.38,  outputPer1M: 1.15 },
	"kimi-k2.6":                   { inputPer1M: 0.95,  outputPer1M: 4.00 },
	"kimi-k2.7-code":              { inputPer1M: 0.95,  outputPer1M: 4.00 },
	"kimi-k3":                     { inputPer1M: 0.95,  outputPer1M: 4.00 },
	"minimax-m2.7":                { inputPer1M: 0.30,  outputPer1M: 1.20 },
	"minimax-m3":                  { inputPer1M: 0.30,  outputPer1M: 1.20 },
	"mistral-large-3:675b":        { inputPer1M: 0.50,  outputPer1M: 1.50 },
	"nemotron-3-nano:30b":         { inputPer1M: 0.50,  outputPer1M: 1.50 },
	"nemotron-3-super":            { inputPer1M: 0.60,  outputPer1M: 1.80 },
	"nemotron-3-ultra":            { inputPer1M: 0.60,  outputPer1M: 1.80 },

	// OpenCode Zen free models — mirrors MODEL_PRICING in src/types.ts
	"deepseek-v4-flash-free":      { inputPer1M: 0.14,  outputPer1M: 0.28 },
	"nemotron-3.5-lightning-free": { inputPer1M: 0.35,  outputPer1M: 1.05 },
	"nemotron-3-ultra-free":       { inputPer1M: 0.60,  outputPer1M: 1.80 },
	"mimo-v2.5-free":              { inputPer1M: 0.15,  outputPer1M: 0.60 },
	"hy3-free":                    { inputPer1M: 0.25,  outputPer1M: 1.00 },
	"ling-3.0-tiny-free":          { inputPer1M: 0.05,  outputPer1M: 0.20 },
	"laguna-s-2.1-free":           { inputPer1M: 0.20,  outputPer1M: 0.80 },
};

function getModelPricing(model) {
	if (MODEL_PRICING[model]) return MODEL_PRICING[model];
	const lower = (model || "").toLowerCase();
	if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6-thinking"];
	if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
	if (lower.includes("3.7-flash")) return MODEL_PRICING["gemini-3.7-flash-tiered"];
	if (lower.includes("3.6-flash")) return MODEL_PRICING["gemini-3.6-flash-high"];
	if (lower.includes("3.5-flash")) return MODEL_PRICING["gemini-3.5-flash-high"];
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

	for (const { ev } of events) {
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

	// Aggregate latest token snapshot per install into global totals
	const globalTokensByModel = Object.create(null);
	for (const { tokensByModel } of Object.values(latestTokenSnapshotByInstall)) {
		for (const [model, data] of Object.entries(tokensByModel)) {
			if (!globalTokensByModel[model]) globalTokensByModel[model] = { input: 0, output: 0, requests: 0 };
			globalTokensByModel[model].input += data.input || 0;
			globalTokensByModel[model].output += data.output || 0;
			globalTokensByModel[model].requests += data.requests || 0;
		}
	}

	// Flag aggregates
	const flagsByStatus = Object.create(null);
	const flagsByPattern = Object.create(null);
	const flagsByModel = Object.create(null);
	const flagsByTimerType = Object.create(null);
	let flagsOnProAccounts = 0;
	let flagsOnFreeAccounts = 0;
	let flagRequestsTotal = 0;
	let flagCount = 0;
	const uniqueFlagSignatures = new Set();

	for (const { fl } of flagEvents) {
		flagCount++;
		flagsByStatus[fl.flagHttpStatus] = (flagsByStatus[fl.flagHttpStatus] || 0) + 1;
		for (const p of fl.flagPatternsMatched || []) flagsByPattern[p] = (flagsByPattern[p] || 0) + 1;
		if (fl.model) flagsByModel[fl.model] = (flagsByModel[fl.model] || 0) + 1;
		if (fl.timerType) flagsByTimerType[fl.timerType] = (flagsByTimerType[fl.timerType] || 0) + 1;
		if (fl.wasProAccount) flagsOnProAccounts++;
		else flagsOnFreeAccounts++;
		flagRequestsTotal += fl.accountTotalRequests || 0;
		const signature = JSON.stringify({
			status: fl.flagHttpStatus,
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
				updatedAt: new Date().toISOString(),
			};
		}
	}
	return publicStatsCache;
}

// ── Public stats page ─────────────────────────────────────────────────
function buildPublicStatsHtml() {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="description" content="Anonymous usage statistics for Tuxevil Rotator">
<title>Tuxevil Rotator Stats</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1117;color:#e2e8f0}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#1a2538 0,#0f1117 42rem);padding:24px}
main{max-width:920px;margin:0 auto;padding:clamp(28px,7vw,72px) 0}
.eyebrow{color:#63b3ed;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
h1{margin:10px 0 12px;color:#fff;font-size:clamp(32px,6vw,56px);letter-spacing:-.04em;line-height:1}
.intro{max-width:560px;margin:0;color:#a0aec0;font-size:16px;line-height:1.6}
.intro a,.footer a{color:#90cdf4;text-decoration:none}
.intro a:hover,.footer a:hover{text-decoration:underline}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:40px 0 18px}
.stat{min-height:126px;padding:20px;background:rgba(26,31,46,.88);border:1px solid #2d3748;border-radius:14px;box-shadow:0 12px 30px rgba(0,0,0,.16)}
.stat-label{color:#718096;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.stat-value{margin-top:16px;color:#fff;font-size:clamp(25px,4vw,36px);font-weight:800;letter-spacing:-.03em}
.stat:nth-child(1) .stat-value{color:#b794f4}
.stat:nth-child(2) .stat-value{color:#68d391}
.stat:nth-child(3) .stat-value{color:#f6e05e}
.stat:nth-child(4) .stat-value{color:#63b3ed}
.stat:nth-child(5) .stat-value{color:#90cdf4}
.status{min-height:20px;color:#718096;font-size:12px}
.status.error{color:#fc8181}
.footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:56px;padding-top:16px;border-top:1px solid #2d3748;color:#718096;font-size:12px}
@media (max-width:520px){body{padding:18px}.stats-grid{margin-top:30px}.stat{min-height:112px;padding:16px}.stat-value{margin-top:12px}}
</style>
</head>
<body>
<main>
  <div class="eyebrow">Tuxevil Rotator</div>
  <h1>Usage at a glance.</h1>
  <p class="intro">Anonymous aggregate telemetry from the community. Values refresh automatically every five minutes. <a href="/v1/public-stats">View the raw data</a>.</p>
  <section class="stats-grid" aria-label="Public usage statistics">
    <article class="stat"><div class="stat-label">Installations</div><div class="stat-value" id="installs">-</div></article>
    <article class="stat"><div class="stat-label">Requests routed</div><div class="stat-value" id="requests">-</div></article>
    <article class="stat"><div class="stat-label">Estimated savings</div><div class="stat-value" id="savings">-</div></article>
    <article class="stat"><div class="stat-label">Input tokens</div><div class="stat-value" id="tokensInput">-</div></article>
    <article class="stat"><div class="stat-label">Output tokens</div><div class="stat-value" id="tokensOutput">-</div></article>
  </section>
  <div class="status" id="status" role="status" aria-live="polite">Loading live totals...</div>
  <footer class="footer"><span>Updated from anonymous telemetry</span><a href="https://github.com/tuxevil/tuxevil-rotator">View the project on GitHub</a></footer>
</main>
<script>
const REFRESH_MS = 5 * 60 * 1000;
const fields = [
  ["installs", "installsFormatted"],
  ["requests", "requestsFormatted"],
  ["savings", "savingsFormatted"],
  ["tokensInput", "tokensInputFormatted"],
  ["tokensOutput", "tokensOutputFormatted"],
];

function formatUpdatedAt(value) {
  if (!value) return "Updated just now";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Updated just now" : "Updated " + date.toLocaleString();
}

async function loadStats() {
  const status = document.getElementById("status");
  try {
    const response = await fetch("/v1/public-stats", { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const stats = await response.json();
    for (const [elementId, field] of fields) {
      document.getElementById(elementId).textContent = stats[field] ?? "-";
    }
    status.className = "status";
    status.textContent = formatUpdatedAt(stats.updatedAt);
  } catch (error) {
    status.className = "status error";
    status.textContent = "Live totals are temporarily unavailable. Retrying in five minutes.";
  }
}

loadStats();
setInterval(loadStats, REFRESH_MS);
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
<title>Tuxevil Rotator Telemetry</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
.header{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:14px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:17px;font-weight:700;color:#fff}
.header .ts{font-size:11px;color:#718096;background:#2d3748;padding:2px 8px;border-radius:10px;margin-left:auto}
.token-bar{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:10px 24px;display:flex;gap:8px;align-items:center}
.token-bar input[type=password]{flex:1;background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:7px 12px;color:#e2e8f0;font-size:13px;font-family:monospace}
.token-bar input[type=password]:focus{outline:none;border-color:#4299e1}
.token-bar button{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap}
.token-bar button:hover{background:#3182ce}
.filter-bar{background:#141820;border-bottom:1px solid #2d3748;padding:10px 24px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}
.filter-group{display:flex;flex-direction:column;gap:3px;min-width:140px}
.filter-group label{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.06em}
select,input[type=date]{background:#1a1f2e;border:1px solid #2d3748;border-radius:6px;padding:6px 10px;color:#e2e8f0;font-size:12px;cursor:pointer}
select:focus,input[type=date]:focus{outline:none;border-color:#4299e1}
.filter-actions{display:flex;gap:6px;margin-top:14px}
.btn-apply{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600}
.btn-clear{background:#2d3748;color:#a0aec0;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px}
.filter-active{background:#1c4532;border:1px solid #276749;border-radius:6px;padding:4px 10px;font-size:11px;color:#68d391;display:none;align-items:center;gap:6px}
.filter-active.show{display:flex}
.main{padding:20px 24px;max-width:1400px;margin:0 auto}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin-bottom:18px}
.kpi{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:14px}
.kpi .label{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.kpi .value{font-size:24px;font-weight:700;color:#fff}
.kpi .sub{font-size:10px;color:#718096;margin-top:3px}
.kpi.green .value{color:#68d391}.kpi.blue .value{color:#63b3ed}
.kpi.yellow .value{color:#f6e05e}.kpi.red .value{color:#fc8181}
.section{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px;margin-bottom:14px}
.section h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px}
.chart-box{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px}
.chart-box h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.chart-box canvas{max-height:190px}
.flag-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.flag-kpi{background:#2d1f1f;border:1px solid #742a2a;border-radius:8px;padding:12px}
.flag-kpi .label{font-size:10px;color:#fc8181;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
.flag-kpi .value{font-size:20px;font-weight:700;color:#feb2b2}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 12px;color:#718096;border-bottom:1px solid #2d3748;font-weight:500;white-space:nowrap}
td{padding:7px 12px;border-bottom:1px solid #1f2535;color:#e2e8f0}
tr:last-child td{border-bottom:none}
.mono{font-family:monospace;color:#68d391}
.savings-big{font-size:36px;font-weight:800;color:#68d391;margin-bottom:3px}
.savings-sub{font-size:12px;color:#718096;margin-bottom:14px}
.error{background:#2d1515;border:1px solid #742a2a;border-radius:8px;padding:12px;color:#fc8181;margin-bottom:14px}
.empty{color:#4a5568;font-size:12px;padding:20px;text-align:center}

/* ── View toggle ── */
.view-tabs{display:flex;gap:8px;padding:12px 24px;background:#141820;border-bottom:1px solid #2d3748}
.view-tab{font-size:12px;font-weight:600;padding:5px 14px;border-radius:999px;border:1px solid #2d3748;background:transparent;color:#718096;cursor:pointer;font-family:inherit;transition:all .2s}
.view-tab.active{background:rgba(66,153,225,.15);border-color:rgba(66,153,225,.4);color:#63b3ed}
.view-tab:hover:not(.active){background:rgba(255,255,255,.04);color:#e2e8f0}

/* ── Installs list ── */
.install-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.install-search{background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:6px 12px;color:#e2e8f0;font-size:12px;font-family:inherit;width:200px;outline:none;transition:border-color .2s}
.install-search:focus{border-color:#4299e1}
.sort-btn{font-size:11px;padding:4px 10px;border:1px solid #2d3748;background:transparent;color:#718096;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600;transition:all .2s}
.sort-btn.active{border-color:rgba(66,153,225,.4);color:#63b3ed;background:rgba(66,153,225,.08)}
.install-table{width:100%;border-collapse:collapse}
.install-table th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#718096;padding:8px 12px;text-align:left;border-bottom:1px solid #2d3748;background:rgba(255,255,255,.02);white-space:nowrap;cursor:pointer;user-select:none}
.install-table th:hover{color:#e2e8f0}
.install-table th .arr{display:inline-block;margin-left:3px;opacity:.35;font-size:9px}
.install-table th.sort-active .arr{opacity:1;color:#63b3ed}
.install-table td{padding:9px 12px;font-size:12px;border-bottom:1px solid #1f2535;vertical-align:middle}
.install-table tr:last-child td{border-bottom:none}
.install-row{cursor:pointer;transition:background .15s}
.install-row:hover td{background:rgba(66,153,225,.05)}
.install-row.selected td{background:rgba(66,153,225,.1)}
.install-id{font-family:monospace;font-size:11px;color:#718096}
.install-id strong{color:#63b3ed;display:block;font-size:12px;margin-bottom:1px}
.mini-bar{display:flex;align-items:center;gap:5px}
.mini-bar-bg{width:50px;height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;flex-shrink:0}
.mini-bar-fill{height:100%;border-radius:2px}
.health-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;flex-shrink:0}
.install-list-panel{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px}
 .install-list-panel h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
</style>
<style>
:root{color-scheme:dark;--bg:#0b0f17;--panel:#141b29;--panel-2:#192235;--line:#29364b;--muted:#7d8ca5;--text:#e8eef8;--blue:#78b7ff;--green:#72dfa0;--yellow:#f6d365;--red:#ff8b8b;--purple:#aa9cff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(circle at 18% -10%,#1c304b 0,#0f1117 38rem);color:var(--text);min-height:100vh}
button,input,textarea,select{font:inherit}
button{border:0}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
a{color:inherit}
.topbar{border-bottom:1px solid rgba(125,140,165,.18);background:rgba(11,15,23,.72);backdrop-filter:blur(14px)}
.topbar-inner{max-width:1240px;margin:0 auto;padding:17px 28px;display:flex;align-items:center;gap:24px}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none;min-width:0}
.brand-mark{width:31px;height:31px;border-radius:10px;background:linear-gradient(135deg,#78b7ff,#8b7dff);box-shadow:0 0 24px rgba(120,183,255,.25);position:relative;flex-shrink:0}
.brand-mark:after{content:'';position:absolute;width:9px;height:9px;border-radius:50%;background:#fff;left:11px;top:11px;box-shadow:0 0 0 4px rgba(255,255,255,.2)}
.brand strong{display:block;color:#fff;font-size:14px;letter-spacing:.01em}.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-top:2px}
.nav{margin-left:auto;display:flex;align-items:center;gap:7px}.nav a,.nav-lock{color:var(--muted);font-size:12px;text-decoration:none;padding:7px 10px;border-radius:7px;transition:color .2s,background .2s}.nav a:hover{color:#fff;background:rgba(255,255,255,.07)}
.nav-lock{color:var(--green);background:rgba(114,223,160,.08);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.auth-strip{border-bottom:1px solid rgba(125,140,165,.18);background:rgba(20,27,41,.76)}
.auth-inner{max-width:1240px;margin:0 auto;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.auth-kicker,.eyebrow,.section-kicker{color:var(--blue);font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.auth-title{color:#fff;font-size:16px;font-weight:700;margin-top:4px}.auth-note{color:var(--muted);font-size:12px;margin-top:3px}
.auth-controls{display:flex;align-items:center;gap:12px;min-width:min(100%,500px)}
.connection{display:flex;align-items:center;gap:7px;white-space:nowrap;color:var(--muted);font-size:11px;font-weight:600}.connection-dot{width:8px;height:8px;border-radius:50%;background:#59677d;box-shadow:0 0 0 4px rgba(89,103,125,.12)}
.connection.connected{color:var(--green)}.connection.connected .connection-dot{background:var(--green);box-shadow:0 0 0 4px rgba(114,223,160,.12)}
.connection.connecting{color:var(--yellow)}.connection.connecting .connection-dot{background:var(--yellow);box-shadow:0 0 0 4px rgba(246,211,101,.12);animation:pulse 1.2s ease-in-out infinite}
.connection.error{color:var(--red)}.connection.error .connection-dot{background:var(--red);box-shadow:0 0 0 4px rgba(255,139,139,.12)}
.token-form{display:flex;gap:8px;flex:1}.token-form input{width:100%;min-width:0;background:#0b1019;border:1px solid var(--line);border-radius:8px;padding:9px 12px;color:var(--text);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.token-form input::placeholder{color:#56657c}.token-form input:focus{border-color:var(--blue);outline:none;box-shadow:0 0 0 3px rgba(120,183,255,.12)}
.dashboard-shell{max-width:1240px;margin:0 auto;padding:34px 28px 64px}.dashboard-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:22px}.dashboard-hero h1{color:#fff;font-size:clamp(28px,4vw,44px);line-height:1.05;letter-spacing:-.045em;margin:10px 0}.dashboard-hero p{max-width:650px;color:#91a0b7;font-size:14px;line-height:1.6}.hero-actions{display:flex;align-items:center;gap:12px;flex-shrink:0}.sync-note{color:var(--muted);font-size:11px;white-space:nowrap}
.dashboard-tabs{display:flex;align-items:center;gap:8px;margin-bottom:13px}.view-tabs{max-width:1240px;margin:0 auto;padding:0 28px 14px;background:transparent;display:flex;gap:8px;border:0}.view-tab{font-size:11px;font-weight:800;padding:8px 13px;border-radius:8px;border:1px solid var(--line);background:rgba(20,27,41,.72);color:var(--muted);cursor:pointer;font-family:inherit;transition:all .2s;letter-spacing:.02em}.view-tab.active{background:rgba(120,183,255,.13);border-color:rgba(120,183,255,.42);color:var(--blue)}.view-tab:hover:not(.active){background:rgba(255,255,255,.05);color:#fff}
.filter-bar{max-width:1240px;margin:0 auto 17px;padding:14px 28px;background:rgba(20,27,41,.88);border:1px solid var(--line);border-radius:12px;display:flex;flex-wrap:wrap;gap:9px;align-items:flex-end}.filter-group{display:flex;flex-direction:column;gap:5px;min-width:135px;flex:1}.filter-group label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:800}.filter-group select,.filter-group input[type=date]{width:100%;background:#0c121d;border:1px solid var(--line);border-radius:8px;padding:8px 10px;color:var(--text);font-size:12px;cursor:pointer}.filter-group select:focus,.filter-group input[type=date]:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(120,183,255,.1)}.filter-actions{display:flex;gap:7px}.btn-apply,.btn-clear,.btn-refresh{border-radius:8px;padding:8px 12px;cursor:pointer;font-size:11px;font-weight:800;transition:background .2s,border-color .2s,color .2s}.btn-apply{background:var(--blue);color:#08111d}.btn-apply:hover{background:#9bcaff}.btn-clear{background:#26334a;color:#b5c3d6}.btn-clear:hover{background:#33435c;color:#fff}.btn-refresh{background:rgba(120,183,255,.08);border:1px solid rgba(120,183,255,.25);color:var(--blue)}.btn-refresh:hover{background:rgba(120,183,255,.15)}.filter-active{background:rgba(114,223,160,.1);border:1px solid rgba(114,223,160,.28);border-radius:8px;padding:7px 10px;font-size:10px;color:var(--green);display:none;align-items:center;gap:6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.filter-active.show{display:flex}
.main{padding:0;max-width:none;margin:0}.main>.error{margin:0 0 16px}.error{background:rgba(255,139,139,.1);border:1px solid rgba(255,139,139,.32);border-radius:10px;padding:12px 14px;color:var(--red);font-size:12px;line-height:1.4}.app-shell{display:block}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:17px}.kpi{position:relative;overflow:hidden;background:linear-gradient(145deg,rgba(25,34,53,.92),rgba(17,24,38,.92));border:1px solid var(--line);border-radius:12px;padding:15px 16px;min-height:98px}.kpi:after{content:'';position:absolute;width:70px;height:70px;border-radius:50%;right:-28px;bottom:-38px;background:var(--metric-color,#78b7ff);opacity:.08;filter:blur(3px)}.kpi .label{color:var(--muted);font-size:9px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.kpi .value{color:#fff;font-size:23px;font-weight:800;letter-spacing:-.04em;margin-top:11px;overflow-wrap:anywhere}.kpi .sub{color:#61718a;font-size:10px;margin-top:3px}.kpi.green{--metric-color:var(--green)}.kpi.blue{--metric-color:var(--blue)}.kpi.yellow{--metric-color:var(--yellow)}.kpi.red{--metric-color:var(--red)}.kpi.green .value{color:var(--green)}.kpi.blue .value{color:var(--blue)}.kpi.yellow .value{color:var(--yellow)}.kpi.red .value{color:var(--red)}
.section{background:rgba(20,27,41,.9);border:1px solid var(--line);border-radius:14px;padding:21px;margin-bottom:15px;box-shadow:0 18px 45px rgba(0,0,0,.1)}.section h2{color:#fff;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:15px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:17px}.section-title h2{margin:6px 0 0;font-size:18px;letter-spacing:-.02em;text-transform:none}.section-title p{color:var(--muted);font-size:11px;margin-top:5px}
.savings-layout{display:grid;grid-template-columns:minmax(220px,.65fr) minmax(0,1.35fr);gap:20px;align-items:start}.savings-big{font-size:clamp(32px,5vw,47px);font-weight:850;letter-spacing:-.055em;color:var(--green);margin:4px 0 3px}.savings-sub{font-size:12px;color:var(--muted);line-height:1.5;margin-bottom:13px}.savings-note{color:#61718a;font-size:10px;line-height:1.5;max-width:240px}
.flag-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-bottom:16px}.flag-kpi{background:rgba(255,139,139,.07);border:1px solid rgba(255,139,139,.22);border-radius:10px;padding:12px}.flag-kpi .label{font-size:9px;color:#e08b95;text-transform:uppercase;letter-spacing:.08em;font-weight:800}.flag-kpi .value{font-size:20px;font-weight:800;color:#ffb0b0;margin-top:7px}.charts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin-bottom:15px}.charts:last-child{margin-bottom:0}.chart-box{min-width:0;background:rgba(11,16,25,.52);border:1px solid #243148;border-radius:11px;padding:16px}.chart-box h2{font-size:10px;color:var(--muted);letter-spacing:.1em;margin-bottom:12px}.chart-box canvas{max-height:205px}
table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;padding:8px 11px;color:var(--muted);border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap}td{padding:9px 11px;border-bottom:1px solid rgba(41,54,75,.55);color:#d8e1ee;vertical-align:top}tr:last-child td{border-bottom:none}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--green);font-size:11px}.empty{border:1px dashed #33445e;border-radius:10px;color:#6e7e96;font-size:12px;line-height:1.5;padding:28px 20px;text-align:center}.install-list-panel{background:rgba(20,27,41,.9);border:1px solid var(--line);border-radius:14px;padding:21px;box-shadow:0 18px 45px rgba(0,0,0,.1)}.install-list-panel h2{color:#fff;font-size:18px;letter-spacing:-.02em;text-transform:none;margin:6px 0 0}.install-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:17px}.install-heading p{color:var(--muted);font-size:11px;margin-top:5px}.install-count{color:var(--blue);font-size:11px;font-weight:700;background:rgba(120,183,255,.09);border:1px solid rgba(120,183,255,.22);border-radius:999px;padding:5px 9px}.install-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}.install-search{background:#0c121d;border:1px solid var(--line);border-radius:8px;padding:9px 11px;color:var(--text);font-size:12px;font-family:inherit;width:240px;outline:none;transition:border-color .2s}.install-search:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(120,183,255,.1)}.sort-btn{font-size:10px;padding:7px 9px;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:7px;cursor:pointer;font-family:inherit;font-weight:700;transition:all .2s}.sort-btn.active{border-color:rgba(120,183,255,.4);color:var(--blue);background:rgba(120,183,255,.08)}.sort-btn:hover{color:#fff;background:rgba(255,255,255,.05)}.install-table{width:100%;border-collapse:collapse}.install-table th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);background:rgba(255,255,255,.02);white-space:nowrap;cursor:pointer;user-select:none}.install-table th:hover{color:#fff}.install-table th .arr{display:inline-block;margin-left:3px;opacity:.35;font-size:9px}.install-table th.sort-active .arr{opacity:1;color:var(--blue)}.install-table td{padding:10px 11px;font-size:12px;border-bottom:1px solid rgba(41,54,75,.55);vertical-align:middle}.install-table tr:last-child td{border-bottom:none}.install-row{cursor:pointer;transition:background .15s}.install-row:hover td{background:rgba(120,183,255,.05)}.install-row.selected td{background:rgba(120,183,255,.1)}.install-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted)}.install-id strong{color:var(--blue);display:block;font-size:12px;margin-bottom:1px}.health-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;flex-shrink:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@keyframes pulse{50%{opacity:.45}}
@media(max-width:980px){.auth-inner{align-items:flex-start;flex-direction:column;gap:14px}.auth-controls{width:100%;max-width:none}.kpi-grid{grid-template-columns:repeat(3,1fr)}.charts{grid-template-columns:repeat(2,minmax(0,1fr))}.savings-layout{grid-template-columns:1fr}.savings-note{max-width:none}}
@media(max-width:680px){.topbar-inner,.auth-inner,.dashboard-shell,.view-tabs,.filter-bar{padding-left:17px;padding-right:17px}.nav a{display:none}.nav-lock{padding:6px 8px}.dashboard-shell{padding-top:28px}.dashboard-hero{align-items:flex-start;flex-direction:column;margin-bottom:18px}.hero-actions{width:100%;justify-content:space-between}.kpi-grid{grid-template-columns:repeat(2,1fr);gap:8px}.kpi{min-height:90px;padding:13px}.kpi .value{font-size:21px}.view-tabs{overflow:auto}.filter-bar{align-items:stretch;flex-direction:column}.filter-group{min-width:0}.filter-actions{width:100%}.filter-actions button{flex:1}.filter-active{max-width:none}.section,.install-list-panel{padding:17px}.section-title,.install-heading{align-items:flex-start;flex-direction:column;gap:4px}.charts,.flag-kpis{grid-template-columns:1fr}.chart-box{min-height:220px}.install-toolbar{align-items:stretch;flex-direction:column}.install-search{width:100%}.install-table{display:block;overflow-x:auto;white-space:nowrap}.auth-controls{align-items:stretch;flex-direction:column}.token-form{width:100%}}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true"></span>
      <span><strong>Tuxevil Rotator</strong><small>Operations</small></span>
    </a>
    <nav class="nav" aria-label="Operator navigation">
      <a href="/notifications">Notifications</a>
      <a href="/stats">Public stats</a>
      <span class="nav-lock">Private</span>
    </nav>
  </div>
</header>
<section class="auth-strip">
  <div class="auth-inner">
    <div>
      <div class="auth-kicker">Operator access</div>
      <div class="auth-title">Telemetry control room</div>
      <div class="auth-note">Inspect aggregate usage, account health and routing signals.</div>
    </div>
    <div class="auth-controls">
      <div class="connection" id="dashboardConnection"><span class="connection-dot"></span><span id="dashboardConnectionLabel">Not connected</span></div>
      <form class="token-form" id="dashboardAuthForm" onsubmit="load(event)">
        <label class="sr-only" for="tok">STATS_TOKEN</label>
        <input type="password" id="tok" autocomplete="current-password" placeholder="Paste STATS_TOKEN" />
        <button class="btn-apply" id="loadBtn" type="submit">Connect</button>
      </form>
    </div>
  </div>
</section>

<div class="view-tabs" id="viewTabs" style="display:none"><button class="view-tab active" id="vtAgg" type="button" onclick="switchView(&apos;agg&apos;)">Overview</button><button class="view-tab" id="vtList" type="button" onclick="switchView(&apos;list&apos;)">Installations</button></div>
<div class="filter-bar" id="filterBar" style="display:none">
  <div class="filter-group"><label for="fInstall">Install ID</label><select id="fInstall"><option value="">All installs</option></select></div>
  <div class="filter-group"><label for="fVersion">Version</label><select id="fVersion"><option value="">All versions</option></select></div>
  <div class="filter-group"><label for="fOS">Operating system</label><select id="fOS"><option value="">All OS</option></select></div>
  <div class="filter-group"><label for="fModel">Model</label><select id="fModel"><option value="">All models</option></select></div>
  <div class="filter-group"><label for="fFrom">From</label><input type="date" id="fFrom" /></div>
  <div class="filter-group"><label for="fTo">To</label><input type="date" id="fTo" /></div>
  <div class="filter-actions"><button class="btn-apply" type="button" onclick="applyFilters()">Apply</button><button class="btn-clear" type="button" onclick="clearFilters()">Clear</button></div>
  <div class="filter-active" id="filterActive">Filtered view</div>
</div>

<div class="dashboard-shell">
  <div class="dashboard-hero">
    <div><div class="eyebrow">Observability / Telemetry</div><h1>See the system in motion.</h1><p>Understand adoption, routing health and account signals from one focused operational view.</p></div>
    <div class="hero-actions"><span class="sync-note" id="ts">Not synced</span><button class="btn-refresh" id="refreshBtn" type="button" onclick="refreshDashboard()">Refresh</button></div>
  </div>
  <div class="main">
    <div class="error" id="err" style="display:none"></div>
    <div id="app" class="app-shell" style="display:none">
      <div class="kpi-grid" id="kpis"></div>
      <section class="section savings-section">
        <div class="section-title"><div><div class="section-kicker">Efficiency</div><h2>Estimated savings</h2><p>USD avoided versus a paid API across the selected period.</p></div></div>
        <div class="savings-layout"><div><div class="savings-big" id="savTotal">$0.00</div><div class="savings-sub">Total saved across the current filter set</div><p class="savings-note">Use the filters above to compare cohorts, versions, models or individual installs.</p></div><div id="savTable"></div></div>
      </section>
      <section class="section">
        <div class="section-title"><div><div class="section-kicker">Safety signals</div><h2>Flag analysis</h2><p>Patterns that need operator attention.</p></div></div>
        <div class="flag-kpis" id="flagKpis"></div>
        <div class="charts"><div class="chart-box"><h2>By pattern</h2><canvas id="cPatterns"></canvas></div><div class="chart-box"><h2>By model</h2><canvas id="cFlagModels"></canvas></div><div class="chart-box"><h2>By timer type</h2><canvas id="cTimerType"></canvas></div></div>
      </section>
      <section class="section">
        <div class="section-title"><div><div class="section-kicker">Consumption</div><h2>Token usage by model</h2><p>Input, output and request volume for the selected cohort.</p></div></div>
        <div id="tokTable"></div>
      </section>
      <div class="charts">
        <div class="chart-box"><h2>Versions</h2><canvas id="cVersions"></canvas></div><div class="chart-box"><h2>Operating systems</h2><canvas id="cOS"></canvas></div><div class="chart-box"><h2>Active models</h2><canvas id="cModels"></canvas></div><div class="chart-box"><h2>Routing health</h2><canvas id="cHealth"></canvas></div><div class="chart-box"><h2>Features used</h2><canvas id="cFeatures"></canvas></div>
      </div>
    </div>
  </div>
</div>

<script>
const C=['#63b3ed','#68d391','#f6e05e','#b794f4','#fc8181','#fbd38d','#76e4f7','#a3bffa'];
const R=['#fc8181','#f6ad55','#faf089','#b794f4','#feb2b2'];
const charts={};
let _token='';
let _filterOptions={};

function $(i){return document.getElementById(i)}
function fmt(n){return n==null?'—':Number(n).toLocaleString()}
function usd(n){return '$'+Number(n||0).toFixed(2)}
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function jsString(s){
  return esc(String(s==null?'':s)
    .replace(/\\\\/g,'\\\\\\\\')
    .replace(/'/g,"\\\\'")
    .replace(/\\r/g,'\\\\r')
    .replace(/\\n/g,'\\\\n'));
}

function mkChart(id,type,labels,datasets){
  if(charts[id])charts[id].destroy();
  const ctx=$(id)?.getContext('2d');if(!ctx)return;
  charts[id]=new Chart(ctx,{type,data:{labels,datasets},options:{
    responsive:true,maintainAspectRatio:true,
    plugins:{legend:{labels:{color:'#a0aec0',font:{size:11}}}},
    scales:type==='bar'?{x:{ticks:{color:'#718096'},grid:{color:'#2d3748'}},y:{ticks:{color:'#718096'},grid:{color:'#2d3748'}}}:undefined
  }});
}

function setDashboardConnection(state, label) {
  var el = $('dashboardConnection');
  if (!el) return;
  el.className = 'connection' + (state ? ' ' + state : '');
  $('dashboardConnectionLabel').textContent = label;
}

async function load(event){
  if(event)event.preventDefault();
  const t=$('tok').value.trim();
  if(!t)return;
  _token=t;
  localStorage.setItem('st',t);
  setDashboardConnection('connecting','Connecting...');
  $('loadBtn').disabled=true;
  try { await go({}); }
  finally { $('loadBtn').disabled=false; }
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

async function go(filters){
  const qs=buildParams(filters);
  const url='/v1/stats'+(qs?'?'+qs:'');
  const refreshButton=$('refreshBtn');
  if(refreshButton)refreshButton.disabled=true;
  try{
    const r=await fetch(url,{headers:{'Authorization':'Bearer '+_token}});
    if(r.status===401){$('app').style.display='none';$('viewTabs').style.display='none';$('filterBar').style.display='none';var unauthorizedList=$('installsView');if(unauthorizedList)unauthorizedList.style.display='none';setDashboardConnection('error','Invalid token');showErr('Invalid token');return false}
    if(!r.ok){setDashboardConnection('error','Request failed');showErr('Server error '+r.status);return false}
    const d=await r.json();
    $('err').style.display='none';
    $('viewTabs').style.display='flex';
    var listView=$('installsView');
    if(CURRENT_VIEW==='list'&&listView){$('app').style.display='none';$('filterBar').style.display='none';listView.style.display='block';}
    else{$('app').style.display='block';$('filterBar').style.display='flex';if(listView)listView.style.display='none';}
    $('ts').textContent='Updated '+new Date().toLocaleTimeString();
    setDashboardConnection('connected','Connected');
    render(d,filters);
    return true;
  }catch(e){setDashboardConnection('error','Request failed');showErr(e.message);return false;}
  finally{if(refreshButton)refreshButton.disabled=false;}
}

function showErr(msg){$('err').textContent='Error: '+msg;$('err').style.display='';}

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

function refreshDashboard(){go(currentFilters());}

function applyFilters(){
  const f=currentFilters();
  const hasFilters=Object.keys(f).length>0;
  const fa=$('filterActive');
  if(hasFilters){fa.classList.add('show');fa.textContent='Filtered: '+Object.entries(f).map(([k,v])=>k+'='+v).join(', ');}
  else{fa.classList.remove('show');}
  go(f);
}

function clearFilters(){
  $('fInstall').value='';
  $('fVersion').value='';
  $('fOS').value='';
  $('fModel').value='';
  $('fFrom').value='';
  $('fTo').value='';
  $('filterActive').classList.remove('show');
  go({});
}

function populateDropdowns(opts){
  _filterOptions=opts;
  const cur={install:$('fInstall').value,ver:$('fVersion').value,os:$('fOS').value,model:$('fModel').value};
  fillSelect('fInstall',opts.installIds,'All installs',cur.install);
  fillSelect('fVersion',opts.versions,'All versions',cur.ver);
  fillSelect('fOS',opts.os,'All OS',cur.os);
  fillSelect('fModel',opts.models,'All models',cur.model);
  if(opts.dateRange?.from&&!$('fFrom').value)$('fFrom').value=opts.dateRange.from;
}

function fillSelect(id,items,placeholder,selected){
  const el=$(id);
  el.innerHTML='<option value="">'+placeholder+'</option>';
  for(const it of items){
    const o=document.createElement('option');
    o.value=it;o.textContent=it;
    if(it===selected)o.selected=true;
    el.appendChild(o);
  }
}

function render(d, filters={}){
  if(d.filterOptions)populateDropdowns(d.filterOptions);

  $('kpis').innerHTML=[
    {l:'Unique Installs',v:fmt(d.uniqueInstalls),c:'green'},
    {l:'Total Events',v:fmt(d.totalEvents),c:'blue'},
    {l:'Boots',v:fmt(d.totalBoots),c:'blue'},
    {l:'Avg Accounts',v:d.avgAccountsPerEvent,c:''},
    {l:'Total Requests',v:fmt(d.totalRequestsAcrossAll),c:'yellow'},
    {l:'Flag Events',v:fmt(d.flags?.totalFlags||0),c:'red'},
    {l:'Unique Flag Incidents',v:fmt(d.flags?.uniqueIncidents||0),c:'red'},
    {l:'Avg Req/Flag',v:fmt(d.flags?.avgRequestsBeforeFlag||0),c:'red'},
    {l:'Period',v:d.period?.from||'—',sub:d.period?.to?'→ '+d.period.to:''},
  ].map(k=>'<div class="kpi '+esc(k.c)+'"><div class="label">'+esc(k.l)+'</div><div class="value">'+esc(k.v)+'</div>'+(k.sub?'<div class="sub">'+esc(k.sub)+'</div>':'')+'</div>').join('');

  const sv=d.savings||{};
  $('savTotal').textContent=usd(sv.totalUsd);
  const svRows=Object.entries(sv.byModel||{}).map(([m,v])=>'<tr><td class="mono">'+esc(m)+'</td><td>'+usd(v.inputUsd)+'</td><td>'+usd(v.outputUsd)+'</td><td><strong>'+usd(v.totalUsd)+'</strong></td></tr>').join('');
  $('savTable').innerHTML=svRows?'<table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Total</th></tr></thead><tbody>'+svRows+'</tbody></table>':'<div class="empty">No data yet</div>';

  const fl=d.flags||{};
  $('flagKpis').innerHTML=[
    {l:'Total Flags',v:fmt(fl.totalFlags||0)},
    {l:'On Pro Accounts',v:fmt(fl.onProAccounts||0)},
    {l:'On Free Accounts',v:fmt(fl.onFreeAccounts||0)},
    {l:'Avg Requests Before Flag',v:fmt(fl.avgRequestsBeforeFlag||0)},
  ].map(k=>'<div class="flag-kpi"><div class="label">'+esc(k.l)+'</div><div class="value">'+esc(k.v)+'</div></div>').join('');
  mkChart('cPatterns','bar',Object.keys(fl.byPattern||{}),[{label:'Count',data:Object.values(fl.byPattern||{}),backgroundColor:R}]);
  mkChart('cFlagModels','doughnut',Object.keys(fl.byModel||{}),[{data:Object.values(fl.byModel||{}),backgroundColor:C}]);
  mkChart('cTimerType','doughnut',Object.keys(fl.byTimerType||{}),[{data:Object.values(fl.byTimerType||{}),backgroundColor:['#63b3ed','#f6e05e','#68d391']}]);

  const tk=d.tokensByModel||{};
  $('tokTable').innerHTML=Object.keys(tk).length?'<table><thead><tr><th>Model</th><th>Input Tokens</th><th>Output Tokens</th><th>Requests</th></tr></thead><tbody>'+Object.entries(tk).map(([m,v])=>'<tr><td class="mono">'+esc(m)+'</td><td>'+fmt(v.input)+'</td><td>'+fmt(v.output)+'</td><td>'+fmt(v.requests)+'</td></tr>').join('')+'</tbody></table>':'<div class="empty">No token data yet</div>';

  mkChart('cVersions','bar',Object.keys(d.versions||{}),[{label:'Events',data:Object.values(d.versions||{}),backgroundColor:'#63b3ed'}]);
  mkChart('cOS','doughnut',Object.keys(d.os||{}),[{data:Object.values(d.os||{}),backgroundColor:C}]);
  mkChart('cModels','doughnut',Object.keys(d.modelsUsed||{}),[{data:Object.values(d.modelsUsed||{}),backgroundColor:C}]);
  mkChart('cHealth','doughnut',Object.keys(d.routingHealth||{}),[{data:Object.values(d.routingHealth||{}),backgroundColor:['#68d391','#f6e05e','#fc8181','#718096']}]);
  mkChart('cFeatures','bar',Object.keys(d.featuresUsed||{}),[{label:'Times used',data:Object.values(d.featuresUsed||{}),backgroundColor:'#b794f4'}]);
}

const saved=localStorage.getItem('st');
if(saved){_token=saved;$('tok').value=saved;setDashboardConnection('connecting','Connecting...');go({});}

// ── Installs list view ───────────────────────────────────────────────
var CURRENT_VIEW = 'agg';
var INSTALL_SORT = 'requests';
var INSTALL_SORT_DIR = -1;
var _installs = [];

function switchView(view) {
  CURRENT_VIEW = view;
  $('vtAgg').className  = 'view-tab' + (view === 'agg'  ? ' active' : '');
  $('vtList').className = 'view-tab' + (view === 'list' ? ' active' : '');
  $('filterBar').style.display = view === 'agg'  ? 'flex' : 'none';
  var ae = $('app'); if(ae) ae.style.display = view === 'agg' ? 'block' : 'none';
  var le = $('installsView'); if(le) le.style.display = view === 'list' ? 'block' : 'none';
  if (view === 'list') loadInstalls();
}

async function loadInstalls() {
  if (!_token) return;
  try {
    var r = await fetch('/v1/installs', { headers: { 'Authorization': 'Bearer ' + _token } });
    if (!r.ok) { showErr('Failed to load installs: ' + r.status); return; }
    _installs = await r.json();
    $('installCount').textContent = _installs.length + (_installs.length === 1 ? ' install' : ' installs');
    renderInstallList();
  } catch(e) { showErr(e.message); }
}

function setInstallSort(col) {
  if (INSTALL_SORT === col) { INSTALL_SORT_DIR = -INSTALL_SORT_DIR; }
  else { INSTALL_SORT = col; INSTALL_SORT_DIR = -1; }
  ['requests','savings','accounts','flags','lastseen'].forEach(function(c) {
    var b = $('isort-' + c);
    if (b) b.className = 'sort-btn' + (c === INSTALL_SORT ? ' active' : '');
  });
  renderInstallList();
}

function renderInstallList() {
  var wrap = $('installTableWrap');
  if (!wrap) return;
  var q = (($('installSearch')||{}).value||'').toLowerCase();
  var rows = _installs.slice().filter(function(r) {
    if (!q) return true;
    return r.installId.toLowerCase().indexOf(q)!==-1 ||
           (r.version||'').toLowerCase().indexOf(q)!==-1 ||
           (r.os||'').toLowerCase().indexOf(q)!==-1;
  });
  rows.sort(function(a,b) {
    var av,bv;
    if      (INSTALL_SORT==='requests') {av=a.totalRequests;bv=b.totalRequests;}
    else if (INSTALL_SORT==='savings')  {av=a.savingsUsd;bv=b.savingsUsd;}
    else if (INSTALL_SORT==='accounts') {av=a.accountCount;bv=b.accountCount;}
    else if (INSTALL_SORT==='flags')    {av=a.flagEvents;bv=b.flagEvents;}
    else if (INSTALL_SORT==='lastseen') {av=a.lastSeen;bv=b.lastSeen;}
    else {av=0;bv=0;}
    if(av<bv) return INSTALL_SORT_DIR;
    if(av>bv) return -INSTALL_SORT_DIR;
    return 0;
  });
  if (rows.length===0) { wrap.innerHTML='<div class="empty">No installs found.</div>'; return; }
  var HC={healthy:'#68d391',cooldown_wait:'#f6e05e',busy:'#63b3ed',paused:'#fc8181',stopped:'#fc8181'};
  function ar(col) {
    if(INSTALL_SORT!==col) return '<span class="arr">&#8597;</span>';
    return '<span class="arr">'+(INSTALL_SORT_DIR===-1?'&#8595;':'&#8593;')+'</span>';
  }
  var html='<table class="install-table"><thead><tr>'+
    '<th>Install ID</th>'+
    '<th onclick="setInstallSort(&apos;requests&apos;)" class="'+(INSTALL_SORT==='requests'?'sort-active':'')+'">Requests'+ar('requests')+'</th>'+
    '<th onclick="setInstallSort(&apos;accounts&apos;)" class="'+(INSTALL_SORT==='accounts'?'sort-active':'')+'">Accounts'+ar('accounts')+'</th>'+
    '<th onclick="setInstallSort(&apos;savings&apos;)"  class="'+(INSTALL_SORT==='savings' ?'sort-active':'')+'">Savings' +ar('savings') +'</th>'+
    '<th onclick="setInstallSort(&apos;flags&apos;)"    class="'+(INSTALL_SORT==='flags'   ?'sort-active':'')+'">Flags'   +ar('flags')   +'</th>'+
    '<th>Health</th>'+
    '<th>Version / OS</th>'+
    '<th onclick="setInstallSort(&apos;lastseen&apos;)" class="'+(INSTALL_SORT==='lastseen'?'sort-active':'')+'">Last Seen'+ar('lastseen')+'</th>'+
    '<th></th>'+
    '</tr></thead><tbody>';
  rows.forEach(function(r) {
    var hc=HC[r.routingHealthState]||'#718096';
    var shortId=esc(r.installId.slice(0,8)+'…');
    var ls=r.lastSeen?new Date(r.lastSeen).toLocaleString():'—';
    var fc=r.flagEvents>0?'#fc8181':'#718096';
    var pf='';
    if(r.proCount>0||r.freeCount>0)
      pf='<span style="color:#68d391;font-size:10px">P:'+r.proCount+'</span> <span style="color:#718096;font-size:10px">F:'+r.freeCount+'</span>';
    html+='<tr class="install-row" onclick="drillDown(&apos;'+jsString(r.installId)+'&apos;)">'+
      '<td><div class="install-id"><strong>'+shortId+'</strong>'+esc(r.installId.slice(8))+'</div></td>'+
      '<td style="font-family:monospace;font-weight:700">'+fmt(r.totalRequests)+'</td>'+
      '<td>'+esc(r.accountCount)+(pf?'<br>'+pf:'')+'</td>'+
      '<td style="color:#68d391;font-family:monospace;font-weight:700">'+usd(r.savingsUsd)+'</td>'+
      '<td style="color:'+fc+';font-weight:700;font-family:monospace">'+esc(r.flagEvents)+'</td>'+
      '<td><span class="health-dot" style="background:'+hc+'"></span><span style="font-size:11px;color:'+hc+'">'+escI(r.routingHealthState||'?')+'</span></td>'+
      '<td style="font-size:11px"><span style="color:#63b3ed">v'+escI(r.version)+'</span> <span style="color:#718096">'+escI(r.os)+'/'+escI(r.arch)+'</span></td>'+
      '<td style="font-size:11px;color:#718096;font-family:monospace">'+esc(ls)+'</td>'+
      '<td><button class="sort-btn" style="padding:3px 8px;font-size:10px" onclick="event.stopPropagation();drillDown(&apos;'+jsString(r.installId)+'&apos;)">Filter &#8594;</button></td>'+
      '</tr>';
  });
  html+='</tbody></table>';
  wrap.innerHTML=html;
}

function drillDown(installId) {
  switchView('agg');
  var sel=$('fInstall');
  if(sel) { sel.value=installId; }
  applyFilters();
}

function escI(s){if(!s)return '';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

setInterval(()=>{if(_token&&CURRENT_VIEW==='agg')go(currentFilters());},60000);
</script>
<div class="dashboard-shell" id="installsView" style="display:none">
  <div class="install-list-panel">
    <div class="install-heading"><div><div class="section-kicker">Fleet / Installations</div><h2>Connected installations</h2><p>Inspect routing health, usage and recent activity. Select a row to drill into its aggregate view.</p></div><span class="install-count" id="installCount">0 installs</span></div>
    <div class="install-toolbar">
      <label><span class="sr-only">Search installations</span><input class="install-search" id="installSearch" placeholder="Search installations..." oninput="renderInstallList()" /></label>
      <button class="sort-btn" id="isort-requests" type="button" onclick="setInstallSort(&apos;requests&apos;)">Requests</button>
      <button class="sort-btn" id="isort-savings" type="button" onclick="setInstallSort(&apos;savings&apos;)">Savings</button>
      <button class="sort-btn" id="isort-accounts" type="button" onclick="setInstallSort(&apos;accounts&apos;)">Accounts</button>
      <button class="sort-btn" id="isort-flags" type="button" onclick="setInstallSort(&apos;flags&apos;)">Flags</button>
      <button class="sort-btn" id="isort-lastseen" type="button" onclick="setInstallSort(&apos;lastseen&apos;)">Last seen</button>
    </div>
    <div id="installTableWrap"></div>
  </div>
</div>
</body></html>`;
}

// ── Notifications Admin UI ───────────────────────────────────────────
function buildNotificationsAdminHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Tuxevil Rotator — Notification Manager</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
.header{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:14px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:17px;font-weight:700;color:#fff}
.header .nav{margin-left:auto;display:flex;gap:10px;align-items:center}
.header .nav a{color:#718096;font-size:13px;text-decoration:none;padding:4px 10px;border-radius:6px;transition:color .2s,background .2s}
.header .nav a:hover{color:#e2e8f0;background:rgba(255,255,255,.06)}
.token-bar{background:#1a1f2e;border-bottom:1px solid #2d3748;padding:10px 24px;display:flex;gap:8px;align-items:center}
.token-bar input[type=password]{flex:1;background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:7px 12px;color:#e2e8f0;font-size:13px;font-family:monospace}
.token-bar input[type=password]:focus{outline:none;border-color:#4299e1}
.token-bar button{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap}
.token-bar button:hover{background:#3182ce}
.main{padding:20px 24px;max-width:1100px;margin:0 auto}
.section{background:#1a1f2e;border:1px solid #2d3748;border-radius:10px;padding:18px;margin-bottom:14px}
.section h2{font-size:11px;font-weight:700;color:#718096;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-group{display:flex;flex-direction:column;gap:4px}
.form-group.full{grid-column:1/-1}
.form-group label{font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.form-group input,.form-group textarea,.form-group select{background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:8px 12px;color:#e2e8f0;font-size:13px;font-family:inherit}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{outline:none;border-color:#4299e1}
.form-group textarea{min-height:80px;resize:vertical}
.form-actions{display:flex;gap:8px;margin-top:14px;grid-column:1/-1}
.btn-primary{background:#4299e1;color:#fff;border:none;border-radius:6px;padding:8px 20px;cursor:pointer;font-size:13px;font-weight:600}
.btn-primary:hover{background:#3182ce}
.btn-primary:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:#2d3748;color:#a0aec0;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px}
.btn-secondary:hover{background:#3d4a5e}
.btn-danger{background:rgba(248,113,113,.15);color:#fc8181;border:1px solid rgba(248,113,113,.3);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600}
.btn-danger:hover{background:rgba(248,113,113,.25)}
.btn-edit{background:rgba(66,153,225,.12);color:#63b3ed;border:1px solid rgba(66,153,225,.3);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600}
.btn-edit:hover{background:rgba(66,153,225,.22)}

table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 12px;color:#718096;border-bottom:1px solid #2d3748;font-weight:500;white-space:nowrap}
td{padding:7px 12px;border-bottom:1px solid #1f2535;color:#e2e8f0;vertical-align:top}
tr:last-child td{border-bottom:none}
.mono{font-family:monospace;color:#68d391;font-size:11px}
.type-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.type-info{background:rgba(66,153,225,.15);color:#63b3ed}
.type-warning{background:rgba(251,191,36,.15);color:#fbbf24}
.type-critical{background:rgba(248,113,113,.15);color:#fc8181}
.status-active{color:#68d391;font-weight:600;font-size:11px}
.status-expired{color:#718096;font-style:italic;font-size:11px}
.empty{color:#4a5568;font-size:12px;padding:20px;text-align:center}
.error{background:#2d1515;border:1px solid #742a2a;border-radius:8px;padding:12px;color:#fc8181;margin-bottom:14px}
.success{background:#1c2d1c;border:1px solid #276749;border-radius:8px;padding:12px;color:#68d391;margin-bottom:14px}

.preview{margin-top:14px;grid-column:1/-1}
.preview-label{font-size:10px;color:#718096;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;font-weight:700}
.preview-card{border-radius:10px;padding:14px 18px;display:flex;align-items:center;gap:12px}
.preview-card.p-info{background:linear-gradient(135deg,rgba(66,153,225,.12),rgba(99,179,237,.08));border:1px solid rgba(66,153,225,.35)}
.preview-card.p-warning{background:linear-gradient(135deg,rgba(251,191,36,.12),rgba(246,224,94,.08));border:1px solid rgba(251,191,36,.35)}
.preview-card.p-critical{background:linear-gradient(135deg,rgba(248,113,113,.12),rgba(252,129,129,.08));border:1px solid rgba(248,113,113,.35)}
.preview-icon{font-size:22px;flex-shrink:0}
.preview-content{flex:1;min-width:0}
.preview-title{font-weight:700;font-size:14px;margin-bottom:3px}
.preview-msg{font-size:12px;color:#a0aec0;line-height:1.4}
.preview-btn{display:inline-block;margin-top:6px;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none;border:1px solid rgba(255,255,255,.15);color:#e2e8f0;background:rgba(255,255,255,.06)}
.p-info .preview-title{color:#63b3ed}
.p-warning .preview-title{color:#fbbf24}
.p-critical .preview-title{color:#fc8181}
 .version-hint{font-size:10px;color:#4a5568;margin-top:2px}
 @media(max-width:700px){.form-grid{grid-template-columns:1fr}}
</style>
<style>
:root{color-scheme:dark;--bg:#0b0f17;--panel:#141b29;--panel-2:#192235;--line:#29364b;--muted:#7d8ca5;--text:#e8eef8;--blue:#78b7ff;--green:#72dfa0;--yellow:#f6d365;--red:#ff8b8b}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(circle at 20% -10%,#1c304b 0,#0f1117 38rem);color:var(--text);min-height:100vh}
button,input,textarea,select{font:inherit}
button{border:0}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
a{color:inherit}
.topbar{border-bottom:1px solid rgba(125,140,165,.18);background:rgba(11,15,23,.72);backdrop-filter:blur(14px)}
.topbar-inner{max-width:1240px;margin:0 auto;padding:17px 28px;display:flex;align-items:center;gap:24px}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none;min-width:0}
.brand-mark{width:31px;height:31px;border-radius:10px;background:linear-gradient(135deg,#78b7ff,#8b7dff);box-shadow:0 0 24px rgba(120,183,255,.25);position:relative;flex-shrink:0}
.brand-mark:after{content:'';position:absolute;width:9px;height:9px;border-radius:50%;background:#fff;left:11px;top:11px;box-shadow:0 0 0 4px rgba(255,255,255,.2)}
.brand strong{display:block;color:#fff;font-size:14px;letter-spacing:.01em}
.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-top:2px}
.nav{margin-left:auto;display:flex;align-items:center;gap:7px}
.nav a,.nav-lock{color:var(--muted);font-size:12px;text-decoration:none;padding:7px 10px;border-radius:7px;transition:color .2s,background .2s}
.nav a:hover{color:#fff;background:rgba(255,255,255,.07)}
.nav-lock{color:var(--green);background:rgba(114,223,160,.08);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.auth-strip{border-bottom:1px solid rgba(125,140,165,.18);background:rgba(20,27,41,.76)}
.auth-inner{max-width:1240px;margin:0 auto;padding:18px 28px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.auth-kicker,.eyebrow,.section-kicker{color:var(--blue);font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.auth-title{color:#fff;font-size:16px;font-weight:700;margin-top:4px}
.auth-note{color:var(--muted);font-size:12px;margin-top:3px}
.auth-controls{display:flex;align-items:center;gap:12px;min-width:min(100%,500px)}
.connection{display:flex;align-items:center;gap:7px;white-space:nowrap;color:var(--muted);font-size:11px;font-weight:600}
.connection-dot{width:8px;height:8px;border-radius:50%;background:#59677d;box-shadow:0 0 0 4px rgba(89,103,125,.12)}
.connection.connected{color:var(--green)}
.connection.connected .connection-dot{background:var(--green);box-shadow:0 0 0 4px rgba(114,223,160,.12)}
.connection.connecting{color:var(--yellow)}
.connection.connecting .connection-dot{background:var(--yellow);box-shadow:0 0 0 4px rgba(246,211,101,.12);animation:pulse 1.2s ease-in-out infinite}
.connection.error{color:var(--red)}
.connection.error .connection-dot{background:var(--red);box-shadow:0 0 0 4px rgba(255,139,139,.12)}
.token-form{display:flex;gap:8px;flex:1}
.token-form input{width:100%;min-width:0;background:#0b1019;border:1px solid var(--line);border-radius:8px;padding:9px 12px;color:var(--text);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.token-form input::placeholder{color:#56657c}
.token-form input:focus{border-color:var(--blue);outline:none;box-shadow:0 0 0 3px rgba(120,183,255,.12)}
.page{max-width:1240px;margin:0 auto;padding:38px 28px 64px}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:25px}
.hero h1{color:#fff;font-size:clamp(28px,4vw,43px);line-height:1.05;letter-spacing:-.045em;margin:10px 0}
.hero p{max-width:630px;color:#91a0b7;font-size:14px;line-height:1.6}
.hero-actions{display:flex;align-items:center;gap:12px;flex-shrink:0}
.sync-note{color:var(--muted);font-size:11px;white-space:nowrap}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.metric{position:relative;overflow:hidden;background:linear-gradient(145deg,rgba(25,34,53,.92),rgba(17,24,38,.92));border:1px solid var(--line);border-radius:13px;padding:17px 18px;min-height:105px}
.metric:after{content:'';position:absolute;width:80px;height:80px;border-radius:50%;right:-32px;bottom:-40px;background:var(--metric-color,#78b7ff);opacity:.08;filter:blur(4px)}
.metric-label{color:var(--muted);font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.metric-value{color:#fff;font-size:28px;font-weight:800;letter-spacing:-.04em;margin-top:11px}
.metric-sub{color:#61718a;font-size:10px;margin-top:3px}
.metric.blue{--metric-color:var(--blue)}.metric.green{--metric-color:var(--green)}.metric.yellow{--metric-color:var(--yellow)}.metric.red{--metric-color:var(--red)}
.metric.blue .metric-value{color:var(--blue)}.metric.green .metric-value{color:var(--green)}.metric.yellow .metric-value{color:var(--yellow)}.metric.red .metric-value{color:var(--red)}
.flash{border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:12px;line-height:1.4}
.error{background:rgba(255,139,139,.1);border:1px solid rgba(255,139,139,.32);color:var(--red)}
.success{background:rgba(114,223,160,.1);border:1px solid rgba(114,223,160,.3);color:var(--green)}
.workspace{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(320px,.82fr);gap:16px;align-items:start;margin-bottom:18px}
.panel{background:rgba(20,27,41,.9);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 45px rgba(0,0,0,.12)}
.compose-panel{padding:22px}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
.panel-title{color:#fff;font-size:18px;letter-spacing:-.02em;margin-top:6px}
.panel-description{color:var(--muted);font-size:12px;line-height:1.5;margin-top:5px}
.mode-pill,.count-pill{display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(120,183,255,.28);border-radius:999px;padding:5px 9px;color:var(--blue);background:rgba(120,183,255,.09);font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
.count-pill{padding:4px 8px;font-size:10px;color:var(--muted);background:rgba(125,140,165,.1);border-color:rgba(125,140,165,.2);letter-spacing:.02em;text-transform:none}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:17px 13px}
.form-group{display:flex;flex-direction:column;gap:6px;min-width:0}
.form-group.full{grid-column:1/-1}
.form-group label{color:#a9b6c9;font-size:11px;font-weight:700;letter-spacing:.04em}
.form-group input,.form-group textarea,.form-group select{width:100%;background:#0c121d;border:1px solid var(--line);border-radius:8px;padding:10px 12px;color:var(--text);font-size:13px;transition:border-color .2s,box-shadow .2s}
.form-group input::placeholder,.form-group textarea::placeholder{color:#56657c}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{border-color:var(--blue);outline:none;box-shadow:0 0 0 3px rgba(120,183,255,.1)}
.form-group textarea{min-height:116px;resize:vertical;line-height:1.5}
.field-meta{display:flex;justify-content:space-between;gap:12px;color:#5f7089;font-size:10px;margin-top:-1px}
.form-divider{grid-column:1/-1;display:flex;align-items:center;gap:10px;color:#62728a;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin:1px 0 -3px}
.form-divider:after{content:'';height:1px;background:var(--line);flex:1}
.form-actions{display:flex;align-items:center;gap:9px;margin-top:3px;grid-column:1/-1}
.btn-primary,.btn-secondary,.btn-ghost,.btn-danger,.btn-edit{border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;transition:background .2s,border-color .2s,color .2s,transform .2s}
.btn-primary{background:var(--blue);color:#08111d;padding:10px 17px;box-shadow:0 8px 22px rgba(120,183,255,.16)}
.btn-primary:hover{background:#9bcaff;transform:translateY(-1px)}
.btn-primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn-secondary{background:#26334a;color:#b5c3d6;padding:10px 15px}
.btn-secondary:hover{background:#33435c;color:#fff}
.btn-ghost{background:rgba(120,183,255,.08);border:1px solid rgba(120,183,255,.25);color:var(--blue);padding:8px 12px}
.btn-ghost:hover{background:rgba(120,183,255,.15);border-color:rgba(120,183,255,.5)}
.btn-danger{background:rgba(255,139,139,.08);border:1px solid rgba(255,139,139,.24);color:var(--red);padding:7px 10px}
.btn-danger:hover{background:rgba(255,139,139,.17);border-color:rgba(255,139,139,.46)}
.btn-edit{background:rgba(120,183,255,.08);border:1px solid rgba(120,183,255,.24);color:var(--blue);padding:7px 10px}
.btn-edit:hover{background:rgba(120,183,255,.16);border-color:rgba(120,183,255,.46)}
.preview-panel{position:sticky;top:18px;padding:22px}
.preview-panel .panel-head{margin-bottom:16px}
.preview-shell{background:#0b1019;border:1px solid #233047;border-radius:12px;padding:10px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)}
.preview-chrome{display:flex;align-items:center;gap:5px;padding:3px 5px 10px}
.preview-chrome i{width:6px;height:6px;border-radius:50%;background:#405069}
.preview-chrome span{margin-left:6px;color:#52627a;font-size:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.preview-card{border-radius:10px;padding:19px;display:flex;align-items:flex-start;gap:13px;min-height:164px;transition:background .2s,border-color .2s}
.preview-card.p-info{background:linear-gradient(145deg,rgba(66,153,225,.16),rgba(27,46,72,.55));border:1px solid rgba(120,183,255,.38)}
.preview-card.p-warning{background:linear-gradient(145deg,rgba(246,211,101,.14),rgba(62,54,30,.55));border:1px solid rgba(246,211,101,.4)}
.preview-card.p-critical{background:linear-gradient(145deg,rgba(255,139,139,.14),rgba(65,35,42,.55));border:1px solid rgba(255,139,139,.4)}
.preview-icon{width:29px;height:29px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:rgba(255,255,255,.12);color:#fff;font-weight:800;font-size:14px;flex-shrink:0}
.preview-content{flex:1;min-width:0}
.preview-eyebrow{color:#7890ac;font-size:9px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;margin-bottom:7px}
.preview-title{font-weight:800;font-size:16px;line-height:1.25;margin-bottom:6px;color:#fff;overflow-wrap:anywhere}
.preview-msg{font-size:12px;color:#a9b7ca;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.preview-action{display:inline-flex;margin-top:13px;padding:6px 10px;border-radius:7px;font-size:11px;font-weight:700;text-decoration:none;border:1px solid rgba(255,255,255,.16);color:#e8eef8;background:rgba(255,255,255,.07)}
.p-info .preview-title{color:#9bcaff}.p-warning .preview-title{color:#f6d365}.p-critical .preview-title{color:#ffaaaa}
.preview-details{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.preview-detail{background:rgba(255,255,255,.035);border:1px solid rgba(125,140,165,.13);border-radius:8px;padding:9px 10px}
.preview-detail span{display:block;color:#63728a;font-size:9px;text-transform:uppercase;letter-spacing:.08em;font-weight:800}
.preview-detail strong{display:block;color:#b7c4d5;font-size:11px;margin-top:4px;font-weight:600;overflow-wrap:anywhere}
.preview-note{color:#63728a;font-size:10px;line-height:1.45;margin-top:12px}
.list-panel{padding:22px}
.list-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}
.list-head h2{display:flex;align-items:center;gap:9px;color:#fff;font-size:18px;letter-spacing:-.02em;margin-top:6px}
.list-head p{color:var(--muted);font-size:12px;margin-top:5px}
.list-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.search-wrap{position:relative;flex:1;min-width:190px}
.search-wrap input,.list-tools select{width:100%;background:#0c121d;border:1px solid var(--line);border-radius:8px;padding:9px 11px;color:var(--text);font-size:12px}
.search-wrap input::placeholder{color:#56657c}
.list-tools select{width:auto;min-width:120px}
.search-wrap input:focus,.list-tools select:focus{border-color:var(--blue);outline:none;box-shadow:0 0 0 3px rgba(120,183,255,.1)}
.notification-list{display:flex;flex-direction:column;gap:8px}
.notification-row{display:flex;position:relative;overflow:hidden;background:rgba(11,16,25,.6);border:1px solid #243148;border-radius:11px;transition:border-color .2s,background .2s,transform .2s}
.notification-row:hover{background:rgba(25,34,53,.7);border-color:#3a4c69;transform:translateY(-1px)}
.notification-accent{width:3px;background:var(--blue);flex-shrink:0}.notification-row.type-warning .notification-accent{background:var(--yellow)}.notification-row.type-critical .notification-accent{background:var(--red)}
.notification-main{min-width:0;flex:1;padding:15px 16px}
.notification-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
.notification-title{color:#fff;font-size:13px;font-weight:750;overflow-wrap:anywhere}
.notification-message{color:#94a3b8;font-size:12px;line-height:1.5;margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.notification-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:11px;color:#667791;font-size:10px}
.meta-chip{display:inline-flex;align-items:center;gap:4px;background:rgba(125,140,165,.08);border:1px solid rgba(125,140,165,.14);border-radius:999px;padding:4px 7px}
.type-badge,.status-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
.type-badge.info{background:rgba(120,183,255,.12);color:var(--blue)}.type-badge.warning{background:rgba(246,211,101,.12);color:var(--yellow)}.type-badge.critical{background:rgba(255,139,139,.12);color:var(--red)}
.status-badge.active{background:rgba(114,223,160,.1);color:var(--green)}.status-badge.expired{background:rgba(125,140,165,.1);color:#8796ad}
.notification-actions{display:flex;align-items:center;gap:7px;padding:15px 16px;flex-shrink:0}
.empty{border:1px dashed #33445e;border-radius:11px;color:#6e7e96;font-size:12px;line-height:1.5;padding:32px 20px;text-align:center}
.version-hint{color:#5f7089;font-size:10px;font-weight:400;margin-left:3px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes pulse{50%{opacity:.45}}
@media(max-width:960px){.auth-inner{align-items:flex-start;flex-direction:column;gap:14px}.auth-controls{width:100%;max-width:none}.workspace{grid-template-columns:1fr}.preview-panel{position:static}.metrics{grid-template-columns:repeat(2,1fr)}}
@media(max-width:650px){.topbar-inner,.auth-inner,.page{padding-left:17px;padding-right:17px}.topbar-inner{gap:12px}.nav a{display:none}.nav-lock{padding:6px 8px}.page{padding-top:28px}.hero{align-items:flex-start;flex-direction:column;margin-bottom:20px}.hero-actions{width:100%;justify-content:space-between}.metrics{gap:8px}.metric{min-height:92px;padding:14px}.metric-value{font-size:24px}.compose-panel,.preview-panel,.list-panel{padding:17px}.form-grid{grid-template-columns:1fr;gap:15px}.form-divider,.form-group.full,.form-actions{grid-column:auto}.list-head{flex-direction:column;gap:8px}.list-tools{align-items:stretch;flex-direction:column}.search-wrap,.list-tools select{width:100%}.notification-row{display:block}.notification-actions{padding:0 16px 15px}.auth-controls{align-items:stretch;flex-direction:column}.token-form{width:100%}}
</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/notifications">
      <span class="brand-mark" aria-hidden="true"></span>
      <span><strong>Tuxevil Rotator</strong><small>Operations</small></span>
    </a>
    <nav class="nav" aria-label="Operator navigation">
      <a href="/">Telemetry</a>
      <a href="/stats">Public stats</a>
      <span class="nav-lock">Private</span>
    </nav>
  </div>
</header>
<section class="auth-strip">
  <div class="auth-inner">
    <div>
      <div class="auth-kicker">Operator access</div>
      <div class="auth-title">Notification Manager</div>
      <div class="auth-note">Connect with STATS_TOKEN to publish and manage broadcasts.</div>
    </div>
    <div class="auth-controls">
      <div class="connection" id="connectionState"><span class="connection-dot" id="connectionDot"></span><span id="connectionLabel">Not connected</span></div>
      <form class="token-form" id="authForm" onsubmit="authenticate(event)">
        <label class="sr-only" for="tok">STATS_TOKEN</label>
        <input type="password" id="tok" autocomplete="current-password" placeholder="Paste STATS_TOKEN" />
        <button class="btn-primary" id="connectBtn" type="submit">Connect</button>
      </form>
    </div>
  </div>
</section>

<main class="page">
  <div class="flash error" id="errMsg" style="display:none"></div>
  <div class="flash success" id="successMsg" style="display:none"></div>

  <div id="authedContent" style="display:none">
    <section class="hero">
      <div>
        <div class="eyebrow">Operations / Broadcasts</div>
        <h1>Keep operators in the loop.</h1>
        <p>Compose clear, targeted announcements for every connected rotator. Preview the client-facing card before it reaches users.</p>
      </div>
      <div class="hero-actions">
        <span class="sync-note" id="lastSync">Not synced</span>
        <button class="btn-ghost" id="refreshBtn" type="button" onclick="refreshList()">Refresh</button>
      </div>
    </section>

    <section class="metrics" aria-label="Notification summary">
      <article class="metric blue"><div class="metric-label">Total</div><div class="metric-value" id="metricTotal">0</div><div class="metric-sub">All saved broadcasts</div></article>
      <article class="metric green"><div class="metric-label">Live</div><div class="metric-value" id="metricActive">0</div><div class="metric-sub">Currently deliverable</div></article>
      <article class="metric yellow"><div class="metric-label">Expiring</div><div class="metric-value" id="metricExpiring">0</div><div class="metric-sub">Have a future expiry</div></article>
      <article class="metric red"><div class="metric-label">Expired</div><div class="metric-value" id="metricExpired">0</div><div class="metric-sub">Kept for audit history</div></article>
    </section>

    <div class="workspace">
      <section class="panel compose-panel" id="composePanel">
        <div class="panel-head">
          <div>
            <div class="section-kicker">Message studio</div>
            <h2 class="panel-title" id="formTitle">Compose new notification</h2>
            <p class="panel-description" id="formDescription">Write a concise update, then target the right client versions.</p>
          </div>
          <span class="mode-pill" id="formMode">New</span>
        </div>
        <form id="notificationForm" onsubmit="submitNotification(event)">
          <div class="form-grid">
            <input type="hidden" id="editId" value="" />
            <div class="form-group">
              <label for="nType">Severity</label>
              <select id="nType" onchange="updatePreview()">
                <option value="info">Info - routine update</option>
                <option value="warning">Warning - action recommended</option>
                <option value="critical">Critical - action required</option>
              </select>
            </div>
            <div class="form-group">
              <label for="nExpires">Expiry <span class="version-hint">optional</span></label>
              <input type="datetime-local" id="nExpires" onchange="updatePreview()" />
            </div>
            <div class="form-group full">
              <label for="nTitle">Headline</label>
              <input type="text" id="nTitle" maxlength="2048" placeholder="Short headline for the notification" oninput="updatePreview()" />
            </div>
            <div class="form-group full">
              <label for="nMessage">Message</label>
              <textarea id="nMessage" maxlength="2048" placeholder="Explain what changed and what users need to do." oninput="updatePreview()"><\/textarea>
              <div class="field-meta"><span>Shown in the client broadcast banner</span><span id="messageCount">0 / 2048</span></div>
            </div>
            <div class="form-divider">Delivery targeting</div>
            <div class="form-group">
              <label for="nMinVer">Minimum version <span class="version-hint">inclusive</span></label>
              <input type="text" id="nMinVer" maxlength="2048" placeholder="e.g. 1.0.0" onchange="updatePreview()" />
            </div>
            <div class="form-group">
              <label for="nMaxVer">Maximum version <span class="version-hint">inclusive</span></label>
              <input type="text" id="nMaxVer" maxlength="2048" placeholder="e.g. 1.5.1" onchange="updatePreview()" />
            </div>
            <div class="form-group">
              <label for="nActionUrl">Action URL <span class="version-hint">optional</span></label>
              <input type="text" id="nActionUrl" maxlength="2048" placeholder="https://github.com/..." oninput="updatePreview()" />
            </div>
            <div class="form-group">
              <label for="nActionLabel">Action label <span class="version-hint">optional</span></label>
              <input type="text" id="nActionLabel" maxlength="2048" placeholder="e.g. View README" oninput="updatePreview()" />
            </div>
            <div class="form-actions">
              <button class="btn-primary" id="btnSubmit" type="submit">Publish notification</button>
              <button class="btn-secondary" id="btnCancel" type="button" onclick="cancelEdit()" style="display:none">Cancel edit</button>
            </div>
          </div>
        </form>
      </section>

      <aside class="panel preview-panel" aria-label="Live notification preview">
        <div class="panel-head">
          <div>
            <div class="section-kicker">Client preview</div>
            <h2 class="panel-title">This is what users see.</h2>
          </div>
        </div>
        <div class="preview-shell">
          <div class="preview-chrome"><i></i><i></i><i></i><span>tuxevil rotator / broadcast</span></div>
          <div class="preview-card p-info" id="previewCard">
            <span class="preview-icon" id="previewIcon">i</span>
            <div class="preview-content">
              <div class="preview-eyebrow" id="previewType">Info update</div>
              <div class="preview-title" id="previewTitle">Notification title</div>
              <div class="preview-msg" id="previewMsg">Notification message will appear here.</div>
              <a class="preview-action" id="previewAction" href="#" onclick="return false" style="display:none">Learn more</a>
            </div>
          </div>
          <div class="preview-details">
            <div class="preview-detail"><span>Audience</span><strong id="previewAudience">All versions</strong></div>
            <div class="preview-detail"><span>Availability</span><strong id="previewExpiry">No expiry</strong></div>
          </div>
        </div>
        <p class="preview-note">The preview updates as you type. Version targeting is applied when clients poll for active notifications.</p>
      </aside>
    </div>

    <section class="panel list-panel">
      <div class="list-head">
        <div>
          <div class="section-kicker">Broadcast library</div>
          <h2>All notifications <span class="count-pill" id="notifCount">0 shown</span></h2>
          <p>Review active and historical messages, or edit a broadcast in place.</p>
        </div>
      </div>
      <div class="list-tools">
        <label class="search-wrap"><span class="sr-only">Search notifications</span><input type="search" id="notifSearch" placeholder="Search title or message..." oninput="renderTable()" /></label>
        <label><span class="sr-only">Filter by status</span><select id="notifStatus" onchange="renderTable()"><option value="all">All statuses</option><option value="active">Live only</option><option value="expired">Expired only</option></select></label>
        <label><span class="sr-only">Filter by severity</span><select id="notifTypeFilter" onchange="renderTable()"><option value="all">All severities</option><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label>
        <button class="btn-ghost" type="button" onclick="refreshList()">Sync list</button>
      </div>
      <div class="notification-list" id="notifTable"></div>
    </section>
  </div>
</main>

<script>

var _token = '';
var _notifications = [];

function $(i) { return document.getElementById(i); }

function setConnection(state, label) {
  var el = $('connectionState');
  el.className = 'connection' + (state ? ' ' + state : '');
  $('connectionLabel').textContent = label;
}

function authenticate(event) {
  if (event) event.preventDefault();
  var t = $('tok').value.trim();
  if (!t) return;
  _token = t;
  localStorage.setItem('notif_token', t);
  loadAll();
}

async function loadAll() {
  setConnection('connecting', 'Connecting...');
  $('connectBtn').disabled = true;
  try {
    var r = await fetch('/v1/stats', { headers: { 'Authorization': 'Bearer ' + _token } });
    if (r.status === 401) throw new Error('Invalid token');
    if (!r.ok) throw new Error('Unable to connect (HTTP ' + r.status + ')');
    hideErr();
    $('authedContent').style.display = 'block';
    if (await refreshList()) setConnection('connected', 'Connected');
    else setConnection('error', 'Connection failed');
  } catch(e) {
    $('authedContent').style.display = 'none';
    setConnection('error', 'Connection failed');
    showErr(e.message);
  } finally {
    $('connectBtn').disabled = false;
  }
}

async function refreshList() {
  if (!_token) return false;
  var refreshButton = $('refreshBtn');
  if (refreshButton) refreshButton.disabled = true;
  try {
    var r = await fetch('/v1/notifications?all=true', {
      headers: { 'Authorization': 'Bearer ' + _token }
    });
    if (r.status === 401) {
      $('authedContent').style.display = 'none';
      setConnection('error', 'Session expired');
      throw new Error('Session expired. Connect again.');
    }
    if (!r.ok) throw new Error('Failed to load notifications (HTTP ' + r.status + ')');
    _notifications = await r.json();
    renderTable();
    updateOverview();
    $('lastSync').textContent = 'Synced ' + new Date().toLocaleTimeString();
    return true;
  } catch(e) {
    showErr(e.message);
    return false;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

function isExpired(n, now) {
  if (!n.expiresAt) return false;
  var timestamp = Date.parse(n.expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

function formatDate(value) {
  if (!value) return 'Unknown date';
  var date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleString();
}

function audienceLabel(n) {
  if (n.minVersion && n.maxVersion) return 'v' + n.minVersion + ' - v' + n.maxVersion;
  if (n.minVersion) return 'v' + n.minVersion + ' and newer';
  if (n.maxVersion) return 'Up to v' + n.maxVersion;
  return 'All versions';
}

function updateOverview() {
  var now = Date.now();
  var expired = _notifications.filter(function(n) { return isExpired(n, now); }).length;
  var expiring = _notifications.filter(function(n) { return Boolean(n.expiresAt) && !isExpired(n, now); }).length;
  $('metricTotal').textContent = _notifications.length;
  $('metricActive').textContent = _notifications.length - expired;
  $('metricExpiring').textContent = expiring;
  $('metricExpired').textContent = expired;
}

function renderTable() {
  var tb = $('notifTable');
  var query = (($('notifSearch') || {}).value || '').trim().toLowerCase();
  var statusFilter = ($('notifStatus') || {}).value || 'all';
  var typeFilter = ($('notifTypeFilter') || {}).value || 'all';
  var now = Date.now();
  var rows = _notifications.map(function(n, index) { return { notification: n, index: index }; }).filter(function(entry) {
    var n = entry.notification;
    var expired = isExpired(n, now);
    var haystack = [n.title, n.message, n.actionLabel, n.minVersion, n.maxVersion].filter(Boolean).join(' ').toLowerCase();
    if (query && haystack.indexOf(query) === -1) return false;
    if (statusFilter === 'active' && expired) return false;
    if (statusFilter === 'expired' && !expired) return false;
    if (typeFilter !== 'all' && n.type !== typeFilter) return false;
    return true;
  });

  $('notifCount').textContent = rows.length + ' shown';
  if (rows.length === 0) {
    tb.innerHTML = _notifications.length === 0
      ? '<div class="empty">No notifications yet. Compose the first broadcast above.</div>'
      : '<div class="empty">No notifications match these filters.<br>Try a different search or status.</div>';
    return;
  }

  var html = '';
  rows.forEach(function(entry) {
    var n = entry.notification;
    var expired = isExpired(n, now);
    var type = ['info', 'warning', 'critical'].includes(n.type) ? n.type : 'info';
    var message = String(n.message || '');
    var messagePreview = message.length > 220 ? message.slice(0, 220) + '...' : message;
    var expiry = n.expiresAt ? (expired ? 'Expired ' : 'Expires ') + formatDate(n.expiresAt) : 'No expiry';
    var action = n.actionUrl ? '<span class="meta-chip">Action: ' + esc(n.actionLabel || 'Open link') + '</span>' : '';
    html += '<article class="notification-row type-' + type + '">' +
      '<div class="notification-accent"></div>' +
      '<div class="notification-main">' +
        '<div class="notification-top">' +
          '<div class="notification-title">' + esc(n.title || 'Untitled notification') + '</div>' +
          '<span class="status-badge ' + (expired ? 'expired' : 'active') + '">' + (expired ? 'Expired' : 'Live') + '</span>' +
        '</div>' +
        '<div class="notification-message">' + esc(messagePreview) + '</div>' +
        '<div class="notification-meta">' +
          '<span class="type-badge ' + type + '">' + type + '</span>' +
          '<span class="meta-chip">Audience: ' + esc(audienceLabel(n)) + '</span>' +
          '<span class="meta-chip">' + esc(expiry) + '</span>' +
          '<span class="meta-chip">Created ' + esc(formatDate(n.createdAt)) + '</span>' +
          action +
        '</div>' +
      '</div>' +
      '<div class="notification-actions">' +
        '<button class="btn-edit" type="button" onclick="editNotif(' + entry.index + ')">Edit</button>' +
        '<button class="btn-danger" type="button" onclick="deleteNotif(\\'' + jsString(n.id) + '\\')">Delete</button>' +
      '</div>' +
    '</article>';
  });
  tb.innerHTML = html;
}

function editNotif(idx) {
  var n = _notifications[idx];
  if (!n) return;
  $('editId').value = n.id;
  $('nType').value = n.type || 'info';
  $('nTitle').value = n.title || '';
  $('nMessage').value = n.message || '';
  $('nMinVer').value = n.minVersion || '';
  $('nMaxVer').value = n.maxVersion || '';
  $('nActionUrl').value = n.actionUrl || '';
  $('nActionLabel').value = n.actionLabel || '';
  if (n.expiresAt) {
    $('nExpires').value = n.expiresAt.slice(0, 16);
  } else {
    $('nExpires').value = '';
  }
  $('formTitle').textContent = 'Edit notification';
  $('formDescription').textContent = 'Update the message or delivery rules, then save the revised broadcast.';
  $('formMode').textContent = 'Editing';
  $('btnSubmit').textContent = 'Save changes';
  $('btnCancel').style.display = '';
  updatePreview();
  $('composePanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function cancelEdit() {
  $('editId').value = '';
  $('nType').value = 'info';
  $('nTitle').value = '';
  $('nMessage').value = '';
  $('nMinVer').value = '';
  $('nMaxVer').value = '';
  $('nActionUrl').value = '';
  $('nActionLabel').value = '';
  $('nExpires').value = '';
  $('formTitle').textContent = 'Compose new notification';
  $('formDescription').textContent = 'Write a concise update, then target the right client versions.';
  $('formMode').textContent = 'New';
  $('btnSubmit').textContent = 'Publish notification';
  $('btnCancel').style.display = 'none';
  updatePreview();
}

async function submitNotification(event) {
  if (event) event.preventDefault();
  var title = $('nTitle').value.trim();
  var message = $('nMessage').value.trim();
  if (!title || !message) { showErr('Title and message are required'); return; }

  var payload = {
    type: $('nType').value,
    title: title,
    message: message,
    minVersion: $('nMinVer').value.trim() || null,
    maxVersion: $('nMaxVer').value.trim() || null,
    actionUrl: $('nActionUrl').value.trim() || null,
    actionLabel: $('nActionLabel').value.trim() || null,
    expiresAt: $('nExpires').value ? new Date($('nExpires').value).toISOString() : null,
  };

  var editId = $('editId').value;
  if (editId) payload.id = editId;

  var button = $('btnSubmit');
  button.disabled = true;
  button.textContent = editId ? 'Saving changes...' : 'Publishing...';
  try {
    var r = await fetch('/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token },
      body: JSON.stringify(payload),
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      showSuccess(editId ? 'Notification updated!' : 'Notification created!');
      cancelEdit();
      await refreshList();
    } else {
      showErr(result.error || 'Failed to save notification');
    }
  } catch(e) {
    showErr(e.message);
  } finally {
    button.disabled = false;
    if ($('editId').value) button.textContent = 'Save changes';
    else button.textContent = 'Publish notification';
  }
}

async function deleteNotif(id) {
  if (!confirm('Delete this notification?')) return;
  try {
    var r = await fetch('/v1/notifications/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + _token },
    });
    var result = await r.json();
    if (r.ok && result.ok) {
      showSuccess('Notification deleted');
      await refreshList();
    } else {
      showErr(result.error || 'Failed to delete');
    }
  } catch(e) { showErr(e.message); }
}

var ICONS = { info: 'i', warning: '!', critical: '!' };
var TYPE_LABELS = { info: 'Info update', warning: 'Warning', critical: 'Critical alert' };

function updatePreview() {
  var type = $('nType').value;
  var title = $('nTitle').value || 'Notification title';
  var msg = $('nMessage').value || 'Notification message will appear here';
  var actionUrl = $('nActionUrl').value;
  var actionLabel = $('nActionLabel').value || 'Learn More';
  var card = $('previewCard');
  card.className = 'preview-card p-' + type;
  $('previewIcon').textContent = ICONS[type] || ICONS.info;
  $('previewType').textContent = TYPE_LABELS[type] || TYPE_LABELS.info;
  $('previewTitle').textContent = title;
  $('previewMsg').textContent = msg;
  var action = $('previewAction');
  action.textContent = actionLabel;
  action.href = /^https?:\\/\\//i.test(actionUrl) ? actionUrl : '#';
  action.style.display = actionUrl ? 'inline-flex' : 'none';
  var minVersion = $('nMinVer').value.trim();
  var maxVersion = $('nMaxVer').value.trim();
  if (minVersion && maxVersion) $('previewAudience').textContent = 'v' + minVersion + ' - v' + maxVersion;
  else if (minVersion) $('previewAudience').textContent = 'v' + minVersion + ' and newer';
  else if (maxVersion) $('previewAudience').textContent = 'Up to v' + maxVersion;
  else $('previewAudience').textContent = 'All versions';
  var expiry = $('nExpires').value;
  $('previewExpiry').textContent = expiry ? formatDate(new Date(expiry).toISOString()) : 'No expiry';
  updateMessageCount();
}

function updateMessageCount() {
  var message = $('nMessage').value || '';
  $('messageCount').textContent = message.length + ' / 2048';
}

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function jsString(s) {
  return esc(String(s == null ? '' : s)
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/\\r/g, '\\\\r')
    .replace(/\\n/g, '\\\\n'));
}
function showErr(m) { $('errMsg').textContent = 'Error: ' + m; $('errMsg').style.display = ''; setTimeout(function(){ $('errMsg').style.display='none'; }, 8000); }
function hideErr() { $('errMsg').style.display = 'none'; }
function showSuccess(m) { $('successMsg').textContent = 'Saved: ' + m; $('successMsg').style.display = ''; setTimeout(function(){ $('successMsg').style.display='none'; }, 4000); }

// Auto-connect from saved token
var saved = localStorage.getItem('notif_token');
if (saved) { _token = saved; $('tok').value = saved; loadAll(); }
updatePreview();
updateMessageCount();
<\/script>
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
	res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
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
			const notification = {
				id: data.id || randomUUID(),
				type: data.type || "info",
				title: data.title,
				message: data.message,
				createdAt: data.createdAt || new Date().toISOString(),
				expiresAt: data.expiresAt || null,
				minVersion: data.minVersion || null,
				maxVersion: data.maxVersion || null,
				actionUrl: data.actionUrl || null,
				actionLabel: data.actionLabel || null,
			};
			// Update if id exists, otherwise add
			const existingIdx = notifications.findIndex((n) => n.id === notification.id);
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
			if (q.from)    filters.from    = q.from;
			if (q.to)      filters.to      = q.to;
			if (q.version) filters.version = q.version;
			if (q.os)      filters.os      = q.os;
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
