import {
	ANTIGRAVITY_CLIENT_METADATA,
	ANTIGRAVITY_ENDPOINTS,
} from "../../types.js";
import type { AccountRuntime } from "../../types.js";
import type { ForwardedResponse } from "../../proxy.js";
import { fetchWithRetry } from "../../fetch-with-retry.js";
import { DEFAULT_PROVIDER, getProviderProjectId } from "../credential-helpers.js";
import { getAccountProxyDispatcher } from "../proxy-dispatcher.js";
import { buildAntigravityWireHeaders } from "./forward.js";

export const CODE_ASSIST_ACTIONS = [
	"loadCodeAssist",
	"fetchAvailableModels",
	"onboardUser",
	"listExperiments",
	"countTokens",
	"retrieveUserQuota",
	"retrieveUserQuotaSummary",
] as const;

export type CodeAssistAction = (typeof CODE_ASSIST_ACTIONS)[number];

export function isCodeAssistAction(value: string): value is CodeAssistAction {
	return (CODE_ASSIST_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObjectBody(action: CodeAssistAction, body: unknown): Record<string, unknown> {
	if (!isRecord(body)) {
		throw new Error(`Code Assist ${action} requires a JSON object body`);
	}
	return body;
}

export function validateCodeAssistPayload(
	action: CodeAssistAction,
	body: unknown,
): void {
	const object = requireObjectBody(action, body);
	if (action === "onboardUser") {
		const tierId =
			typeof object.tierId === "string" && object.tierId.trim()
				? object.tierId.trim()
				: typeof object.tier_id === "string" && object.tier_id.trim()
					? object.tier_id.trim()
					: "";
		if (!tierId) {
			throw new Error("Code Assist onboardUser requires tierId");
		}
	}
	if (action === "countTokens") {
		if (typeof object.model !== "string" || object.model.trim() === "") {
			throw new Error("Code Assist countTokens requires model");
		}
		if (!("request" in object)) {
			throw new Error("Code Assist countTokens requires request");
		}
	}
}

function normalizeClientMetadata(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return { ...ANTIGRAVITY_CLIENT_METADATA };
	const normalized: Record<string, unknown> = { ...raw };
	const renamePairs: Array<[string, string]> = [
		["ide_type", "ideType"],
		["ide_version", "ideVersion"],
		["plugin_version", "pluginVersion"],
		["update_channel", "updateChannel"],
		["duet_project", "duetProject"],
		["plugin_type", "pluginType"],
		["ide_name", "ideName"],
	];
	for (const [snake, camel] of renamePairs) {
		if (snake in normalized) {
			if (!(camel in normalized)) normalized[camel] = normalized[snake];
			delete normalized[snake];
		}
	}
	return {
		...ANTIGRAVITY_CLIENT_METADATA,
		...normalized,
	};
}

function buildUpstreamBody(
	account: AccountRuntime,
	action: CodeAssistAction,
	body: Record<string, unknown>,
): Record<string, unknown> {
	const normalizedBody: Record<string, unknown> = { ...body };
	if (action === "onboardUser") {
		if (!("tierId" in normalizedBody) && typeof normalizedBody.tier_id === "string") {
			normalizedBody.tierId = normalizedBody.tier_id;
		}
		delete normalizedBody.tier_id;
		if (
			!("cloudaicompanionProject" in normalizedBody) &&
			typeof normalizedBody.cloudaicompanion_project === "string"
		) {
			normalizedBody.cloudaicompanionProject =
				normalizedBody.cloudaicompanion_project;
		}
		delete normalizedBody.cloudaicompanion_project;
		normalizedBody.metadata = normalizeClientMetadata(normalizedBody.metadata);
	} else if (action === "loadCodeAssist") {
		normalizedBody.metadata = normalizeClientMetadata(normalizedBody.metadata);
	}
	const projectScoped = new Set([
		"fetchAvailableModels",
		"countTokens",
		"retrieveUserQuota",
		"retrieveUserQuotaSummary",
	]);
	if (!projectScoped.has(action)) return normalizedBody;
	const projectId = getProviderProjectId(account.config, DEFAULT_PROVIDER);
	if (!projectId) {
		throw new Error(`Code Assist ${action} requires the active account projectId`);
	}
	return { ...normalizedBody, project: projectId };
}

export async function forwardCodeAssistRequest(
	account: AccountRuntime,
	action: CodeAssistAction,
	body: unknown,
	originalHeaders: Record<string, string>,
	signal?: AbortSignal,
): Promise<ForwardedResponse> {
	validateCodeAssistPayload(action, body);
	const requestBody = buildUpstreamBody(
		account,
		action,
		body as Record<string, unknown>,
	);
	const headers = buildAntigravityWireHeaders(account, originalHeaders);
	let lastError: unknown;

	for (let index = 0; index < ANTIGRAVITY_ENDPOINTS.length; index++) {
		const endpoint = ANTIGRAVITY_ENDPOINTS[index];
		try {
			const response = await fetchWithRetry(
				`${endpoint}/v1internal:${action}`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(requestBody),
					signal,
					dispatcher: getAccountProxyDispatcher(account, "google-antigravity"),
					retries: 0,
					timeoutMs: 10_000,
				},
			);
			if (
				response.status === 404 &&
				index < ANTIGRAVITY_ENDPOINTS.length - 1
			) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			return { response, endpoint };
		} catch (err) {
			lastError = err;
			if (signal?.aborted) throw err;
			if (index < ANTIGRAVITY_ENDPOINTS.length - 1) continue;
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("All Code Assist endpoints failed");
}
