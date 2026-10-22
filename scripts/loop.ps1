# Unattended production loop: one video per iteration with the zero-API setup (agy + Kokoro),
# never publishing (--until 06-renderVideo). Stops on its own on the safety conditions below.
#
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/loop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/loop.ps1 -MaxVideos 4 -PullBetween
#
# Pause between videos: create logs/_loop/PAUSE (the current video finishes first); delete it to resume.
# Stops when: upload.enabled is not false, free disk < MinFreeGB, a real quota/credits error, or
# MaxFailures consecutive failed videos (exit code other than 0 = ok and 3 = nothing publishable).

param(
    [string]$KokoroPython = (Join-Path $env:LOCALAPPDATA 'maquina-tts\kokoro\Scripts\python.exe'),
    [string]$AgyPath = '',
    [int]$MaxVideos = 0,          # 0 = no limit
    [int]$MinFreeGB = 15,
    [int]$MaxFailures = 2,
    [switch]$PullBetween          # git pull --ff-only + vitest between videos (a failure pauses the loop)
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LoopDir     = Join-Path $ProjectRoot 'logs\_loop'
$PauseFile   = Join-Path $LoopDir 'PAUSE'
$Summary     = Join-Path $LoopDir 'summary.jsonl'
$ConfigFile  = Join-Path $ProjectRoot 'config\pipeline.config.json'
New-Item -ItemType Directory -Force -Path $LoopDir | Out-Null

# Quota lines only count when they come from an error/agy line; the Kokoro HF Hub warning
# ("higher rate limits") once produced a false positive; a bare 429 matched timestamps ("…17.429Z") and
# file ids, so 429 only counts next to status/code/http/error.
$QuotaPattern = 'credits balance|too low to continue|resource_exhausted|quota|rate.?limit|too many requests|usage limit|(status|code|http|error|erro)[^0-9A-Za-z]{0,3}429([^0-9]|$)'
$ContextPattern = 'xx |ERROR|WARN|agy|antigravity|LlmOutputError|status'

function Write-Event([hashtable]$Data) {
    # A reader holding summary.jsonl (a `tail -F`, the dashboard) must never kill the loop: retry, then give up.
    $Data['at'] = (Get-Date).ToString('s')
    if ($Data['event'] -in @('stop', 'abort', 'done')) { $script:Ended = $true }
    $line = $Data | ConvertTo-Json -Compress
    for ($try = 1; $try -le 3; $try++) {
        try { Add-Content -Path $Summary -Value $line -Encoding utf8 -ErrorAction Stop; return }
        catch { Start-Sleep -Seconds 2 }
    }
    Write-Warning "summary.jsonl is locked; event not written: $line"
}

function Test-UploadDisabled {
    # Both publishers must be off: YouTube explicitly false, Instagram absent or not true.
    $config = Get-Content -Raw -Path $ConfigFile | ConvertFrom-Json
    $youtubeOff = ($null -ne $config.upload) -and ($config.upload.enabled -eq $false)
    $instagramOff = ($null -eq $config.instagram) -or ($config.instagram.enabled -ne $true)
    return $youtubeOff -and $instagramOff
}

function Get-FreeGB {
    $drive = (Get-Item $ProjectRoot).PSDrive.Name
    return [math]::Floor((Get-PSDrive $drive).Free / 1GB)
}

function Test-QuotaHit([string]$LogFile) {
    $lines = Select-String -Path $LogFile -Pattern $ContextPattern |
        Where-Object { $_.Line -notmatch 'HF Hub|HF_TOKEN' -and $_.Line -match $QuotaPattern }
    return @($lines)
}

function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$LogFile) {
    # Through cmd.exe so the log stays UTF-8 and native stderr is not turned into PowerShell errors.
    $ErrorActionPreference = 'Continue'
    $quoted = ($Arguments | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
    & cmd.exe /d /c "$Exe $quoted > `"$LogFile`" 2>&1"
    return $LASTEXITCODE
}

function Update-Code {
    $before = Get-Content -Raw -Path $ConfigFile
    if ((Invoke-Native 'git' @('-C', $ProjectRoot, 'pull', '--ff-only') (Join-Path $LoopDir 'pull.out')) -ne 0) {
        throw 'git pull --ff-only failed (see logs/_loop/pull.out)'
    }
    if ((Get-Content -Raw -Path $ConfigFile) -ne $before) { throw 'git pull changed config/pipeline.config.json' }
    Push-Location $ProjectRoot
    try {
        if ((Invoke-Native 'npx.cmd' @('vitest', 'run') (Join-Path $LoopDir 'vitest.out')) -ne 0) {
            throw 'vitest failed after the pull (see logs/_loop/vitest.out)'
        }
    } finally { Pop-Location }
    Write-Event @{ event = 'pull'; commit = (& git -C $ProjectRoot rev-parse --short HEAD) }
}

# Production environment: plan credits only, no paid API fallback.
$env:LLM_PROVIDER = 'antigravity-cli'
$env:ANTIGRAVITY_FALLBACK = 'none'
$env:ANTIGRAVITY_CLI_TIMEOUT_S = '240'
$env:ANTIGRAVITY_CLI_SESSION_TURNS = '6'
$env:ANTIGRAVITY_CLI_CONCURRENCY = '4'
$env:KOKORO_PYTHON = $KokoroPython
if ($AgyPath) { $env:ANTIGRAVITY_CLI_PATH = $AgyPath }
Remove-Item Env:ANTIGRAVITY_MODEL -ErrorAction SilentlyContinue

if (-not (Test-Path $KokoroPython)) { throw "Kokoro Python not found: $KokoroPython (run scripts/setup_kokoro.ps1)" }

$failures = 0
$done = 0
Write-Event @{ event = 'start'; maxVideos = $MaxVideos; pullBetween = [bool]$PullBetween }
# Ctrl+C or a killed console skips the stop events above; the finally block still leaves a trace.
$script:Ended = $false
try {
    while ($MaxVideos -eq 0 -or $done -lt $MaxVideos) {
        while (Test-Path $PauseFile) { Start-Sleep -Seconds 20 }
        if (-not (Test-UploadDisabled)) { Write-Event @{ event = 'abort'; reason = 'publishing is enabled (upload or instagram)' }; exit 1 }
        $free = Get-FreeGB
        if ($free -lt $MinFreeGB) { Write-Event @{ event = 'stop'; reason = "free disk ${free} GB < $MinFreeGB GB" }; exit 0 }
        if ($PullBetween -and $done -gt 0) {
            try { Update-Code } catch {
                Write-Event @{ event = 'paused'; reason = "$_" }
                New-Item -ItemType File -Force -Path $PauseFile | Out-Null
                continue
            }
        }

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $log = Join-Path $LoopDir "video_$stamp.out"
        $started = Get-Date
        Push-Location $ProjectRoot
        try { $code = Invoke-Native 'npm.cmd' @('run', 'pipeline', '--', '--until', '06-renderVideo') $log } finally { Pop-Location }
        $done += 1
        Write-Event @{ event = 'video'; log = (Split-Path -Leaf $log); exit = $code; minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1) }

        $quota = Test-QuotaHit $log
        if ($quota.Count -gt 0) {
            Write-Event @{ event = 'stop'; reason = 'quota'; line = $quota[0].Line.Substring(0, [math]::Min(300, $quota[0].Line.Length)) }
            exit 2
        }
        if ($code -ne 0 -and $code -ne 3) { $failures += 1 } else { $failures = 0 }
        if ($failures -ge $MaxFailures) { Write-Event @{ event = 'stop'; reason = "$failures consecutive failures" }; exit 1 }
    }
    Write-Event @{ event = 'done'; videos = $done }
} finally {
    if (-not $script:Ended) { Write-Event @{ event = 'interrupted'; videos = $done } }
}
