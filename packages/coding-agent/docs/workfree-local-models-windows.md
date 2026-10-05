# Workfree local validation with PowerShell

Use this procedure to validate the existing runtime and UI on Windows. These
PowerShell steps have **not been executed on the user's PC**. Record command
results; do not mark inference or tool compatibility passed until observed.
The Linux CPU build was checked separately. Keep the Workfree reference app and
OS sandboxing outside this test.

## Prerequisites and existing repositories

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

## Build llama.cpp and download a small test model

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

$env:WORKFREE_GGUF = Join-Path $TestRoot 'Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf'
$ModelUrl = 'https://huggingface.co/bartowski/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/69a2c192eed24297fb09a34d8ba948b8624cc3e2/Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf'
$ExpectedHash = '0128e77564e43d40682f82d7ebe8a9abdf0c24c8f55fa85629f8cc156b1b6560'
$Partial = "$env:WORKFREE_GGUF.part"
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
verification. The cloud proxy currently blocks the download's CDN redirect;
local network access must be checked independently.

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
Set-Content -LiteralPath (Join-Path $TestProject 'probe.txt') -Value 'WORKFREE_READ_PROBE_7421' -Encoding ASCII
$env:LLAMA_BASE_URL = 'http://127.0.0.1:8080'
$env:LLAMA_MODEL = 'workfree-local'
Invoke-Checked node @((Join-Path $env:PI_RUNTIME_REPO 'scripts\check-local-model.mjs'))

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
Read only preset to the disposable project, select `workfree-local`, and repeat
the greeting and `probe.txt` read request. Confirm streaming, the actual tool
card/result and any approval activity in the owning conversation. Logout must
end access. Do not expose this test server publicly or reuse its test credentials
for production. Close the test terminals when finished; these variables are
limited to their PowerShell processes.

Record Windows/tool versions, both Git commits, llama.cpp commit, verified GGUF
checksum, health-check output, greeting/tool results and any failure logs. The
second-device private HTTPS/Tailscale check is separate. Local inference does
not validate cloud publication, GPU performance or remote deployment.
