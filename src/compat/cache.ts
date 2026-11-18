import { createHash } from "node:crypto";
import { ResponsesStore, type StoredResponseEntry } from "../responses-store.js";

export const thoughtSignatureCache = new Map<string, string>();
const THOUGHT_SIGNATURE_CACHE_MAX = 500;
export const responsesStore = new ResponsesStore();

export function makeCompatId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function getStoredResponse(id: string): StoredResponseEntry | null {
	return responsesStore.get(id);
}

export function setStoredResponse(id: string, entry: StoredResponseEntry): void {
	responsesStore.set(id, entry);
}

export function resetResponsesStoreForTests(): void {
	responsesStore.clear();
}

export async function loadResponsesStore(): Promise<void> {
	await responsesStore.load();
}

export async function flushResponsesStore(): Promise<void> {
	await responsesStore.flush();
}

export function cacheThoughtSignature(callId: string, signature: string): void {
	if (thoughtSignatureCache.size >= THOUGHT_SIGNATURE_CACHE_MAX) {
		// Evict the oldest entry
		const firstKey = thoughtSignatureCache.keys().next().value;
		if (firstKey !== undefined) thoughtSignatureCache.delete(firstKey);
	}
	thoughtSignatureCache.set(callId, signature);
}

/**
 * Generated images reach compat clients as markdown data URIs, which have no
 * room for a thought signature. Key the signature by the image bytes so it can
 * be re-attached when the client sends the image back in the history.
 */
export function imageSignatureKey(base64Data: string): string {
	return `image:${createHash("sha256").update(base64Data).digest("hex")}`;
}
