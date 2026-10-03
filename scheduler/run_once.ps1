<#
.SYNOPSIS
  Uma execução desassistida do pipeline (`npm run pipeline`), pensada para o Agendador de Tarefas.

.DESCRIPTION
  - cwd = raiz do repositório (resolvida a partir deste arquivo), console/saída em UTF-8
  - usa o node/npm instalados (PATH, %ProgramFiles%\nodejs ou MAQUINA_NODE_DIR) e falha com mensagem clara se faltar
  - trava contra execuções sobrepostas (logs/scheduler/run.lock + pipeline aberto à mão): se já houver uma viva, registra e sai com 0
  - timeout de relógio (padrão 60 min) que mata a árvore de processos inteira
  - stdout/stderr em logs/scheduler/<aaaa-MM-dd>.log, com rotação (padrão 30 dias)
  - falha/timeout: grava data/alerts.jsonl (sem segredos) e tenta um toast do Windows (nunca trava o script)

  Códigos de saída (espelham o pipeline):
    0   sucesso (ou outra execução já em andamento: pulada)
    1   erro do pipeline ou do próprio wrapper (node ausente etc.)
    3   trava de qualidade: nenhum vídeo publicável hoje (aviso, não é falha)
    124 timeout: o pipeline foi encerrado à força
    outro: código devolvido pelo pipeline

  Modo de teste (não toca no pipeline real): defina MAQUINA_SCHEDULER_TEST=ok|fail|quality|hang.
  Roda scheduler/test/fake_pipeline.mjs, grava em logs/scheduler/<data>.test.log e marca alertas com "test": true.
#>
[CmdletBinding()]
param(
  [ValidateRange(0.05, 1440)][double]$TimeoutMinutes = 60,
  [ValidateRange(1, 3650)][int]$KeepLogDays = 30,
  [switch]$NoToast
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$EXIT_OK = 0
$EXIT_ERROR = 1
$EXIT_QUALITY_GATE = 3
$EXIT_TIMEOUT = 124
$MIN_NODE_MAJOR = 20
$TOAST_WAIT_MS = 15000

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SchedulerLogDir = Join-Path $RepoRoot 'logs\scheduler'
$LockPath = Join-Path $SchedulerLogDir 'run.lock'
$AlertsPath = Join-Path $RepoRoot 'data\alerts.jsonl'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$TestMode = "$env:MAQUINA_SCHEDULER_TEST".Trim().ToLowerInvariant()
if ($TestMode -and $TestMode -notin @('ok', 'fail', 'quality', 'hang')) {
  Write-Error "MAQUINA_SCHEDULER_TEST inválido: '$TestMode' (use ok|fail|quality|hang)"
  exit $EXIT_ERROR
}
$LogSuffix = if ($TestMode) { '.test.log' } else { '.log' }
$LogPath = Join-Path $SchedulerLogDir ((Get-Date -Format 'yyyy-MM-dd') + $LogSuffix)

# ---------------------------------------------------------------- utilidades

function Add-LogText([string]$Text) {
  # Outro wrapper pode estar escrevendo no mesmo instante: algumas tentativas curtas.
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try { [System.IO.File]::AppendAllText($LogPath, $Text, $Utf8NoBom); return } catch { Start-Sleep -Milliseconds 100 }
  }
}

function Write-SchedLog([string]$Level, [string]$Message) {
  $line = '{0} [scheduler] {1} {2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz'), $Level, $Message
  Add-LogText ($line + "`r`n")
  Write-Host $line
}

function Set-Utf8Console {
  try { [Console]::OutputEncoding = $Utf8NoBom } catch { }  # sem console (sessão oculta): ignora
  try { [Console]::InputEncoding = $Utf8NoBom } catch { }
  $global:OutputEncoding = $Utf8NoBom
  $env:PYTHONUTF8 = '1'
  $env:PYTHONIOENCODING = 'utf-8'
  $env:FORCE_COLOR = '0'
  $env:NO_COLOR = '1'
}

function Get-EnvFileSecrets {
  # Valores do .env cujo nome sugere segredo: só para mascarar mensagens de alerta, nunca gravados.
  $envFile = Join-Path $RepoRoot '.env'
  $values = @()
  if (-not (Test-Path -LiteralPath $envFile)) { return $values }
  foreach ($line in [System.IO.File]::ReadAllLines($envFile)) {
    if ($line -notmatch '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { continue }
    $name = $Matches[1]
    $value = $Matches[2].Trim().Trim('"').Trim("'")
    if ($name -match '(?i)KEY|TOKEN|SECRET|PASSWORD|CLIENT' -and $value.Length -ge 6) { $values += $value }
  }
  return $values
}

function Protect-Secrets([string]$Text) {
  if (-not $Text) { return '' }
  foreach ($secret in (Get-EnvFileSecrets)) { $Text = $Text.Replace($secret, '[redacted]') }
  $patterns = @(
    'AIza[0-9A-Za-z_\-]{20,}',
    'sk-ant-[0-9A-Za-z_\-]{10,}',
    'sk-[0-9A-Za-z_\-]{20,}',
    'ya29\.[0-9A-Za-z_\-\.]+',
    '1//[0-9A-Za-z_\-]{20,}',
    '(?i)bearer\s+[0-9A-Za-z_\-\.=]+'
  )
  foreach ($pattern in $patterns) { $Text = [regex]::Replace($Text, $pattern, '[redacted]') }
  return [regex]::Replace($Text, '(?i)\b(\w*(?:key|token|secret|password)\w*)(["'']?\s*[:=]\s*["'']?)([^\s"'',;]{6,})', '$1$2[redacted]')
}

# ---------------------------------------------------------------- trava

function Get-ProcessStartTicks([int]$ProcessId) {
  try { return (Get-Process -Id $ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks } catch { return $null }
}

function Test-LockHolderAlive($Holder) {
  $process = Get-Process -Id ([int]$Holder.pid) -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  $ticks = Get-ProcessStartTicks ([int]$Holder.pid)
  if ($null -eq $ticks -or -not $Holder.processStartTicks) { return $true }  # sem como comparar: assume viva
  # PID reaproveitado por outro processo = trava velha
  return [math]::Abs([long]$ticks - [long]$Holder.processStartTicks) -lt [TimeSpan]::FromSeconds(2).Ticks
}

function Enter-RunLock {
  # Devolve $null se adquiriu; senão, o dono vivo da trava.
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      try {
        $holder = [ordered]@{
          pid               = $PID
          processStartTicks = (Get-ProcessStartTicks $PID)
          startedAt         = (Get-Date -Format 'o')
          testMode          = $TestMode
        }
        $bytes = $Utf8NoBom.GetBytes(($holder | ConvertTo-Json -Compress))
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
      return $null
    } catch {
      if (-not (Test-Path -LiteralPath $LockPath)) { throw }
    }
    $holder = $null
    try { $holder = [System.IO.File]::ReadAllText($LockPath, $Utf8NoBom) | ConvertFrom-Json } catch { }
    if ($holder -and $holder.PSObject.Properties['pid']) {
      if (Test-LockHolderAlive $holder) { return $holder }
      Write-SchedLog 'WARN' "Trava velha (PID $($holder.pid) encerrado ou reaproveitado por outro processo; desde $($holder.startedAt)): removendo"
    } else {
      $age = (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
      if ($age.TotalSeconds -lt 60) { Start-Sleep -Seconds 2; continue }  # alguém acabou de criar e ainda está escrevendo
      Write-SchedLog 'WARN' 'Trava ilegível e antiga: removendo'
    }
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }
  throw "não foi possível adquirir a trava $LockPath"
}

function Exit-RunLock {
  try {
    $holder = [System.IO.File]::ReadAllText($LockPath, $Utf8NoBom) | ConvertFrom-Json
    if ([int]$holder.pid -eq $PID) { Remove-Item -LiteralPath $LockPath -Force }
  } catch { }
}

function Get-ManualPipelineProcess {
  # Pipeline aberto fora do agendador (npm run pipeline no terminal): não roda em paralelo.
  $marker = if ($TestMode) { 'fake_pipeline.mjs' } else { 'runPipeline.ts' }
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) }) | Select-Object -First 1
  } catch { return $null }
}

# ---------------------------------------------------------------- node/npm

function Resolve-NodeTooling {
  # MAQUINA_NODE_DIR, se definido, é a única opção (override explícito não cai silenciosamente em outro node).
  $candidates = @()
  if ($env:MAQUINA_NODE_DIR) {
    $candidates += $env:MAQUINA_NODE_DIR
  } else {
    $onPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $candidates += (Split-Path -Parent $onPath.Source) }
    $candidates += (Join-Path $env:ProgramFiles 'nodejs')
  }
  foreach ($dir in $candidates) {
    $node = Join-Path $dir 'node.exe'
    $npm = Join-Path $dir 'npm.cmd'
    if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $npm)) {
      $version = (& $node --version 2>$null | Select-Object -First 1)
      if ("$version" -match '^v(\d+)\.' -and [int]$Matches[1] -ge $MIN_NODE_MAJOR) {
        return [pscustomobject]@{ Dir = $dir; Node = $node; Npm = $npm; Version = "$version" }
      }
      Write-SchedLog 'WARN' "Node em $dir é $version (precisa >= $MIN_NODE_MAJOR): ignorando"
    }
  }
  throw "node.exe >= $MIN_NODE_MAJOR com npm.cmd não encontrado em: $($candidates -join '; '). Instale o Node.js LTS ou defina MAQUINA_NODE_DIR."
}

function Get-PipelineCommand($Tooling) {
  if ($TestMode) {
    $fake = Join-Path $PSScriptRoot 'test\fake_pipeline.mjs'
    return '"{0}" "{1}" {2}' -f $Tooling.Node, $fake, $TestMode
  }
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'))) {
    throw "node_modules incompleto (tsx ausente em $RepoRoot\node_modules\.bin). Rode 'npm install' na raiz do projeto."
  }
  return '"{0}" run pipeline' -f $Tooling.Npm
}

# ---------------------------------------------------------------- execução

function Stop-ProcessTree([int]$ProcessId) {
  # taskkill /T percorre a árvore (cmd -> npm -> node/tsx -> python/ffmpeg/chrome)
  & "$env:SystemRoot\System32\taskkill.exe" /PID $ProcessId /T /F *> $null
  return $LASTEXITCODE
}

function Invoke-PipelineWithTimeout([string]$Command, [string]$OutputPath) {
  # cmd.exe redireciona os bytes do filho direto para um arquivo próprio desta execução (sem recodificação
  # pelo PowerShell); o log do dia continua livre para outros wrappers e recebe a saída no fim.
  $cmdLine = '/d /s /c "chcp 65001 >nul & {0} <nul >"{1}" 2>&1"' -f $Command, $OutputPath
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $startInfo.Arguments = $cmdLine
  $startInfo.WorkingDirectory = $RepoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  Write-SchedLog 'INFO' "Executando: $Command (timeout $TimeoutMinutes min)"
  $process = [System.Diagnostics.Process]::Start($startInfo)
  Write-Host "Pipeline iniciado (PID $($process.Id))"
  $timeoutMs = [int][math]::Min([int]::MaxValue, $TimeoutMinutes * 60 * 1000)
  if ($process.WaitForExit($timeoutMs)) {
    $process.WaitForExit()  # garante ExitCode consolidado
    return [pscustomobject]@{ TimedOut = $false; ExitCode = $process.ExitCode; ProcessId = $process.Id }
  }
  $killExit = Stop-ProcessTree $process.Id
  $exited = $process.WaitForExit(30000)
  Write-SchedLog 'ERROR' "Timeout de $TimeoutMinutes min: árvore do PID $($process.Id) encerrada (taskkill código $killExit, cmd.exe encerrou: $exited)"
  return [pscustomobject]@{ TimedOut = $true; ExitCode = $EXIT_TIMEOUT; ProcessId = $process.Id }
}

function Move-OutputToLog([string]$OutputPath) {
  # Copia a saída desta execução para o log do dia e apaga o arquivo temporário. Devolve o texto.
  if (-not (Test-Path -LiteralPath $OutputPath)) { return '' }
  try {
    $stream = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try { $text = (New-Object System.IO.StreamReader($stream, $Utf8NoBom)).ReadToEnd() } finally { $stream.Dispose() }
  } catch {
    Write-SchedLog 'WARN' "Não foi possível ler $OutputPath ($($_.Exception.Message)); mantido no disco"
    return ''
  }
  if ($text -and -not $text.EndsWith("`n")) { $text += "`r`n" }
  Add-LogText $text
  Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
  return $text
}

function Get-RunIdFromOutput([string]$Output) {
  $found = [regex]::Matches($Output, '\bRun (\d{8}-\d{6}-[0-9a-z]{4})\b')
  if ($found.Count -eq 0) { return $null }
  return $found[$found.Count - 1].Groups[1].Value
}

function Get-FailureSummary([string]$Output) {
  $lines = @($Output -split "`r?`n" | Where-Object { $_.Trim() -and $_ -notmatch '\[scheduler\]' })
  $pick = @($lines | Where-Object { $_ -match 'Pipeline failed:|\[ERROR\]' }) | Select-Object -Last 1
  if (-not $pick) { $pick = $lines | Select-Object -Last 1 }
  $text = Protect-Secrets ("$pick".Trim())
  if ($text.Length -gt 400) { $text = $text.Substring(0, 400) + '...' }
  return $text
}

# ---------------------------------------------------------------- alertas

function Write-Alert([string]$Kind, [string]$Message, $ExitCode, $RunId) {
  try {
    $alert = [ordered]@{
      timestamp = (Get-Date -Format 'o')
      kind      = $Kind
      message   = (Protect-Secrets $Message)
      exitCode  = $ExitCode
      runId     = $(if ($RunId) { [string]$RunId } else { $null })
      log       = ('logs/scheduler/' + (Split-Path -Leaf $LogPath))
    }
    if ($TestMode) { $alert['test'] = $true }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AlertsPath) | Out-Null
    [System.IO.File]::AppendAllText($AlertsPath, ($alert | ConvertTo-Json -Compress) + "`n", $Utf8NoBom)
    Write-SchedLog 'INFO' "Alerta '$Kind' gravado em data/alerts.jsonl"
  } catch {
    Write-SchedLog 'WARN' "Não foi possível gravar o alerta: $($_.Exception.Message)"
  }
}

function Show-Toast([string]$Title, [string]$Body) {
  if ($NoToast -or $env:MAQUINA_SCHEDULER_NO_TOAST -eq '1') { return }
  try {
    $escTitle = [System.Security.SecurityElement]::Escape($Title)
    $escBody = [System.Security.SecurityElement]::Escape($Body)
    # Processo separado com prazo: WinRT indisponível ou travado não segura o wrapper.
    $toastScript = @"
`$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
`$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
`$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>$escTitle</text><text>$escBody</text></binding></visual></toast>')
`$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(`$appId).Show([Windows.UI.Notifications.ToastNotification]::new(`$xml))
"@
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($toastScript))
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $toastProcess = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) -WindowStyle Hidden -PassThru
    if (-not $toastProcess.WaitForExit($TOAST_WAIT_MS)) {
      Stop-Process -Id $toastProcess.Id -Force -ErrorAction SilentlyContinue
      Write-SchedLog 'WARN' "Toast não respondeu em $($TOAST_WAIT_MS / 1000) s: abandonado"
    } elseif ($toastProcess.ExitCode -eq 0) {
      Write-SchedLog 'INFO' 'Toast exibido'
    } else {
      Write-SchedLog 'WARN' "Toast indisponível (código $($toastProcess.ExitCode))"
    }
  } catch {
    Write-SchedLog 'WARN' "Toast indisponível: $($_.Exception.Message)"
  }
}

function Send-FailureNotice([string]$Kind, [string]$Message, $ExitCode, $RunId) {
  Write-Alert $Kind $Message $ExitCode $RunId
  $prefix = if ($TestMode) { '[TESTE] ' } else { '' }
  $body = if ($RunId) { "$Message (run $RunId)" } else { $Message }
  if ($body.Length -gt 200) { $body = $body.Substring(0, 200) + '...' }
  Show-Toast "${prefix}Máquina de Shorts: $Kind" $body
}

# ---------------------------------------------------------------- rotação

function Remove-OldSchedulerLogs {
  $cutoff = (Get-Date).AddDays(-$KeepLogDays)
  # *.out = saída de execução cujo wrapper morreu antes de copiá-la para o log do dia (ex.: Agendador encerrou)
  Get-ChildItem -LiteralPath $SchedulerLogDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.log', '.out') -and $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
      Write-SchedLog 'INFO' "Rotação: removido $($_.Name)"
    }
}

# ---------------------------------------------------------------- principal

function Invoke-ScheduledRun {
  Set-Location -LiteralPath $RepoRoot
  [Environment]::CurrentDirectory = $RepoRoot
  Set-Utf8Console
  New-Item -ItemType Directory -Force -Path $SchedulerLogDir | Out-Null

  $label = if ($TestMode) { " [TESTE: $TestMode]" } else { '' }
  Write-SchedLog 'INFO' "=== Início$label (PID $PID, usuário $env:USERNAME, repo $RepoRoot)"
  Remove-OldSchedulerLogs

  $holder = Enter-RunLock
  if ($holder) {
    Write-SchedLog 'WARN' "Execução anterior ainda ativa (PID $($holder.pid), desde $($holder.startedAt)): pulando esta"
    return $EXIT_OK
  }
  try {
    $manual = Get-ManualPipelineProcess
    if ($manual) {
      Write-SchedLog 'WARN' "Pipeline já rodando fora do agendador (node PID $($manual.ProcessId)): pulando esta"
      return $EXIT_OK
    }

    $tooling = Resolve-NodeTooling
    $env:Path = $tooling.Dir + ';' + $env:Path  # npm e filhos usam o mesmo node
    Write-SchedLog 'INFO' "Node $($tooling.Version) em $($tooling.Dir)"
    $command = Get-PipelineCommand $tooling

    $outputPath = Join-Path $SchedulerLogDir ('pipeline-{0:yyyyMMdd-HHmmss}-{1}.out' -f (Get-Date), $PID)
    $started = Get-Date
    $result = Invoke-PipelineWithTimeout $command $outputPath
    $elapsed = '{0:N1} min' -f ((Get-Date) - $started).TotalMinutes
    $output = Move-OutputToLog $outputPath
    $runId = Get-RunIdFromOutput $output
    $runNote = if ($runId) { "run $runId" } else { 'runId não detectado' }

    if ($result.TimedOut) {
      Write-SchedLog 'ERROR' "TIMEOUT após $elapsed ($runNote)"
      Send-FailureNotice 'timeout' "Pipeline excedeu $TimeoutMinutes min e foi encerrado" $EXIT_TIMEOUT $runId
      return $EXIT_TIMEOUT
    }
    if ($result.ExitCode -eq $EXIT_OK) {
      Write-SchedLog 'INFO' "OK em $elapsed ($runNote)"
    } elseif ($result.ExitCode -eq $EXIT_QUALITY_GATE) {
      Write-SchedLog 'WARN' "Trava de qualidade (código 3): nenhum vídeo publicável hoje ($runNote, $elapsed)"
    } else {
      $summary = Get-FailureSummary $output
      Write-SchedLog 'ERROR' "FALHA código $($result.ExitCode) em $elapsed ($runNote): $summary"
      Send-FailureNotice 'failure' "Pipeline falhou (código $($result.ExitCode)): $summary" $result.ExitCode $runId
    }
    return $result.ExitCode
  } finally {
    Exit-RunLock
  }
}

$exitCode = $EXIT_ERROR
try {
  $exitCode = Invoke-ScheduledRun
} catch {
  $message = "Erro no wrapper do agendador: $($_.Exception.Message)"
  Write-SchedLog 'ERROR' $message
  Send-FailureNotice 'wrapper_error' $message $EXIT_ERROR $null
  $exitCode = $EXIT_ERROR
}
Write-SchedLog 'INFO' "=== Fim (código de saída $exitCode)"
exit $exitCode
