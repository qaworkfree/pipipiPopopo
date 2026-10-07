# Workfree local validation with PowerShell

Use this procedure to validate the existing runtime and UI on Windows. These
PowerShell steps have **not been executed on the user's PC**. Record command
results; do not mark inference or tool compatibility passed until observed.
The Linux CPU build was checked separately. Keep the Workfree reference app and
OS sandboxing outside this test.

## Prerequisites and existing repositories

For normal use, the UI repository's
[visible router launcher](https://github.com/qaworkfree/pi-web-ui/blob/main/docs/local-model-deployment.md#visible-launcher-and-all-local-models)
starts existing builds with all usable GGUFs in `D:\IA\modelos-llamacpp` listed.
It keeps llama.cpp and UI consoles open and performs readiness GET requests only.
Opening/selecting models sends no prompt and loads no weights; a chat message
triggers autoload. Update/build both repositories before using the new launcher.
The procedures below are **optional manual validation**, not startup tasks.
Never add greeting/read/capability tests to a launcher or run them on UI opening.

Install Node >=22.19, Git, CMake and Visual Studio 2022 Build Tools with the
Desktop development with C++ workload, MSVC x64 tools and Windows SDK. The cloud
CPU build used CMake 4.1.3. Use native `npm.cmd` and `curl.exe` rather than
PowerShell aliases; no execution-policy change is needed to paste these commands.

Set these variables to your **existing** local checkouts in each terminal:

```powershell
$ErrorActionPreference = 'Stop'
$env:PI_RUNTIME_REPO = Read-Host 'Absolute path to pipipiPopopo'
$env:PI_UI_REPO = Read-Host 'Absolute path to pi-web-ui'

function Invoke-Checked {
    param([string]$Command, [string[]]$CommandArgs)
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

Invoke-Checked node @('--version')
Invoke-Checked npm.cmd @('--version')
Invoke-Checked git @('--version')
Invoke-Checked cmake @('--version')
```

In each checkout, run `git status --short` and `git rev-parse HEAD` and record the
output. Preserve all local modifications and local-only commits. Compare your
runtime/UI commits with their respective GitHub `main` before claiming results
apply to the published implementation. Do not automatically reset, clean,
overwrite configuration or pull into a dirty checkout.

## Build the existing agent and UI

From the runtime terminal:

```powershell
Set-Location $env:PI_RUNTIME_REPO
Invoke-Checked npm.cmd @('ci', '--ignore-scripts')
Invoke-Checked npm.cmd @('run', 'hydrate:model-data')
Invoke-Checked npm.cmd @('run', 'check')
Invoke-Checked npm.cmd @('run', 'build:offline')
```

If hydration fails, stop and inspect the error. The exact-version official npm
catalog artifact is an alternative described in the
[runtime guide](workfree-local-models.md#build-the-runtime-used-by-the-ui), but its
original manifest must pass the strict validator. Do not synthesize catalogs or
weaken checks. Native dependencies or compiler errors are failures to resolve,
not evidence that a later model test passed.

From the UI terminal:

```powershell
Set-Location $env:PI_UI_REPO
Invoke-Checked npm.cmd @('ci', '--ignore-scripts')
Invoke-Checked npm.cmd @('rebuild', 'node-pty')
Invoke-Checked npm.cmd @('run', 'typecheck')
Invoke-Checked npm.cmd @('run', 'build:server')
Invoke-Checked npm.cmd @('run', 'build:web')
```

The explicit node-pty rebuild is the repository-approved native dependency step.
If a command fails, fix that prerequisite before continuing.

## Build llama.cpp and select a local model

Create a new test directory outside both repositories. Keep its path available
for the subsequent terminals:

```powershell
$TestRoot = Join-Path $env:LOCALAPPDATA ('Workfree-validation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TestRoot | Out-Null
$LlamaDir = Join-Path $TestRoot 'llama.cpp'
Invoke-Checked git @('clone', '--depth', '1', '--branch', 'v0.5.0',
    'https://github.com/ggml-org/llama.cpp.git', $LlamaDir)
$LlamaCommit = (& git -C $LlamaDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $LlamaCommit -ne '7fe450e19305b828c199d602c23a8337aaa1f03b') {
    throw 'Unexpected llama.cpp source commit'
}
Invoke-Checked cmake @('-S', $LlamaDir, '-B', (Join-Path $LlamaDir 'build'),
    '-G', 'Visual Studio 17 2022', '-A', 'x64',
    '-DGGML_CUDA=OFF', '-DLLAMA_OPENSSL=OFF')
Invoke-Checked cmake @('--build', (Join-Path $LlamaDir 'build'),
    '--config', 'Release', '--target', 'llama-server', '-j', '4')
$LlamaServer = Join-Path $LlamaDir 'build\bin\Release\llama-server.exe'
if (-not (Test-Path -LiteralPath $LlamaServer)) {
    throw 'llama-server.exe not found; inspect the CMake output directory'
}
Invoke-Checked $LlamaServer @('--version')
$TestRoot
```

Your existing GGUF directory is **`D:\IA\modelos-llamacpp`**. Select an existing
file from it; llama.cpp receives that file's absolute path through `--model`.
pi-web-ui discovers models through the running server's API, rather than scanning
the GGUF directory itself.

```powershell
$ModelsDir = 'D:\IA\modelos-llamacpp'
Get-ChildItem -LiteralPath $ModelsDir -Recurse -File -Filter '*.gguf' |
    Select-Object -ExpandProperty FullName
$env:WORKFREE_GGUF = Read-Host 'Full path of the GGUF file to load from the list above'
if (-not (Test-Path -LiteralPath $env:WORKFREE_GGUF -PathType Leaf)) {
    throw 'Selected GGUF file does not exist'
}
if ([System.IO.Path]::GetExtension($env:WORKFREE_GGUF) -ine '.gguf') {
    throw 'Select a GGUF file'
}
```

Verify the selected file against its publisher's checksum before loading it.
Continue with the model-server command below. The test directory is still used
for disposable agent/UI data, independently of the existing model files.

The user confirmed moving the existing 2B GGUF out of `pipipiPopopo` into
`D:\IA\modelos-llamacpp` on 2026-10-07, preserving the model. Select its new full
path above and pass it to llama.cpp. No model deletion is needed. The cloud
checkout contains no 2B GGUF and cannot inspect the Windows drives. This records
the user's move confirmation, not a completed Windows inference validation.

### Optional small-model download

Skip this block when using a model you already have. If you choose this candidate,
download it into the same GGUF directory, preserving existing files:

```powershell
$env:WORKFREE_GGUF = Join-Path $ModelsDir 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf'
$ModelUrl = 'https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/69a2c192eed24297fb09a34d8ba948b8624cc3e2/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf'
$ExpectedHash = '0128e77564e43d40682f82d7ebe8a9abdf0c24c8f55fa85629f8cc156b1b6560'
$Partial = "$env:WORKFREE_GGUF.part"
if ((Test-Path -LiteralPath $env:WORKFREE_GGUF) -or (Test-Path -LiteralPath $Partial)) {
    throw 'Model or partial download already exists; preserve it and select or verify it separately'
}
Invoke-Checked curl.exe @('--fail', '--location', '--output', $Partial, $ModelUrl)
if ((Get-Item -LiteralPath $Partial).Length -ne 397808288) { throw 'Unexpected GGUF size' }
if ((Get-FileHash -LiteralPath $Partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {
    throw 'GGUF checksum mismatch; do not load this file'
}
Move-Item -LiteralPath $Partial -Destination $env:WORKFREE_GGUF
$TestRoot
```

This Apache-2.0, approximately 398 MB model is a CPU smoke-test candidate. It is
not a production recommendation or proof of coding/tool quality. The server
baseline uses loopback HTTP; external downloads retain TLS and checksum
verification. The initial cloud proxy blocked its CDN redirect; later publication
enabled verified downloads of other models. Check Windows network access independently.

This 0.5B model remains an unvalidated tool-call candidate. Actual cloud evidence
is different: SmolLM2-135M Q3_K_S (88 MB) passed text inference but failed the read
tool check; Qwen3-Coder-30B-A3B Q4_K_M (18.6 GB) passed real CLI/UI read-tool calls.
See the [verified sources, checksums and server options](workfree-local-models.md)
before substituting a model. The Coder cloud run used about 19 GiB with CPU
`--no-repack`; that observation does not establish Windows/GPU requirements or
performance. A small-model text reply does not complete tool validation.

Keep this PowerShell terminal running the model server:

```powershell
Invoke-Checked $LlamaServer @('--model', $env:WORKFREE_GGUF, '--alias', 'workfree-local',
    '--jinja', '--host', '127.0.0.1', '--port', '8080',
    '--ctx-size', '8192', '--parallel', '1', '--n-gpu-layers', '0', '--threads', '4')
```

## Check actual inference and a read-only tool

In another terminal, set the same repository paths and `Invoke-Checked` helper.
Use the printed test-directory path from the previous terminal:

```powershell
$TestRoot = Read-Host 'Test-directory path printed by the model terminal'
$env:PI_CODING_AGENT_DIR = Join-Path $TestRoot 'agent'
$TestProject = Join-Path $TestRoot 'project'
New-Item -ItemType Directory -Path $env:PI_CODING_AGENT_DIR, $TestProject | Out-Null
Copy-Item -LiteralPath (Join-Path $env:PI_RUNTIME_REPO 'packages\coding-agent\examples\models\workfree-local.json') `
    -Destination (Join-Path $env:PI_CODING_AGENT_DIR 'models.json')
$ModelProps = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/props'
if (-not $ModelProps.model_path -or $ModelProps.model_alias -ne 'workfree-local') {
    throw 'Cannot confirm the loaded model; inspect the running llama.cpp server'
}
$ModelConfigPath = Join-Path $env:PI_CODING_AGENT_DIR 'models.json'
$ModelConfig = Get-Content -LiteralPath $ModelConfigPath -Raw | ConvertFrom-Json
$ModelConfig.providers.'workfree-local'.models[0] |
    Add-Member -NotePropertyName name -NotePropertyValue ([System.IO.Path]::GetFileName($ModelProps.model_path)) -Force
[System.IO.File]::WriteAllText($ModelConfigPath, ($ModelConfig | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false))
Set-Content -LiteralPath (Join-Path $TestProject 'probe.txt') -Value 'WORKFREE_READ_PROBE_7421' -Encoding ASCII
$env:LLAMA_BASE_URL = 'http://127.0.0.1:8080'
$env:LLAMA_MODEL = 'workfree-local'
Invoke-Checked node @((Join-Path $env:PI_RUNTIME_REPO 'scripts\check-local-model.mjs'), '--inference')

$PiCli = Join-Path $env:PI_RUNTIME_REPO 'packages\coding-agent\dist\bundle\cli.js'
Invoke-Checked node @($PiCli, '--list-models', 'workfree-local')
Set-Location $TestProject
Invoke-Checked node @($PiCli, '--provider', 'workfree-local', '--model', 'workfree-local',
    '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-tools', '--print', 'Reply with a short greeting.')
Invoke-Checked node @($PiCli, '--provider', 'workfree-local', '--model', 'workfree-local',
    '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--tools', 'read', '--mode', 'json', '--print',
    'Use the read tool to read probe.txt. Return the exact marker from that file.')
```

Require a successful streaming health check and an actual `read` tool execution
in the JSON events, followed by the exact marker. A fabricated answer without a
tool call fails the tool test. Timeouts, context overflow, malformed tool calls
or repeated loops are failures to record. Do not bypass this check by granting
extra tools or substituting simulated model output.

## Test the UI with the same fork and provider

In the UI terminal, use the same test-directory path:

```powershell
$TestRoot = Read-Host 'Same test-directory path'
$env:PI_CODING_AGENT_DIR = Join-Path $TestRoot 'agent'
$env:PI_WEB_DATA_DIR = Join-Path $TestRoot 'ui-data'
$env:PI_WEB_CWD = Join-Path $TestRoot 'project'
$env:PI_WEB_HOST = '127.0.0.1'
$env:PI_WEB_PORT = '8788'
$env:PI_WEB_SDK = 'global'
$env:PI_WEB_SDK_DIR = Join-Path $env:PI_RUNTIME_REPO 'packages\coding-agent'
$env:PI_WEB_PLUGIN_CATALOG_URL = 'off'
$env:PI_WEB_AUTH_USERNAME = 'validation'
$LoginSecret = Read-Host 'Temporary UI login password (never send it in chat)' -AsSecureString
$env:PI_WEB_AUTH_PASSWORD = [System.Net.NetworkCredential]::new('', $LoginSecret).Password
Set-Location $env:PI_UI_REPO
Invoke-Checked npm.cmd @('start')
```

Use the local browser address printed by the server. Confirm the startup SDK
path/version and `/api/health` match the selected fork. Log in, apply the
Read only preset to the disposable project, select the actual GGUF filename
under provider `workfree-local`, and repeat
the greeting and `probe.txt` read request. Confirm streaming, the actual tool
card/result and any approval activity in the owning conversation. Logout must
end access. Do not expose this test server publicly or reuse its test credentials
for production. Close the test terminals when finished; these variables are
limited to their PowerShell processes.

`workfree-local` is a request-routing alias, not a model display name. The
configuration above records the running server's actual filename. To update an
existing UI configuration, refresh the saved provider in **Manage models**;
pi-web-ui reads `/v1/models` and, for llama.cpp, `/props`, preserving the routing
ID while replacing generic labels with the loaded GGUF filename.

Record Windows/tool versions, both Git commits, llama.cpp commit, verified GGUF
checksum, health-check output, greeting/tool results and any failure logs. The
second-device private HTTPS/Tailscale check is separate. Local inference does
not validate cloud publication, GPU performance or remote deployment.

## Record host and second-device deployment checks

The UI repository now provides a bounded check for the already running service,
including loaded agent version, anonymous HTTP/WS denial, password login/cookie
attributes, actual WS snapshot delivery, cross-origin logout denial and logout
invalidating HTTP/open WS access. Run it from the host first, then from the
authorized second Tailscale device using its actual HTTPS URL:

[PowerShell deployment-report procedure](https://github.com/qaworkfree/pi-web-ui/blob/main/docs/workfree-deployment-validation.md)

Use your existing login credentials locally; the JSON report omits them. No
agent tools/model prompts or project-setting changes are performed by that UI
checker. Preserve the real GGUF/tool evidence above separately. Browser
streaming, cross-device session revocation and GPU behavior still need their
actual observations; a passing cloud/loopback report does not validate them.
