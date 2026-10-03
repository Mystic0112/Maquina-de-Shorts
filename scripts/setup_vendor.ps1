# Idempotent: creates/updates a sparse clone of OpenMontage (AGPL-3.0) in vendor/openmontage,
# pinned to a known commit. Only /tools/ and /lib/ are checked out: a full checkout fails on
# Windows (path too long under .agents/), and the repo root carries third-party agent
# instructions (.claude/, CLAUDE.md, AGENTS.md, .agents/) that must never land in this project.
#
# Usage (from anywhere):  powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1

$ErrorActionPreference = 'Stop'

$RepoUrl   = 'https://github.com/calesthio/OpenMontage.git'
$PinCommit = '08e2151fa02de28a5d6a312b3d575692bf147ad7'
$Patterns  = @('/tools/', '/lib/')

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Target      = Join-Path $ProjectRoot 'vendor\openmontage'

function Invoke-Git {
    # Plain (non-advanced) function so git flags like -C / -c pass through untouched via $args.
    $GitArgs = $args
    # Windows PowerShell 5.1 turns native stderr (git progress) into terminating errors under
    # 'Stop' when output is redirected, so rely on the exit code instead.
    $ErrorActionPreference = 'Continue'
    & git @GitArgs 2>&1 | ForEach-Object { Write-Host "$_" }
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

function Test-IsGitRepo([string]$Path) {
    if (-not (Test-Path (Join-Path $Path '.git'))) { return $false }
    $ErrorActionPreference = 'Continue'
    & git -C $Path rev-parse --git-dir *> $null
    return ($LASTEXITCODE -eq 0)
}

function Get-Head([string]$Path) {
    $ErrorActionPreference = 'Continue'
    $out = & git -C $Path rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return '' }
    return "$out".Trim()
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git not found on PATH.' }

if (-not (Test-IsGitRepo $Target)) {
    if (Test-Path $Target) {
        throw "$Target exists but is not a git repository. Remove it manually and re-run."
    }
    Write-Host "Cloning OpenMontage (sparse, blobless) into $Target ..."
    Invoke-Git clone --depth 1 --filter=blob:none --no-checkout $RepoUrl $Target
}

# Long paths are still worth enabling locally in case tools/ grows deep paths.
Invoke-Git -C $Target config core.longpaths true
Invoke-Git -C $Target sparse-checkout set --no-cone @Patterns

$head = Get-Head $Target
if ($head -ne $PinCommit) {
    Write-Host "HEAD is '$head'; fetching pinned commit $PinCommit ..."
    Invoke-Git -C $Target fetch --depth 1 --filter=blob:none origin $PinCommit
}

# A --no-checkout clone leaves an empty index, so always force-checkout the pinned commit;
# with the sparse patterns already set this only materialises /tools/ and /lib/ (and it also
# repairs a modified tree on re-runs).
Invoke-Git -C $Target -c advice.detachedHead=false checkout --force $PinCommit

$head = Get-Head $Target
if ($head -ne $PinCommit) { throw "Pinned commit mismatch: HEAD=$head expected=$PinCommit" }

foreach ($forbidden in @('.claude', 'CLAUDE.md', 'AGENTS.md', '.agents')) {
    if (Test-Path (Join-Path $Target $forbidden)) {
        throw "Forbidden third-party path present in checkout: $forbidden. Delete vendor/openmontage and re-run."
    }
}

$toolFile = Join-Path $Target 'tools\video\direct_clip_search.py'
if (-not (Test-Path $toolFile)) { throw "Expected file missing after checkout: $toolFile" }

Write-Host "OpenMontage ready at $Target (commit $head)."
