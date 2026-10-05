# Workfree local-model deployment

The [Workfree UI](https://github.com/qaworkfree/pi-web-ui) owns authentication,
project policy and browser approvals. This repository,
[pipipiPopopo](https://github.com/qaworkfree/pipipiPopopo), owns the agent/runtime
and providers. Keep llama.cpp on loopback; expose the authenticated UI through
private HTTPS/Tailscale as described in the UI deployment guide.

## Existing provider support

Use the existing built-in `llama.cpp` provider for a router. It discovers loaded
or sleeping models and supports `/llama` management. Set `LLAMA_BASE_URL` to the
router's root URL, for example `http://127.0.0.1:8080`, and optionally supply
`LLAMA_API_KEY` to the runtime process. `/login llama.cpp` is the interactive
alternative. See [llama.cpp](llama-cpp.md) for loading and model discovery.

For a single-model server, or Ollama/LM Studio/vLLM, reuse `models.json` with
`api: "openai-completions"` and the server's `/v1` URL. The
[example configuration](../examples/models/workfree-local.json) uses the alias
`workfree-local` and a non-secret dummy key for an unauthenticated loopback
server. For authenticated servers, replace its `apiKey` with `$LLAMA_API_KEY`.
Pi already supports environment interpolation; do not commit actual keys.

Merge examples into the existing agent configuration rather than replacing it.
The default agent directory is `~/.pi/agent`; deployments can explicitly select
an independent directory with `PI_CODING_AGENT_DIR`. Confirm the actual directory
in [configuration](configuration.md#agent-directory). Both UI and CLI must use
the same runtime configuration when they should see the same providers.

## llama.cpp/GGUF setup procedure

This procedure uses upstream source and a separately supplied GGUF. It has **not
been validated with real GGUF inference in this cloud environment**: Hugging Face
downloads are blocked by HTTP 403 and no production GGUF was supplied. Do not
mark deployment complete until the checks below pass on the intended host.

1. Install a C++ toolchain and CMake according to the upstream
   [build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).
   Clone [llama.cpp](https://github.com/ggml-org/llama.cpp) separately and check out
   a chosen release/commit. Record `git rev-parse HEAD` in deployment records.
2. Build a CPU baseline before selecting GPU-specific options:

   ```sh
   cmake -S . -B build -DGGML_CUDA=OFF -DLLAMA_CURL=OFF
   cmake --build build --config Release --target llama-server -j 4
   build/bin/llama-server --version
   ```

   `LLAMA_CURL=OFF` assumes model downloads are managed separately. GPU builds and
   Windows executable locations follow the upstream guide; this is not a claim
   that those combinations were tested here.

3. Obtain an instruction-tuned GGUF appropriate for the host's memory and coding
   workload. Review its license and chat/tool template. Record its immutable
   source revision, quantization and SHA-256; verify the expected checksum before
   loading it. Set `WORKFREE_GGUF` to its **local absolute path** in the deployment
   environment. Keep model files and machine-specific paths out of Git.
4. Start an explicit single-model baseline, using the alias in the example:

   ```sh
   build/bin/llama-server --model "$WORKFREE_GGUF" --alias workfree-local \
     --jinja --host 127.0.0.1 --port 8080 --ctx-size 8192 --n-gpu-layers 0
   ```

   The model must support this context size. If it does not, lower both the
   server context and the example's `contextWindow`/`maxTokens` appropriately.
   An API key, if enabled, must match `LLAMA_API_KEY` in the agent process.

5. Run the deployment check from this repository:

   ```sh
   LLAMA_BASE_URL=http://127.0.0.1:8080 LLAMA_MODEL=workfree-local \
     node scripts/check-local-model.mjs
   ```

   The check calls `/health`, verifies the selected model in `/v1/models`, then
   requests at most 32 output tokens and consumes SSE through `[DONE]`. It fails
   on readiness errors, missing models, HTTP errors, invalid/incomplete streaming
   or timeout. It does not load/unload models or store/print credentials.
   API keys come from `LLAMA_API_KEY`; never put a key in a URL or CLI argument.

6. Start Pi with the example provider and perform a harmless prompt, then test a
   read-only tool request in a disposable project:

   ```sh
   node packages/coding-agent/dist/bundle/cli.js \
     --provider workfree-local --model workfree-local --no-session \
     --print 'Reply with a short greeting.'
   ```

   Check actual streaming, tool-call parsing and context limits before enabling
   coding operations. The HTTP health check proves basic inference availability;
   it does not prove coding quality, tool compatibility or GPU performance.

For router operation, start without `--model`/`--alias`, use `--models-dir` and
follow [the existing router guide](llama-cpp.md). Load the intended model first
when using `--no-models-autoload`; run the same check with its actual model ID.
Do not silently load a model in a shared router as part of a readiness check.

## Build the runtime used by the UI

From a clean checkout of this repository:

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
```

Generated catalogs under `packages/ai/src/providers/data` are not in Git. Fresh
checkouts need hydration before an offline build. Hydration contacts models.dev,
OpenRouter and other catalog sources; it does not require model inference keys.
If these sources are unavailable, an exact-version published artifact can supply
the unchanged catalogs. In this session, the official
`@earendil-works/pi-ai@1.0.2` npm package supplied all provider JSON files and their
manifest; the repository's strict validator, full check and offline build passed.
Its npm tarball SHA-1 is `491b32ed7dd8e333a58a55dfc18ff61e31bc43c9`.
For this runtime version, from the repository root on a POSIX host:

```sh
WORKFREE_CATALOG_DIR="$(mktemp -d)"
npm pack @earendil-works/pi-ai@1.0.2 --ignore-scripts \
  --pack-destination "$WORKFREE_CATALOG_DIR"
tar -xzf "$WORKFREE_CATALOG_DIR/earendil-works-pi-ai-1.0.2.tgz" \
  -C "$WORKFREE_CATALOG_DIR"
test ! -e packages/ai/src/providers/data
cp -R "$WORKFREE_CATALOG_DIR/package/dist/providers/data" packages/ai/src/providers/data
npm run check:model-data --workspace=@earendil-works/pi-ai
npm run build:offline
```

Run each command only after the previous command succeeds. The absent-directory
check protects existing catalogs. If the runtime version changes, use its exact
published version and validate again. If validation fails, stop rather than
fabricating catalogs or weakening checks. Catalog restoration only supplies data;
the agent code is built from this repository, not replaced with the npm SDK.

To connect the built fork without changing either repository's dependencies,
run from the UI checkout after building its server/web assets:

```sh
PI_WEB_SDK=global \
PI_WEB_SDK_DIR="$PI_RUNTIME_REPO/packages/coding-agent" npm start
```

`PI_RUNTIME_REPO` is the absolute runtime checkout path set outside Git.
The existing SDK resolver accepts an explicit package directory and selects it
when its version is not older than the bundled SDK. The package's `dist/index.js`
and its runtime dependencies must exist; a path to an unbuilt checkout is not
sufficient. Check the startup SDK path and `/api/health` (`piSdkCopies` and actual
version) to verify which copy loaded. Follow the UI's authentication and project
policy setup before enabling operations. An installed registry SDK is a different
artifact from this fork, even if its version string matches.

## Validation recorded for this implementation

- Ten offline HTTP fixture tests validate the health-check script, including
  split UTF-8/SSE chunks, errors, missing models, redirects and deadlines.
- Runtime dependencies install with `npm ci --ignore-scripts`.
- The built CLI recognizes the supplied local provider example with
  `--list-models workfree-local` in an isolated agent directory.
- After restoring the exact-version published catalogs, the strict model-data
  validator, `npm run check` (including TypeScript and browser smoke) and
  `npm run build:offline` pass. No tracked generated catalog or dependency changed.
- The UI loaded this built fork through its existing SDK resolver. Actual
  HTTP/WebSocket/browser tests verified the selected package path/version,
  project policy, canonical escapes, denied uploads and blocked previews.
- Real GGUF inference and model tool-call compatibility remain unverified; the
  offline HTTP fixtures are not a substitute for an actual model.
- The intended host, production model/quantization, GPU configuration and real
  Tailscale second-device validation are deployment inputs, not inferred here.
