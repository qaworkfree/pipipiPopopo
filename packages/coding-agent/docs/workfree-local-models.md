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

For Windows PowerShell, follow the
[local Windows validation guide](workfree-local-models-windows.md), which keeps
test model/configuration files outside the existing repositories.

This procedure uses upstream source and a separately supplied GGUF. Real CPU
inference, CLI responses and authenticated UI streaming pass with the small
model recorded below. That model did not call `read`; the later Qwen3-Coder test
did execute it successfully through the built CLI and authenticated UI. See the
recorded outcomes below. Deployment on the intended host remains incomplete.

1. Install a C++ toolchain and CMake according to the upstream
   [build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).
   Clone [llama.cpp](https://github.com/ggml-org/llama.cpp) separately and check out
   a chosen release/commit. Record `git rev-parse HEAD` in deployment records.
2. Build a CPU baseline before selecting GPU-specific options:

   ```sh
   cmake -S . -B build -DGGML_CUDA=OFF -DLLAMA_OPENSSL=OFF
   cmake --build build --config Release --target llama-server -j 4
   build/bin/llama-server --version
   ```

   This HTTP-only loopback baseline manages model downloads separately, with
   normal TLS/checksum verification. For upstream v0.5.0, `LLAMA_OPENSSL=OFF`
   disables server-side HTTPS support; the old `LLAMA_CURL` switch is deprecated.
   Keep OpenSSL enabled when the server needs HTTPS features. GPU builds and
   Windows executable locations follow the upstream guide.

3. Obtain an instruction-tuned GGUF appropriate for the host's memory and coding
   workload. Review its license and chat/tool template. Record its immutable
   source revision, quantization and SHA-256; verify the expected checksum before
   loading it. Set `WORKFREE_GGUF` to its **local absolute path** in the deployment
   environment. Keep model files and machine-specific paths out of Git.
4. Start an explicit single-model baseline, using the alias in the example:

   ```sh
   build/bin/llama-server --model "$WORKFREE_GGUF" --alias workfree-local \
     --jinja --host 127.0.0.1 --port 8080 --ctx-size 8192 --parallel 1 --n-gpu-layers 0
   ```

   The model must support this context size. If it does not, lower both the
   server context and the example's `contextWindow`/`maxTokens` appropriately.
   One slot keeps the configured context available to this baseline request.
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
- Real CPU GGUF inference, CLI responses and authenticated UI/browser streaming
  pass with the small model recorded below. Its read-tool test did not pass;
  the later Qwen3-Coder CLI/UI tests completed real read calls and returned a
  random probe marker. Offline HTTP fixtures do not establish model compatibility.
- The intended host, production model/quantization, GPU configuration and real
  Tailscale second-device validation are deployment inputs, not inferred here.

## Cloud follow-up before publication: 2026-10-06

The Linux CPU `llama-server` target compiled successfully from upstream v0.5.0,
commit `7fe450e19305b828c199d602c23a8337aaa1f03b`, with CMake 4.1.3 and GCC 14.2.
The executable's `--version` check passed. GPU and Windows builds remain unrun;
successful compilation does not prove model inference.

The public model card and immutable download metadata for
`bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF` are accessible. The Q4_K_M file at
revision `69a2c192eed24297fb09a34d8ba948b8624cc3e2` has expected size 397,808,288
bytes and expected SHA-256
`0128e77564e43d40682f82d7ebe8a9abdf0c24c8f55fa85629f8cc156b1b6560`.
The model card declares Apache-2.0. This is a small CPU smoke-test candidate,
not a selected production model; its tool-call behavior has not been validated.

The immutable Hugging Face URL redirects to `us.aws.cdn.hf.co`. The cloud proxy
rejects that connection with HTTP 403, so no GGUF download or inference passed.
The missing CDN domain was added to the saved environment draft. Saving a draft
does not publish the environment or prove live access; publication is performed
through the environment settings UI. Verify the expected checksum after a
successful download, before loading the model. Local-machine validation is also
possible using the same guide and private test configuration.

## Real small-model validation after publication: 2026-10-06

After the user published the environment, the actual GGUF download succeeded.
The user requested the smallest practical test model; this run used a smaller
135M instruction model instead of downloading the earlier 0.5B candidate.

| Property                       | Verified value                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Model                          | SmolLM2-135M-Instruct, Q3_K_S                                                                       |
| Source                         | [bartowski/SmolLM2-135M-Instruct-GGUF](https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF) |
| Immutable revision             | `09816acd5d99df7be770d85ea30822623dab342c`                                                          |
| File                           | `SmolLM2-135M-Instruct-Q3_K_S.gguf`                                                                 |
| Size                           | 88,202,080 bytes (about 88 MB)                                                                      |
| SHA-256                        | `7add77b8d3736d6b2fd21dc96e69be026f19bde843e9988b43cef1315fc5eebe`                                  |
| License declared by model card | Apache-2.0                                                                                          |
| Server                         | llama.cpp v0.5.0, commit `7fe450e19305b828c199d602c23a8337aaa1f03b`                                 |
| Runtime                        | Built `pipipiPopopo` fork, SDK 1.0.2                                                                |

Normal HTTPS verification and the expected immutable-source checksum were
verified before loading. The server used CPU only, alias `workfree-local`,
loopback port 8099, `--jinja --ctx-size 8192 --parallel 1 --n-gpu-layers 0
--threads 4 --predict 256`. An isolated copy of the provider example used that
port and `maxTokens: 256`; existing agent/UI configuration was preserved.

Observed results:

- The existing `check-local-model.mjs` passed `/health`, model discovery and real
  bounded SSE inference through `[DONE]`.
- The built CLI returned real model text and exited successfully with tools,
  extensions, skills and prompt templates disabled for the greeting request.
- With only `read` enabled, the CLI responded in text without executing that
  tool. JSON events contained zero completed `read` calls and no probe marker in
  a tool result. **The read-tool test did not pass**, despite CLI exit status 0.
- The UI loaded the actual fork, rejected unauthenticated session access, logged
  in through the auth API and received real WebSocket response deltas. Chromium
  displayed the model response at a mobile viewport. Logout closed the socket
  with code 4001 and the expired cookie received HTTP 401. The test explicitly
  disabled other catalog/core tools in its disposable UI configuration.

That small-model run validates the inference connection, not coding quality or
tool compatibility. The later Qwen3-Coder run below supplies a successful real
read call. Follow the UI plan's pending audit of additional native SDK tools
before enabling those tools in a policy-controlled deployment. GPU behavior, Windows execution,
production hardware/model selection and second-device Tailscale access remain
unverified.

After publication, prepared repository dependencies survived but the earlier
`/tmp` llama.cpp/CMake files did not. The replacement build and test model were
prepared outside the repositories in the cloud's shared directory; reusable
installation/startup instructions were updated in a configuration draft. Saving
that update does not publish a new snapshot, and no fresh-task restoration of
these new shared files has been verified. Processes must be started again.
Model files, local configuration and test logs are not committed to Git.

## Qwen research and tool-call validation: 2026-10-06

The user subsequently requested research into Qwen3.8-27B Q8 and authorized
testing Qwen3-Coder-30B-A3B. These are distinct models; the Q8 suffix describes
quantization rather than tool permissions.

| Candidate                                                                                | Model support                                                                                     | GGUF researched                                                                                                          | Observed test scope                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B)                                   | Official chat template exposes function/tool-call and tool-response blocks; dense 27B, multimodal | [Unsloth Q8_0](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF), 29,047,086,048 bytes (about 29 GB)                      | Metadata/template research only; not downloaded or run            |
| [Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) | Official card documents agentic coding/function calls; 30.5B total, 3.3B activated                | [Unsloth Q4_K_M](https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF), 18,556,689,568 bytes (about 18.6 GB) | Verified download, actual CPU CLI and authenticated UI read calls |

The official Qwen3.8 metadata revision is
`1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`; its template includes XML
`<tool_call>`/`<function=...>` blocks. The researched Unsloth GGUF revision is
`4ca720788d1e01f1bff70c033e0d0028fd02e502`, file `Qwen3.8-27B-Q8_0.gguf`,
expected SHA-256
`a680f44a06920e5d689774823782006aa3acc8db95750323373b24139b67e348`.
These are expected source metadata, not a local checksum or inference result.
The file alone approaches this cloud's available disk capacity and needs
additional memory for the context/runtime. No Qwen3.8 deployment is validated.

The Coder's official card revision is
`b2cff646eb4bb1d68355c01b18ae02e7cf42d120`. The downloaded GGUF used Unsloth
revision `b17cb02dd882d5b6ab62fc777ad2995f19668350`, file
`Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf`. Normal TLS, exact size and expected
SHA-256 `fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad`
were verified before loading. Both model cards declare Apache-2.0.

The cloud provides 32 GiB RAM, a four-CPU quota and no GPU. The initial Coder load
with default CPU weight repacking brought cgroup memory close to 32 GiB. The
supported `--no-repack` option reduced observed consumption to about 19 GiB;
it changes CPU optimization, not the model checksum or tool assertions. The
validated CPU baseline used the same pinned llama.cpp build and:

```sh
build/bin/llama-server --model "$WORKFREE_GGUF" --alias workfree-local \
  --jinja --host 127.0.0.1 --port 8099 --ctx-size 8192 --parallel 1 \
  --n-gpu-layers 0 --threads 4 --predict 512 --no-repack
```

The isolated provider example used that port and `maxTokens: 512`. The existing
health script passed readiness, discovery and real bounded SSE through `[DONE]`.
The built CLI greeting passed. With only `read` enabled and extensions/skills/
prompt templates disabled, JSON events recorded one successful
`tool_execution_end` for `read`, the random marker in its actual result, and the
same marker in the final assistant answer. The marker was created in a disposable
`probe.txt` and never included in the prompt; it was not inferred from exit code.

The UI then loaded the actual fork in fresh isolated agent/UI directories using
the same provider configuration. Its Read only project preset granted the
disposable project; all other catalog/core tools were explicitly disabled. The
test required a fresh conversation, matched its new streamed text in mobile
Chromium, then required a successful `read` tool result containing the random
marker and the same marker in the final answer shown by the browser. Actual
HTTP login/unauthenticated-session denial, WebSocket streaming and logout/socket
revocation also passed. This completes the basic CPU model/read-tool integration
check for this artifact, not an audit of every tool or coding workload.

Tool-capable models request operations; the agent executes them and the UI's
adapters enforce project permissions. Model support does not automatically grant
filesystem access or validate unrelated native SDK tools. Production host/GPU,
Windows and second-device Tailscale checks remain separate.
