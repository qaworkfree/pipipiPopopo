#!/usr/bin/env node
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Read GGUF metadata without allocating tensors or loading model weights. */
export function readGgufContext(path) {
	const fd = openSync(path, "r");
	const size = statSync(path).size;
	let position = 0;
	const bytes = (length) => {
		if (!Number.isSafeInteger(length) || length < 0 || position + length > size)
			throw new Error("Truncated GGUF metadata");
		const buffer = Buffer.alloc(length);
		if (readSync(fd, buffer, 0, length, position) !== length) throw new Error("Truncated GGUF metadata");
		position += length;
		return buffer;
	};
	const u32 = () => bytes(4).readUInt32LE();
	const u64 = () => {
		const value = bytes(8).readBigUInt64LE();
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF length exceeds safe range");
		return Number(value);
	};
	const skip = (length) => {
		if (!Number.isSafeInteger(length) || length < 0 || position + length > size)
			throw new Error("Truncated GGUF metadata");
		position += length;
	};
	const string = () => {
		const length = u64();
		if (length > 65536) throw new Error("Oversized GGUF metadata string");
		return bytes(length).toString("utf8");
	};
	const sizes = [1, 1, 2, 2, 4, 4, 4, 1, null, null, 8, 8, 8];
	const value = (type, capture = false) => {
		if (type === 8) {
			if (capture) return string();
			skip(u64());
			return;
		}
		if (type === 9) {
			const elementType = u32(),
				count = u64();
			if (elementType === 9 || elementType > 12) throw new Error("Invalid GGUF array type");
			if (elementType === 8) {
				if (count > 2_000_000) throw new Error("Oversized GGUF array");
				for (let index = 0; index < count; index++) skip(u64());
			} else skip(sizes[elementType] * count);
			return;
		}
		if (type > 12 || sizes[type] == null) throw new Error("Invalid GGUF metadata type");
		if (!capture) {
			skip(sizes[type]);
			return;
		}
		const buffer = bytes(sizes[type]);
		if (type === 0) return buffer.readUInt8();
		if (type === 1) return buffer.readInt8();
		if (type === 2) return buffer.readUInt16LE();
		if (type === 3) return buffer.readInt16LE();
		if (type === 4) return buffer.readUInt32LE();
		if (type === 5) return buffer.readInt32LE();
		if (type === 10) {
			const number = buffer.readBigUInt64LE();
			return number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : undefined;
		}
	};
	try {
		if (bytes(4).toString("ascii") !== "GGUF") throw new Error("Not a GGUF file");
		if (![2, 3].includes(u32())) throw new Error("Only GGUF v2/v3 are supported");
		u64(); // Tensor count; tensor descriptors/weights are never read.
		const count = u64();
		if (count > 1_000_000) throw new Error("Oversized GGUF metadata table");
		let architecture;
		const contexts = new Map();
		for (let index = 0; index < count; index++) {
			const key = string(),
				type = u32();
			const capture = key === "general.architecture" || key.endsWith(".context_length");
			const result = value(type, capture);
			if (key === "general.architecture") architecture = result;
			else if (key.endsWith(".context_length")) contexts.set(key, result);
			const limit = contexts.get(`${architecture}.context_length`);
			if (typeof architecture === "string" && Number.isSafeInteger(limit) && limit > 0)
				return { architecture, contextLimit: limit };
		}
		throw new Error("GGUF has no verified architecture context_length; cannot choose a safe limit");
	} finally {
		closeSync(fd);
	}
}

function writeAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path) && readFileSync(path, "utf8") === value) return;
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, value, { encoding: "utf8", mode: 0o600 });
	renameSync(temp, path);
}

export function writeProfiles(path, profiles) {
	const lines = [
		"# Generated from verified GGUF metadata. Edit context/output in pi-web-ui.",
		"[*]",
		"ctx-size = 4096",
		"",
	];
	for (const model of profiles.models) {
		if (/[\r\n\[\]#;]/.test(model.id) || /[\r\n]/.test(model.path) || /[\r\n]/.test(model.mmproj ?? ""))
			throw new Error("Model path cannot be represented in an INI preset");
		if (
			!Number.isSafeInteger(model.contextWindow) ||
			model.contextWindow < 2 ||
			model.contextWindow > model.contextLimit
		)
			throw new Error(`Context for ${model.name} exceeds its GGUF limit (${model.contextLimit})`);
		if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens >= model.contextWindow)
			throw new Error(`Max output for ${model.name} must be smaller than its context`);
		lines.push(`[${model.id}]`, `model = ${model.path}`, `ctx-size = ${model.contextWindow}`);
		if (model.embedding) lines.push("embedding = true");
		if (model.mmproj) lines.push(`mmproj = ${model.mmproj}`);
		lines.push("");
	}
	writeAtomic(profiles.presetPath, lines.join("\n"));
	writeAtomic(path, `${JSON.stringify(profiles, null, 2)}\n`);
}

export function prepareProfiles({ modelsDir, profilePath }) {
	modelsDir = resolve(modelsDir);
	profilePath = resolve(profilePath);
	const previous = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, "utf8")) : { models: [] };
	const saved = new Map(previous.models.map((model) => [model.id, model]));
	const models = [];
	const scan = (directory) => {
		const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		const projectors = entries.filter((entry) => entry.isFile() && /mmproj.*\.gguf$/i.test(entry.name));
		const mainFiles = entries.filter(
			(entry) =>
				(entry.isFile() || entry.isSymbolicLink()) &&
				/\.gguf$/i.test(entry.name) &&
				!/mmproj|^(mtp-|dspark-|dflash-)/i.test(entry.name) &&
				(!/-\d{5}-of-\d{5}\.gguf$/i.test(entry.name) || /-00001-of-\d{5}\.gguf$/i.test(entry.name)),
		);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				scan(path);
				continue;
			}
			if (
				(!entry.isFile() && !entry.isSymbolicLink()) ||
				!/\.gguf$/i.test(entry.name) ||
				/mmproj|^(mtp-|dspark-|dflash-)/i.test(entry.name)
			)
				continue;
			if (/-\d{5}-of-\d{5}\.gguf$/i.test(entry.name) && !/-00001-of-\d{5}\.gguf$/i.test(entry.name)) continue;
			const id = relative(modelsDir, path)
				.replaceAll("\\", "/")
				.replace(/\.gguf$/i, "")
				.replace(/-00001-of-\d{5}$/i, "");
			const metadata = readGgufContext(path),
				old = saved.get(id);
			const contextWindow = Math.min(
				Number.isSafeInteger(old?.contextWindow) && old.contextWindow > 0 ? old.contextWindow : 4096,
				metadata.contextLimit,
			);
			const maxTokens = Math.min(
				Number.isSafeInteger(old?.maxTokens) && old.maxTokens > 0
					? old.maxTokens
					: Math.min(1024, Math.floor(contextWindow / 2)),
				contextWindow - 1,
			);
			models.push({
				id,
				name: basename(path),
				path,
				...metadata,
				...(["bert", "nomic-bert", "jina-bert-v2"].includes(metadata.architecture) ? { embedding: true } : {}),
				contextWindow,
				maxTokens,
				...(projectors.length === 1 && mainFiles.length === 1 ? { mmproj: join(directory, projectors[0].name) } : {}),
			});
		}
	};
	scan(modelsDir);
	if (!models.length) throw new Error("No usable GGUF models found in the models directory");
	const profiles = { version: 1, modelsDir, presetPath: join(dirname(profilePath), "models.ini"), models };
	writeProfiles(profilePath, profiles);
	return profiles;
}

export function updateProfiles(profilePath, updates) {
	const profiles = JSON.parse(readFileSync(profilePath, "utf8"));
	for (const update of updates) {
		const model = profiles.models.find((entry) => entry.id === update.id);
		if (!model) throw new Error("Unknown local model ID");
		if (update.contextWindow !== undefined) model.contextWindow = update.contextWindow;
		if (update.maxTokens !== undefined) model.maxTokens = update.maxTokens;
	}
	writeProfiles(profilePath, profiles);
	return profiles;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	try {
		const [command, path, value] = process.argv.slice(2);
		const profiles =
			command === "prepare"
				? prepareProfiles({ modelsDir: value, profilePath: path })
				: command === "set"
					? updateProfiles(path, JSON.parse(value))
					: (() => {
							throw new Error("Use prepare <profile-file> <models-dir> or set <profile-file> <updates-json>");
						})();
		console.log(JSON.stringify(profiles));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
