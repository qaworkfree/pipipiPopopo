#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/** Check readiness, catalog selection and actual streaming inference without storing credentials. */
export async function checkLocalModel({
	baseUrl = process.env.LLAMA_BASE_URL || "http://127.0.0.1:8080",
	apiKey = process.env.LLAMA_API_KEY,
	model = process.env.LLAMA_MODEL,
	timeoutMs = 60_000,
} = {}) {
	const base = new URL(baseUrl);
	if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
		throw new Error("Use an HTTP(S) server URL without embedded credentials, query or fragment");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
		throw new Error("timeoutMs must be between 1 and 600000");
	const prefix = base.pathname.replace(/\/(?:v1\/?)?$/, "");
	const url = (path) => `${base.origin}${prefix}${path}`;
	const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	const signal = AbortSignal.timeout(timeoutMs);
	async function request(path, label, options = {}) {
		const response = await fetch(url(path), {
			...options,
			headers: { ...headers, ...options.headers },
			signal,
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`${label} returned HTTP ${response.status}`);
		}
		return response;
	}
	const health = await request("/health", "Readiness check");
	await health.body?.cancel();
	const catalog = await (await request("/v1/models", "Model catalog")).json();
	const ids = Array.isArray(catalog.data)
		? catalog.data.map((row) => row?.id).filter((id) => typeof id === "string" && id)
		: [];
	if (!ids.length) throw new Error("No models are available; load a GGUF model first");
	const selected = model || ids[0];
	if (!ids.includes(selected)) throw new Error("The requested LLAMA_MODEL is absent from the model catalog");
	const response = await request("/v1/chat/completions", "Streaming inference", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: selected,
			messages: [{ role: "user", content: "Reply with a short greeting." }],
			max_tokens: 32,
			temperature: 0,
			stream: true,
		}),
	});
	if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
		throw new Error("Streaming inference did not return an SSE body");
	const decoder = new TextDecoder();
	let pending = "",
		event = [],
		bytes = 0,
		characters = 0,
		finished = false;
	const dispatch = () => {
		if (!event.length) return;
		const data = event.join("\n");
		event = [];
		if (data === "[DONE]") {
			finished = true;
			return;
		}
		let value;
		try {
			value = JSON.parse(data);
		} catch {
			throw new Error("Streaming inference returned invalid JSON");
		}
		if (value.error) throw new Error("Streaming inference returned a provider error");
		for (const choice of value.choices ?? [])
			if (typeof choice.delta?.content === "string") characters += choice.delta.content.trim().length;
	};
	try {
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			if (bytes > 1024 * 1024) throw new Error("Streaming inference exceeded the health-check response limit");
			pending += decoder.decode(chunk, { stream: true });
			let index;
			while ((index = pending.indexOf("\n")) >= 0) {
				const line = pending.slice(0, index).replace(/\r$/, "");
				pending = pending.slice(index + 1);
				if (!line) dispatch();
				else if (line.startsWith("data:")) event.push(line.slice(5).replace(/^ /, ""));
				if (finished) break;
			}
			if (finished) break;
		}
	} catch (error) {
		if (signal.aborted) throw new Error("Local-model check timed out");
		throw error;
	}
	if (!finished || characters === 0) throw new Error("Streaming inference ended without a completed, nonempty answer");
	return { model: selected, availableModels: ids.length, streamedCharacters: characters };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const result = await checkLocalModel();
		console.log(
			`PASS: local model ${result.model}; readiness, catalog and streaming inference (${result.streamedCharacters} characters)`,
		);
	} catch (error) {
		// Never print upstream response bodies, URLs or credentials.
		console.error(`Local-model check failed: ${error instanceof Error ? error.message : "unknown error"}`);
		process.exitCode = 1;
	}
}
