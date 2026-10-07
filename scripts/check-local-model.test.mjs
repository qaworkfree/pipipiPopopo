import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkLocalModel } from "./check-local-model.mjs";

async function fixture(run, options = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		res.setHeader("Connection", "close");
		requests.push({ path: req.url, authorization: req.headers.authorization });
		if (req.url === "/health") {
			res.writeHead(options.unready ? 503 : 200);
			res.end("ready");
			return;
		}
		if (req.url === "/v1/models") {
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ data: options.empty ? [] : [{ id: "test-gguf" }] }));
			return;
		}
		if (req.url !== "/v1/chat/completions") {
			res.writeHead(404);
			res.end();
			return;
		}
		const parts = [];
		for await (const part of req) parts.push(part);
		const body = JSON.parse(Buffer.concat(parts).toString());
		assert.equal(body.model, "test-gguf");
		assert.equal(body.stream, true);
		assert.equal(body.max_tokens, 32);
		if (options.hang) return;
		if (options.redirect) {
			res.writeHead(302, { Location: "/elsewhere" });
			res.end();
			return;
		}
		res.setHeader("Content-Type", options.notSse ? "application/json" : "text/event-stream");
		if (options.invalid) {
			res.end("data: invalid-json\n\n");
			return;
		}
		// Split JSON and UTF-8 across transport chunks; include comments and CRLF.
		res.write(': keepalive\r\ndata: {"choices":[{"delta":{"content":"Ol');
		res.write(Buffer.from([0xc3]));
		res.write(Buffer.from([0xa1]));
		res.write('"}}]}\r\n\r\n');
		res.end(options.incomplete ? "" : "data: [DONE]\n\n");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(8996, "127.0.0.1", resolve);
	});
	try {
		await run({ baseUrl: "http://127.0.0.1:8996", requests });
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
}

test("checks readiness, selects a catalog model and consumes complete UTF-8 streaming inference", async () => {
	await fixture(async ({ baseUrl, requests }) => {
		const result = await checkLocalModel({ baseUrl: `${baseUrl}/v1/`, apiKey: "test-secret", inference: true });
		assert.deepEqual(result, { model: "test-gguf", availableModels: 1, streamedCharacters: 3 });
		assert.deepEqual(
			requests.map((row) => row.path),
			["/health", "/v1/models", "/v1/chat/completions"],
		);
		assert(requests.every((row) => row.authorization === "Bearer test-secret"));
		assert(!JSON.stringify(result).includes("test-secret"));
	});
});
for (const [name, options, expected] of [
	["unready server", { unready: true }, /HTTP 503/],
	["empty catalog", { empty: true }, /No models/],
	["invalid SSE", { invalid: true }, /invalid JSON/],
	["wrong response type", { notSse: true }, /SSE body/],
	["incomplete stream", { incomplete: true }, /completed, nonempty/],
	["request timeout", { hang: true }, /timed out|timeout|aborted/i],
	["redirect", { redirect: true }, /fetch failed/],
])
	test(`rejects ${name}`, async () => {
		await fixture(async ({ baseUrl }) => {
			await assert.rejects(checkLocalModel({ baseUrl, inference: true, timeoutMs: options.hang ? 100 : 3000 }), expected);
		}, options);
	});
test("fails for an unknown requested model before sending inference", async () => {
	await fixture(async ({ baseUrl, requests }) => {
		await assert.rejects(checkLocalModel({ baseUrl, model: "missing" }), /absent/);
		assert.equal(requests.length, 2);
	});
});
test("default readiness check sends no prompt or tool request", async () => {
	await fixture(async ({ baseUrl, requests }) => {
		assert.deepEqual(await checkLocalModel({ baseUrl }), {
			model: "test-gguf", availableModels: 1, streamedCharacters: 0,
		});
		assert.deepEqual(requests.map((request) => request.path), ["/health", "/v1/models"]);
	});
});
test("rejects embedded credentials and invalid deadlines", async () => {
	await assert.rejects(checkLocalModel({ baseUrl: "http://user:secret@localhost" }), /embedded credentials/);
	await assert.rejects(checkLocalModel({ baseUrl: "file:///tmp/model" }), /HTTP/);
	await assert.rejects(checkLocalModel({ timeoutMs: 0 }), /timeoutMs/);
});
