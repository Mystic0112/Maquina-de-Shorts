# Idempotent: installs uv (if missing), Python 3.12 and the Kokoro venv outside the project
# (torch is heavy), then speaks one pt-BR sentence with the project's synthesize_kokoro.py.
#
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup_kokoro.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup_kokoro.ps1 -Torch cpu   # no NVIDIA GPU
# Afterwards set KOKORO_PYTHON in .env to the python.exe it prints (scripts/loop.ps1 uses the same default).

param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'maquina-tts\kokoro'),
    [ValidateSet('cu130', 'cu124', 'cpu')]
    [string]$Torch = 'cu130'
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Target 'Scripts\python.exe'

function Invoke-Native {
    # Plain function so flags pass through $args; rely on the exit code (PowerShell 5.1 stderr quirk).
    $NativeArgs = $args
    $ErrorActionPreference = 'Continue'
    & $NativeArgs[0] @($NativeArgs | Select-Object -Skip 1) 2>&1 | ForEach-Object { Write-Host "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$($NativeArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host 'Installing uv ...'
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv was installed but is not on PATH; open a new terminal and re-run.' }
}

Invoke-Native uv python install 3.12

if (-not (Test-Path $Python)) {
    Write-Host "Creating venv at $Target ..."
    Invoke-Native uv venv --python 3.12 $Target
}

$index = "https://download.pytorch.org/whl/$Torch"
Invoke-Native uv pip install --python $Python --index-url $index --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match torch
Invoke-Native uv pip install --python $Python kokoro soundfile

# Smoke test: one sentence through the same script the pipeline uses.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "kokoro_setup_$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    $text = Join-Path $tmp 'frase.txt'
    $wav = Join-Path $tmp 'frase.wav'
    [System.IO.File]::WriteAllText($text, 'O beija-flor bate as asas até oitenta vezes por segundo.', (New-Object System.Text.UTF8Encoding $false))
    Invoke-Native $Python -X utf8 (Join-Path $ProjectRoot 'python\tts\synthesize_kokoro.py') --text-file $text --out $wav --voice pm_alex
    if (-not (Test-Path $wav) -or (Get-Item $wav).Length -lt 10000) { throw 'Kokoro produced no audio.' }
    Write-Host "Kokoro OK ($([math]::Round((Get-Item $wav).Length / 1KB)) KB of audio)."
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host "KOKORO_PYTHON=$Python"
