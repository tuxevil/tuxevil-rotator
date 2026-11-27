// Notification poller — fetches admin broadcast notifications from the telemetry server
//
// Polls GET /v1/notifications?version=x.y.z every 30 minutes.
// Respects TUXEVIL_ROTATOR_TELEMETRY=off — if telemetry is disabled, no polling.
// Fire-and-forget: never throws, never blocks, never affects core rotator flow.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { isTelemetryEnabled } from "./telemetry.js";
import { rotatorEnv } from "./env.js";

const notifLogger = logger.child("notifications");

// Same base URL as telemetry endpoint (just different path)
const DEFAULT_TELEMETRY_BASE = "https://telemetry.tuxevil.com";

export function resolveTelemetryBase(raw: string | undefined): string {
	const candidate = raw?.trim();
	if (!candidate) return DEFAULT_TELEMETRY_BASE;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
		let pathname = url.pathname.replace(/\/+$/, "");
		if (pathname.endsWith("/v1/events")) {
			pathname = pathname.slice(0, -"/v1/events".length);
		} else if (pathname.endsWith("/v1/notifications")) {
			pathname = pathname.slice(0, -"/v1/notifications".length);
		} else if (pathname.endsWith("/events")) {
			pathname = pathname.slice(0, -"/events".length);
		}
		return `${url.origin}${pathname}`;
	} catch {
		notifLogger.log(
			"warn",
			"Ignoring invalid TUXEVIL_ROTATOR_TELEMETRY_URL for notifications; using the default HTTPS endpoint.",
		);
		return DEFAULT_TELEMETRY_BASE;
	}
}

const TELEMETRY_BASE = resolveTelemetryBase(rotatorEnv("TELEMETRY_URL"));
const NOTIFICATIONS_URL = `${TELEMETRY_BASE}/v1/notifications`;

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;

export interface AdminNotification {
	id: string;
	type: "info" | "warning" | "critical";
	title: string;
	message: string;
	createdAt: string;
	actionUrl?: string | null;
	actionLabel?: string | null;
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

// ── Cached notifications ─────────────────────────────────────────────
let _notifications: AdminNotification[] = [];
let _initialPollTimer: ReturnType<typeof setTimeout> | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Fetch notifications from the telemetry server.
 */
async function fetchNotifications(): Promise<void> {
	try {
		const version = getVersion();
		const url = version !== "unknown"
			? `${NOTIFICATIONS_URL}?version=${encodeURIComponent(version)}`
			: NOTIFICATIONS_URL;

		const response = await fetch(url, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});

		if (!response.ok) {
			notifLogger.log("info", `Notification poll returned ${response.status}`);
			return;
		}

		const data = (await response.json()) as AdminNotification[];
		if (Array.isArray(data)) {
			_notifications = data;
			if (data.length > 0) {
				notifLogger.log("debug", `Fetched ${data.length} notification(s)`);
			}
		}
	} catch {
		// Fire-and-forget: network errors are expected (offline, server down, etc.)
		// Never crash, never surface errors to user.
	}
}

/**
 * Get the cached notifications. Returns immediately.
 */
export function getNotifications(): AdminNotification[] {
	return [..._notifications];
}

/**
 * Start periodic notification polling.
 * Initial fetch after a short delay (15s) to avoid slowing down startup.
 */
export function startNotificationPoller(): void {
	if (!isTelemetryEnabled()) {
		notifLogger.log("debug", "Notification polling disabled (telemetry off)");
		return;
	}

	// Initial delayed fetch
	if (!_initialPollTimer) {
		_initialPollTimer = setTimeout(() => {
			_initialPollTimer = null;
			void fetchNotifications();
		}, 15_000);
		if (_initialPollTimer.unref) {
			_initialPollTimer.unref();
		}
	}

	// Periodic poll
	if (!_pollTimer) {
		_pollTimer = setInterval(() => {
			void fetchNotifications();
		}, POLL_INTERVAL_MS);

		// Don't prevent process exit
		if (_pollTimer.unref) {
			_pollTimer.unref();
		}
	}
}

/**
 * Stop notification polling.
 */
export function stopNotificationPoller(): void {
	if (_initialPollTimer) {
		clearTimeout(_initialPollTimer);
		_initialPollTimer = null;
	}
	if (_pollTimer) {
		clearInterval(_pollTimer);
		_pollTimer = null;
	}
}
