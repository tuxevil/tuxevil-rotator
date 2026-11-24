import { createHash, randomBytes } from "node:crypto";
import {
	ANTIGRAVITY_CLIENT_METADATA,
	CLIENT_ID,
	CLIENT_SECRET,
	REQUEST_USER_AGENT,
	TOKEN_URL,
} from "../../types.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";

export const DEFAULT_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export interface OAuthClientConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export interface TokenExchangeResult {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export function getOAuthClientConfig(
	env: NodeJS.ProcessEnv = process.env,
): OAuthClientConfig {
	const clientId = env.ANTIGRAVITY_CLIENT_ID?.trim() || CLIENT_ID;
	const clientSecret = env.ANTIGRAVITY_CLIENT_SECRET?.trim() || CLIENT_SECRET;
	const redirectUri = env.ANTIGRAVITY_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
	try {
		const redirectUrl = new URL(redirectUri);
		if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
			throw new Error("unsupported protocol");
		}
	} catch {
		throw new Error("Invalid OAuth redirect URI: use an absolute http:// or https:// URL.");
	}

	return {
		clientId,
		clientSecret,
		redirectUri,
	};
}

let warnedAboutFallback = false;

/**
 * Check whether the rotator is using the legacy compatibility OAuth client.
 * Operator-provided credentials always take precedence. The fallback remains
 * available so existing installations do not break during upgrades.
 *
 * The warning is printed at most once per process to avoid log spam.
 */
export function warnIfUsingFallbackOAuthCreds(env: NodeJS.ProcessEnv = process.env): boolean {
	const usingFallbackId = !env.ANTIGRAVITY_CLIENT_ID?.trim();
	const usingFallbackSecret = !env.ANTIGRAVITY_CLIENT_SECRET?.trim();
	if (!usingFallbackId && !usingFallbackSecret) return false;
	if (warnedAboutFallback) return true;
	warnedAboutFallback = true;
	const missing: string[] = [];
	if (usingFallbackId) missing.push("ANTIGRAVITY_CLIENT_ID");
	if (usingFallbackSecret) missing.push("ANTIGRAVITY_CLIENT_SECRET");
	console.warn(
		"Using the bundled legacy OAuth client credentials " +
		`(missing env: ${missing.join(" and ")}). Set ${missing.join(" and ")} to your own registered OAuth client when convenient.`,
	);
	return true;
}

export function isHostedOAuthConfigured(): boolean {
	try {
		const { redirectUri } = getOAuthClientConfig();
		const url = new URL(redirectUri);
		return url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
	} catch {
		return false;
	}
}

export function generatePkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function generateState(): string {
	return randomBytes(24).toString("base64url");
}

export function buildAuthUrl(state: string, challenge: string): string {
	const oauth = getOAuthClientConfig();
	const authParams = new URLSearchParams({
		client_id: oauth.clientId,
		response_type: "code",
		redirect_uri: oauth.redirectUri,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		access_type: "offline",
		prompt: "consent",
	});

	return `${AUTH_URL}?${authParams.toString()}`;
}

export async function exchangeAuthorizationCode(code: string, verifier: string): Promise<TokenExchangeResult> {
	const oauth = getOAuthClientConfig();
	const tokenResponse = await fetchWithRetry(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": REQUEST_USER_AGENT,
		},
		body: new URLSearchParams({
			client_id: oauth.clientId,
			client_secret: oauth.clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: oauth.redirectUri,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
	};

	if (!tokenData.refresh_token) {
		throw new Error("No refresh token received. Try again.");
	}

	return {
		accessToken: tokenData.access_token,
		refreshToken: tokenData.refresh_token,
		expiresIn: tokenData.expires_in,
	};
}

export interface ProjectDiscoveryResult {
	projectId: string;
	source: "google";
	endpoint: string;
}

// Discovery order mirrors what third-party Antigravity proxies observe:
// production endpoints first, sandbox last.
const LOAD_CODE_ASSIST_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const;

const ONBOARD_USER_ENDPOINT =
	"https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";

const ONBOARD_MAX_POLLS = 5;
const ONBOARD_POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractProjectId(data: Record<string, unknown> | null): string | null {
	if (!data || typeof data !== "object") return null;
	for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (
			value &&
			typeof value === "object" &&
			typeof (value as { id?: unknown }).id === "string" &&
			((value as { id: string }).id as string).trim()
		) {
			return ((value as { id: string }).id as string).trim();
		}
	}
	return null;
}

// Mirrors the reference clients: the default tier is the allowedTiers entry
// marked isDefault, then currentTier.id, then "free-tier".
function extractDefaultTierId(data: Record<string, unknown> | null): string {
	if (!data || typeof data !== "object") return "free-tier";
	const allowedTiers = Array.isArray(data.allowedTiers) ? data.allowedTiers : [];
	for (const rawTier of allowedTiers) {
		const tier = rawTier && typeof rawTier === "object" ? (rawTier as Record<string, unknown>) : null;
		if (tier && tier.isDefault === true && typeof tier.id === "string" && tier.id.trim()) {
			return tier.id.trim();
		}
	}
	const currentTier =
		data.currentTier && typeof data.currentTier === "object"
			? (data.currentTier as Record<string, unknown>)
			: null;
	if (currentTier && typeof currentTier.id === "string" && currentTier.id.trim()) {
		return currentTier.id.trim();
	}
	return "free-tier";
}

/**
 * Provision a Cloud Code companion project for an account that has none yet.
 * New accounts normally only get one bound after first use in the Antigravity
 * IDE; calling the same `onboardUser` endpoint the IDE uses lets login
 * complete without requiring a manual IDE activation step.
 */
async function onboardUser(accessToken: string, tierId: string): Promise<string | null> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": REQUEST_USER_AGENT,
	};

	const body = JSON.stringify({
		tierId,
		metadata: ANTIGRAVITY_CLIENT_METADATA,
	});

	for (let attempt = 0; attempt < ONBOARD_MAX_POLLS; attempt++) {
		if (attempt > 0) await sleep(ONBOARD_POLL_INTERVAL_MS);
		try {
			const response = await fetchWithRetry(ONBOARD_USER_ENDPOINT, {
				method: "POST",
				headers,
				body,
			});
			if (!response.ok) return null;
			const data = (await response.json()) as Record<string, unknown> | null;
			if (data && data.done === true) {
				const inner =
					data.response && typeof data.response === "object"
						? (data.response as Record<string, unknown>)
						: data;
				return extractProjectId(inner);
			}
			// done:false — provisioning still running; poll again.
		} catch {
			return null;
		}
	}
	return null;
}

export async function discoverProject(accessToken: string): Promise<ProjectDiscoveryResult> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": REQUEST_USER_AGENT,
	};

	let lastLoadData: Record<string, unknown> | null = null;

	for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
		try {
			const response = await fetchWithRetry(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: ANTIGRAVITY_CLIENT_METADATA,
				}),
			});

			if (response.ok) {
				const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
				lastLoadData = data;
				const projectId = extractProjectId(data);
				if (projectId) {
					return { projectId, source: "google", endpoint };
				}
			}
		} catch {
			// Try next endpoint
		}
	}

	// No project bound yet — provision one the same way the IDE does.
	if (lastLoadData) {
		const onboarded = await onboardUser(accessToken, extractDefaultTierId(lastLoadData));
		if (onboarded) {
			return { projectId: onboarded, source: "google", endpoint: ONBOARD_USER_ENDPOINT };
		}
	}

	throw new Error("Could not discover Cloud Code companion project ID from Google. If this account is new, open it in Antigravity IDE and send one message first, then retry login. Login failed instead of falling back to a shared projectId.");
}

export async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetchWithRetry("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": REQUEST_USER_AGENT,
			},
		});
		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Ignore
	}
	return undefined;
}
