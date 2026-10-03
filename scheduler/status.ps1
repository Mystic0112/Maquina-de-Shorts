<#
.SYNOPSIS
  Mostra o estado da tarefa "Maquina de Shorts": estado, última/próxima execução, último resultado,
  execução em andamento (trava) e os últimos alertas de data/alerts.jsonl. Só leitura.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\status.ps1
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'Maquina de Shorts',
  [ValidateRange(1, 50)][int]$AlertCount = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$repoRoot = Split-Path -Parent $PSScriptRoot
$schedulerLogDir = Join-Path $repoRoot 'logs\scheduler'
$lockPath = Join-Path $schedulerLogDir 'run.lock'
$alertsPath = Join-Path $repoRoot 'data\alerts.jsonl'

function Format-TaskResult([long]$Code) {
  $meaning = switch ($Code) {
    0 { 'sucesso' }
    1 { 'erro do pipeline ou do wrapper' }
    3 { 'trava de qualidade: nenhum vídeo publicável' }
    124 { 'timeout: pipeline encerrado à força' }
    267009 { 'em execução agora' }                                 # 0x41301
    267011 { 'ainda não executou' }                                 # 0x41303
    267014 { 'interrompida pelo usuário' }                          # 0x41306
    2147750687 { 'já havia uma instância rodando (ignorada)' }      # 0x8004131F
    2147946720 { 'recusada pelo Windows (condição/conta)' }         # 0x800710E0
    3221225786 { 'encerrada (Ctrl+C / fechamento)' }                # 0xC000013A
    default { 'código desconhecido' }
  }
  return ('{0} (0x{1:X}): {2}' -f $Code, $Code, $meaning)
}

function Format-Date($Value) {
  if (-not $Value -or ([datetime]$Value).Year -lt 2000) { return '-' }
  return ([datetime]$Value).ToString('dd/MM/yyyy HH:mm:ss')
}

Write-Host "== Tarefa '$TaskName'"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host '   Não registrada. Para registrar: scheduler\register_task.ps1 (veja o README).'
} else {
  $info = $task | Select-Object -First 1 | Get-ScheduledTaskInfo
  $times = @($task.Triggers | ForEach-Object {
      if (-not $_.StartBoundary) { return $_.CimClass.CimClassName }  # gatilho sem horário (logon, evento...)
      $delay = if ($_.RandomDelay) { ' (+até {0} min)' -f [System.Xml.XmlConvert]::ToTimeSpan($_.RandomDelay).TotalMinutes } else { '' }
      '{0:HH:mm}{1}' -f ([datetime]$_.StartBoundary), $delay
    })
  Write-Host "   Estado:          $($task.State)"
  Write-Host "   Horários:        $($times -join ', ')"
  Write-Host "   Última execução: $(Format-Date $info.LastRunTime)"
  Write-Host "   Último resultado: $(Format-TaskResult ([uint32]$info.LastTaskResult))"
  Write-Host "   Próxima:         $(Format-Date $info.NextRunTime)"
  Write-Host "   Perdidas:        $($info.NumberOfMissedRuns)"
}

Write-Host ''
Write-Host '== Execução em andamento'
if (Test-Path -LiteralPath $lockPath) {
  try {
    $holder = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $alive = [bool](Get-Process -Id ([int]$holder.pid) -ErrorAction SilentlyContinue)
    $state = if ($alive) { 'ativa' } else { 'trava velha: o PID não existe mais (a próxima execução limpa)' }
    Write-Host "   PID $($holder.pid) desde $($holder.startedAt): $state"
  } catch { Write-Host "   Trava ilegível: $lockPath" }
} else {
  Write-Host '   Nenhuma.'
}

Write-Host ''
Write-Host '== Último log do agendador'
$lastLog = Get-ChildItem -LiteralPath $schedulerLogDir -Filter '*.log' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike '*.test.log' } | Sort-Object LastWriteTime | Select-Object -Last 1
if ($lastLog) {
  $summary = Get-Content -LiteralPath $lastLog.FullName -Encoding UTF8 |
    Where-Object { $_ -match '\[scheduler\] \w+ (OK em|Trava de qualidade|FALHA|TIMEOUT|Execução anterior|Pipeline já rodando|Erro no wrapper)' } |
    Select-Object -Last 1
  Write-Host "   $($lastLog.FullName)"
  Write-Host "   $(if ($summary) { $summary } else { '(nenhum resultado registrado ainda)' })"
} else {
  Write-Host '   Nenhum ainda.'
}

Write-Host ''
Write-Host "== Últimos $AlertCount alertas (data\alerts.jsonl)"
if (Test-Path -LiteralPath $alertsPath) {
  $alerts = @(Get-Content -LiteralPath $alertsPath -Encoding UTF8 | Where-Object { $_.Trim() } | Select-Object -Last $AlertCount)
  if ($alerts.Count -eq 0) { Write-Host '   Nenhum.' }
  foreach ($line in $alerts) {
    try {
      $alert = $line | ConvertFrom-Json
      $run = if ($alert.PSObject.Properties['runId'] -and $alert.runId) { " run $($alert.runId)" } else { '' }
      $test = if ($alert.PSObject.Properties['test'] -and $alert.test) { ' [TESTE]' } else { '' }
      Write-Host "   $(Format-Date $alert.timestamp) [$($alert.kind)]$test$run"
      Write-Host "      $($alert.message)"
    } catch { Write-Host "   (linha ilegível) $line" }
  }
} else {
  Write-Host '   Nenhum.'
}
