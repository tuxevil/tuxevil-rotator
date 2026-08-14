import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it, afterEach } from "node:test";
import { PassThrough } from "node:stream";
import {
	handleOpenAIResponsesCancel,
	handleOpenAIResponsesCreate,
	handleOpenAIResponsesDelete,
	handleOpenAIResponsesInputItems,
	handleOpenAIResponsesRetrieve,
	resetResponsesStoreForTests,
} from "../src/compat.js";
import { ANTIGRAVITY_ENDPOINTS, type AccountRuntime } from "../src/types.js";
import type { AccountRotator } from "../src/rotator.js";

type Capture = {
	url: string;
	headers: IncomingMessage["headers"];
	body: string;
};

type ResponseStub = ServerResponse & {
	statusCodeCaptured: number;
	headersCaptured: Record<string, string>;
	body: string;
};

const endpointOverrides = ANTIGRAVITY_ENDPOINTS as unknown as string[];
const originalEndpoints = [...endpointOverrides];

afterEach(() => {
	endpointOverrides.splice(0, endpointOverrides.length, ...originalEndpoints);
	resetResponsesStoreForTests();
});

async function listenServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server did not bind to a TCP port");
	return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function createAccount(): AccountRuntime {
	return {
		config: {
			email: "test@example.com",
			projectId: "test-project",
			refreshToken: "refresh-token",
			label: "test-account",
		},
		accessToken: "access-token",
		tokenExpires: Date.now() + 60_000,
		requestsSinceRotation: 0,
		totalRequests: 0,
		cooldownsByModel: {},
		quotaExhaustedAt: 0,
		quota: [],
		lastQuotaPoll: 0,
		lastUsed: 0,
		lastError: null,
		consecutiveErrors: 0,
		disabled: false,
		flagged: false,
		inFlightRequests: 0,
		inFlightByModel: {},
		allowFreshWindowStartsOverride: false,
		dailyRequestCount: 0,
		dailyRequestDay: "2026-05-16",
		healthScore: 1,
		tokenBucket: {
			tokens: 50,
			lastRefillAt: Date.now(),
		},
	};
}

function createRotatorStub(account: AccountRuntime): AccountRotator {
	return {
		getActiveAccount: async () => account,
		getRetryAfterMs: () => 0,
		rotateToNext: async () => null,
		finishRequest: () => {},
		getSafetyJitterMs: () => 0,
		recordUpstreamAttempt: () => {},
		markExhausted: () => {},
		recordProvider429: () => {},
		getFlagContext: () => ({
			timerType: "fresh",
			accountQuotaPercent: 0,
			wasProAccount: false,
			accountRequestsLastHour: 0,
			poolSize: 1,
			poolHealthyCount: 1,
			uptimeSeconds: 0,
		}),
		markFlagged: () => {},
		markError: () => {},
		recordRequest: () => false,
		recordProxyEvent: () => {},
		getGlobalDelayMs: () => 0,
		recordLatency: () => {},
		recordRequestLog: () => {},
		recordTokenUsage: () => {},
	} as unknown as AccountRotator;
}

function requestStream(method: string, url: string, payload?: unknown): IncomingMessage & PassThrough {
	const stream = new PassThrough() as IncomingMessage & PassThrough;
	const body = payload === undefined ? "" : JSON.stringify(payload);
	stream.method = method;
	stream.url = url;
	stream.headers = {
		"content-type": "application/json",
		"content-length": String(Buffer.byteLength(body)),
		"user-agent": "OpenAI/1.0.0",
	};
	process.nextTick(() => stream.end(body));
	return stream;
}

function responseStub(): ResponseStub {
	let headersSent = false;
	let writableEnded = false;
	const res = {
		statusCodeCaptured: 0,
		headersCaptured: {},
		body: "",
		get headersSent() {
			return headersSent;
		},
		get writableEnded() {
			return writableEnded;
		},
		writeHead(status: number, headers: Record<string, string>) {
			this.statusCodeCaptured = status;
			this.headersCaptured = headers;
			headersSent = true;
			return this;
		},
		write(chunk: string) {
			this.body += chunk;
			return true;
		},
		end(chunk?: string) {
			if (chunk) this.body += chunk;
			writableEnded = true;
			return this;
		},
	} as ResponseStub;
	return res;
}

describe("responses compat", () => {
	it("creates, retrieves, lists input items, and deletes stored responses", async () => {
		const captures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"responseId":"abc","candidates":[{"content":{"parts":[{"text":"pong"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const req = requestStream("POST", "/v1/responses", {
				model: "claude-sonnet-4-6",
				input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
				instructions: "be terse",
			});
			const res = responseStub();
			await handleOpenAIResponsesCreate(req, res, rotator);
			assert.equal(res.statusCodeCaptured, 200);
			const payload = JSON.parse(res.body) as { id: string; output_text: string; output: Array<{ type: string }> };
			assert.equal(payload.output_text, "pong");
			assert.equal(payload.output[0].type, "message");
			assert.match(captures[0].body, /"systemInstruction"/);
			assert.match(captures[0].body, /"contents":\[{"role":"user","parts":\[{"text":"ping"}\]}\]/);

			const retrieveRes = responseStub();
			handleOpenAIResponsesRetrieve(req, retrieveRes, payload.id);
			assert.equal(retrieveRes.statusCodeCaptured, 200);
			assert.equal(JSON.parse(retrieveRes.body).id, payload.id);

			const itemsRes = responseStub();
			handleOpenAIResponsesInputItems(req, itemsRes, payload.id);
			assert.equal(itemsRes.statusCodeCaptured, 200);
			assert.equal(JSON.parse(itemsRes.body).data[0].type, "message");

			const deleteRes = responseStub();
			handleOpenAIResponsesDelete(req, deleteRes, payload.id);
			assert.equal(JSON.parse(deleteRes.body).deleted, true);

			const missingRes = responseStub();
			handleOpenAIResponsesRetrieve(req, missingRes, payload.id);
			assert.equal(missingRes.statusCodeCaptured, 404);
		} finally {
			await closeServer(upstream.server);
		}
	});

	it("supports previous_response_id with function_call_output name resolution", async () => {
		const captures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				if (captures.length === 1) {
					res.end('data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"lookup","args":{"q":"pi"}}}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}}\n\n');
					return;
				}
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":1}}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const firstReq = requestStream("POST", "/v1/responses", {
				model: "claude-sonnet-4-6",
				input: "find pi",
				tools: [{ type: "function", function: { name: "lookup" } }],
			});
			const firstRes = responseStub();
			await handleOpenAIResponsesCreate(firstReq, firstRes, rotator);
			const firstPayload = JSON.parse(firstRes.body) as { id: string; output: Array<{ call_id: string }> };
			const callId = firstPayload.output[0].call_id;

			const secondReq = requestStream("POST", "/v1/responses", {
				model: "claude-sonnet-4-6",
				previous_response_id: firstPayload.id,
				input: [{ type: "function_call_output", call_id: callId, output: { answer: "3.14" } }],
			});
			const secondRes = responseStub();
			await handleOpenAIResponsesCreate(secondReq, secondRes, rotator);
			assert.equal(secondRes.statusCodeCaptured, 200);
			assert.match(captures[1].body, /"functionResponse"/);
			assert.match(captures[1].body, /"name":"lookup"/);
		} finally {
			await closeServer(upstream.server);
		}
	});

	it("preserves final assistant text when a Responses continuation has no new input", async () => {
		const captures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				if (captures.length === 1) {
					res.end('data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"exec_command","args":{"cmd":"write HANDOFF.md"}}}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}}\n\n');
					return;
				}
				if (captures.length === 2) {
					res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"HANDOFF.md escrito correctamente."}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":1}}}\n\n');
					return;
				}
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]}}]}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const firstReq = requestStream("POST", "/v1/responses", {
				model: "claude-sonnet-4-6",
				input: "write the handoff",
				tools: [{ type: "function", function: { name: "exec_command" } }],
			});
			const firstRes = responseStub();
			await handleOpenAIResponsesCreate(firstReq, firstRes, rotator);
			const firstPayload = JSON.parse(firstRes.body) as { id: string; output: Array<{ call_id: string }> };
			const callId = firstPayload.output[0].call_id;

			const secondReq = requestStream("POST", "/v1/responses", {
				model: "claude-sonnet-4-6",
				previous_response_id: firstPayload.id,
				input: [{ type: "function_call_output", call_id: callId, output: "HANDOFF.md escrito." }],
			});
			const secondRes = responseStub();
			await handleOpenAIResponsesCreate(secondReq, secondRes, rotator);
			const secondPayload = JSON.parse(secondRes.body) as { id: string };

			const thirdReq = requestStream("POST", "/v1/responses", {
				model: "claude-sonnet-4-6",
				previous_response_id: secondPayload.id,
			});
			const thirdRes = responseStub();
			await handleOpenAIResponsesCreate(thirdReq, thirdRes, rotator);

			const thirdBody = JSON.parse(captures[2].body) as {
				request: { contents: Array<{ role: string; parts: unknown[] }> };
			};
			assert.match(captures[2].body, /HANDOFF\.md escrito correctamente/);
			assert.equal(thirdBody.request.contents.at(-1)?.role, "user");
			assert.doesNotMatch(captures[2].body, /"functionResponse"[^}]*"write HANDOFF\.md"/);
		} finally {
			await closeServer(upstream.server);
		}
	});

	it("does not retain responses when store is false", async () => {
		const upstream = await listenServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"pong"}]}}]}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const req = requestStream("POST", "/v1/responses", {
				model: "gemini-3-flash",
				input: "ping",
				store: false,
			});
			const res = responseStub();
			await handleOpenAIResponsesCreate(req, res, rotator);
			const payload = JSON.parse(res.body) as { id: string };

			const retrieveRes = responseStub();
			handleOpenAIResponsesRetrieve(req, retrieveRes, payload.id);
			assert.equal(retrieveRes.statusCodeCaptured, 404);
		} finally {
			await closeServer(upstream.server);
		}
	});

	it("maps Responses reasoning.effort to tiered thinkingLevel upstream", async () => {
		const captures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"pong"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const req = requestStream("POST", "/v1/responses", {
				model: "gemini-3.7-flash-tiered",
				input: "ping",
				reasoning: { effort: "medium" },
			});
			const res = responseStub();
			await handleOpenAIResponsesCreate(req, res, rotator);
			assert.equal(res.statusCodeCaptured, 200);

			const payload = JSON.parse(res.body) as { reasoning: { effort: string | null } };
			assert.equal(payload.reasoning.effort, "medium");

			const upstreamBody = JSON.parse(captures[0].body) as {
				request: { generationConfig: { thinkingConfig?: Record<string, unknown> } };
			};
			assert.deepEqual(upstreamBody.request.generationConfig.thinkingConfig, {
				includeThoughts: true,
				thinkingLevel: "MEDIUM",
			});
		} finally {
			await closeServer(upstream.server);
		}
	});

	it("keeps tiered Responses requests adaptive when reasoning.effort is absent", async () => {
		const captures: Capture[] = [];
		const upstream = await listenServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk.toString(); });
			req.on("end", () => {
				captures.push({ url: req.url || "", headers: req.headers, body });
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end('data: {"response":{"candidates":[{"content":{"parts":[{"text":"pong"}]}}]}}\n\n');
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const req = requestStream("POST", "/v1/responses", {
				model: "gemini-3.7-flash-tiered",
				input: "ping",
			});
			const res = responseStub();
			await handleOpenAIResponsesCreate(req, res, rotator);
			assert.equal(res.statusCodeCaptured, 200);

			const upstreamBody = JSON.parse(captures[0].body) as {
				request: { generationConfig: { thinkingConfig?: Record<string, unknown> } };
			};
			assert.deepEqual(upstreamBody.request.generationConfig.thinkingConfig, {
				includeThoughts: true,
			});
		} finally {
			await closeServer(upstream.server);
		}
	});

	it("streams Responses SSE events and keeps cancel coherent", async () => {
		const upstream = await listenServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end([
					'data: {"response":{"candidates":[{"content":{"parts":[{"text":"po"}]}}]}}',
					'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ng"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2}}}',
					"",
				].join("\n"));
			});
		});
		endpointOverrides.splice(0, endpointOverrides.length, upstream.url);

		try {
			const rotator = createRotatorStub(createAccount());
			const req = requestStream("POST", "/v1/responses", {
				model: "gemini-3-flash",
				input: "ping",
				stream: true,
			});
			const res = responseStub();
			await handleOpenAIResponsesCreate(req, res, rotator);
			assert.equal(res.statusCodeCaptured, 200);
			assert.match(res.body, /"type":"response.created"/);
			assert.match(res.body, /"type":"response.output_text.delta"/);
			assert.match(res.body, /"type":"response.completed"/);

			const completed = res.body.trim().split("\n\n").filter(Boolean).at(-1) || "";
			const finalEvent = JSON.parse(completed.replace(/^data:\s*/, "")) as { response: { id: string } };

			const cancelRes = responseStub();
			handleOpenAIResponsesCancel(req, cancelRes, finalEvent.response.id);
			assert.equal(cancelRes.statusCodeCaptured, 200);
			assert.equal(JSON.parse(cancelRes.body).status, "completed");
		} finally {
			await closeServer(upstream.server);
		}
	});
});
