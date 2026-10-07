import { describe, expect, it } from "vitest";
import { createLlamaProvider } from "../src/extensions/llama/provider.ts";

describe("llama.cpp router filenames", () => {
	it.each(["-m", "--model"])("uses the GGUF basename with %s while retaining the routing ID", (flag) => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "qwen-route",
					source: "preset",
					status: {
						value: "unloaded",
						args: [flag, "D:\\IA\\modelos-llamacpp\\Qwen3-2B-Q4_K_M.gguf"],
					},
				},
				{
					id: "other-route",
					source: "preset",
					status: {
						value: "unloaded",
						args: [flag, "/models/Other-Q8_0.gguf"],
					},
				},
			],
			"http://127.0.0.1:8080",
			{ routerAutoload: true },
		);
		expect(controller.provider.getModels().map((model) => [model.id, model.name])).toEqual([
			["qwen-route", "Qwen3-2B-Q4_K_M.gguf"],
			["other-route", "Other-Q8_0.gguf"],
		]);
		expect(
			controller.provider
				.getAllModels?.()
				.every((model) => !model.name.includes("/models") && !model.name.includes("D:")),
		).toBe(true);
	});
	it("falls back to the reported ID without guessing from invalid metadata", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{ id: "reported", status: { value: "loaded", args: ["-m", "/models/not-a-gguf.bin"] } },
				{ id: "unsafe", status: { value: "loaded", args: ["-m", "/models/control\nname.gguf"] } },
			],
			"http://127.0.0.1:8080",
		);
		expect(controller.provider.getModels().map((model) => model.name)).toEqual(["reported", "unsafe"]);
	});
	it("forced discovery rescans metadata without inference, model loading or tool execution", async () => {
		const originalFetch = globalThis.fetch;
		const requests: [string, string][] = [];
		globalThis.fetch = async (input, options) => {
			const url = String(input);
			requests.push([url, options?.method ?? "GET"]);
			return new Response(
				JSON.stringify(
					url.endsWith("/props")
						? { models_autoload: true }
						: {
								data: [
									{
										id: "qwen",
										source: "preset",
										status: {
											value: "unloaded",
											args: ["-m", "/models/Qwen.gguf", "-c", "4096"],
										},
									},
								],
							},
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		};
		try {
			const controller = createLlamaProvider();
			await controller.provider.refreshModels?.({
				credential: { type: "api_key", env: { LLAMA_BASE_URL: "http://127.0.0.1:8080" } },
				allowNetwork: true,
				force: true,
				signal: new AbortController().signal,
				publish: async (publication) => {
					publication.update?.();
					return true;
				},
			});
			expect(requests).toEqual([
				["http://127.0.0.1:8080/models?reload=1", "GET"],
				["http://127.0.0.1:8080/props", "GET"],
			]);
			expect(controller.provider.getModels()[0]).toMatchObject({
				id: "qwen",
				name: "Qwen.gguf",
				contextWindow: 4096,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
