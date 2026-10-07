import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { prepareProfiles, readGgufContext, updateProfiles } from "./local-model-profiles.mjs";

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function u32(value) {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(value);
	return b;
}
function u64(value) {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(BigInt(value));
	return b;
}
function str(value) {
	const b = Buffer.from(value);
	return Buffer.concat([u64(b.length), b]);
}
function fixture(limit = 32768, architecture = "qwen3") {
	const dir = mkdtempSync(join(tmpdir(), "gguf-profiles-"));
	dirs.push(dir);
	const modelsDir = join(dir, "models with spaces");
	mkdirSync(modelsDir);
	const profilePath = join(dir, "private", "profiles.json");
	const path = join(modelsDir, "Qwen-Q4_K_M.gguf");
	// Array metadata precedes context; architecture follows it. No tensor data exists.
	const metadata = Buffer.concat([
		Buffer.from("GGUF"),
		u32(3),
		u64(0),
		u64(3),
		str("tokenizer.ggml.tokens"),
		u32(9),
		u32(8),
		u64(2),
		str("test"),
		str("token"),
		str(`${architecture}.context_length`),
		u32(4),
		u32(limit),
		str("general.architecture"),
		u32(8),
		str(architecture),
	]);
	writeFileSync(path, metadata);
	return { dir, modelsDir, profilePath, path, metadata };
}

test("reads context from metadata regardless of filename/order, without tensor data", () => {
	const { path } = fixture(1_048_576);
	assert.deepEqual(readGgufContext(path), { architecture: "qwen3", contextLimit: 1_048_576 });
});
for (const limit of [2048, 32768, 1_048_576]) {
	test(`defaults conservatively within a ${limit}-token GGUF limit`, () => {
		const f = fixture(limit),
			profiles = prepareProfiles(f);
		assert.equal(profiles.models[0].contextWindow, Math.min(4096, limit));
		assert.equal(profiles.models[0].contextLimit, limit);
		assert.equal(profiles.models[0].name, "Qwen-Q4_K_M.gguf");
		assert.match(readFileSync(profiles.presetPath, "utf8"), new RegExp(`ctx-size = ${Math.min(4096, limit)}`));
	});
}
test("persists independent chosen contexts/output through rescans, including outputs larger than half", () => {
	const f = fixture();
	const profiles = prepareProfiles(f);
	updateProfiles(f.profilePath, [{ id: profiles.models[0].id, contextWindow: 8192, maxTokens: 6000 }]);
	const saved = readFileSync(f.profilePath, "utf8"),
		stamp = statSync(f.profilePath).mtimeMs;
	assert.equal(prepareProfiles(f).models[0].maxTokens, 6000);
	assert.equal(readFileSync(f.profilePath, "utf8"), saved);
	assert.equal(statSync(f.profilePath).mtimeMs, stamp);
});
test("rejects excessive/fractional context and output without changing persisted settings", () => {
	const f = fixture(2048),
		profiles = prepareProfiles(f),
		id = profiles.models[0].id;
	const before = readFileSync(f.profilePath, "utf8"),
		ini = readFileSync(profiles.presetPath, "utf8");
	for (const update of [
		{ contextWindow: 1_000_000 },
		{ contextWindow: 2.5 },
		{ contextWindow: 0 },
		{ maxTokens: 2048 },
		{ maxTokens: -1 },
		{ maxTokens: 0 },
		{ maxTokens: 1.1 },
	]) {
		assert.throws(() => updateProfiles(f.profilePath, [{ id, ...update }]));
		assert.equal(readFileSync(f.profilePath, "utf8"), before);
		assert.equal(readFileSync(profiles.presetPath, "utf8"), ini);
	}
	assert.throws(() => updateProfiles(f.profilePath, [{ id: "missing", contextWindow: 4096 }]));
});
test("rescans new files; selects first shard and projector without offering sidecars", () => {
	const f = fixture();
	prepareProfiles(f);
	const sub = join(f.modelsDir, "split");
	mkdirSync(sub);
	for (const name of ["Coder-00001-of-00002.gguf", "Coder-00002-of-00002.gguf", "mmproj.gguf", "mtp-draft.gguf"]) {
		writeFileSync(join(sub, name), f.metadata);
	}
	const profiles = prepareProfiles(f);
	assert.equal(profiles.models.length, 2);
	const split = profiles.models.find((model) => model.id === "split/Coder");
	assert.equal(split.mmproj, join(sub, "mmproj.gguf"));
	assert.equal(split.name, "Coder-00001-of-00002.gguf");
});
test("rejects truncated, unsupported and missing context metadata", () => {
	const f = fixture();
	for (const bytes of [
		Buffer.from("bad"),
		f.metadata.subarray(0, 60),
		Buffer.concat([Buffer.from("GGUF"), u32(1), u64(0), u64(0)]),
		Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(0)]),
	]) {
		writeFileSync(f.path, bytes);
		assert.throws(() => readGgufContext(f.path));
	}
});
test("does not guess a projector pairing when a folder has multiple main models", () => {
	const f = fixture();
	for (const name of ["Other.gguf", "mmproj.gguf"]) writeFileSync(join(f.modelsDir, name), f.metadata);
	assert(prepareProfiles(f).models.every((model) => model.mmproj === undefined));
});
test("rejects section injection before writing files", () => {
	const f = fixture();
	writeFileSync(join(f.modelsDir, "bad[id].gguf"), f.metadata);
	assert.throws(() => prepareProfiles(f), /INI/);
});

test("enables embeddings for encoder GGUFs without treating them as chat models", () => {
	const f = fixture(2048, "nomic-bert");
	const profiles = prepareProfiles(f);
	assert.equal(profiles.models[0].embedding, true);
	assert.equal(profiles.models[0].contextWindow, 2048);
	assert.match(readFileSync(profiles.presetPath, "utf8"), /embedding = true/);
});
