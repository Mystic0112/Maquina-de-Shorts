<#
.SYNOPSIS
  Cria ou atualiza a tarefa "Maquina de Shorts" no Agendador de Tarefas do Windows.

.DESCRIPTION
  A tarefa roda scheduler/run_once.ps1 (powershell.exe -NoProfile -ExecutionPolicy Bypass) nos horários
  de -Times, com atraso aleatório, acordando o PC, só com rede, recuperando execuções perdidas
  (StartWhenAvailable), sem instância paralela e com limite de 90 min. Idempotente: rodar de novo atualiza.

  -DryRun (ou -WhatIf) monta exatamente os mesmos objetos e mostra o que seria registrado, sem registrar.

.PARAMETER LogonType
  Interactive (padrão): roda só com o usuário logado; nenhuma senha é guardada; o toast aparece.
  S4U:      roda logado ou não, sem guardar senha; sem acesso a compartilhamentos de rede/EFS e sem toast.
            Pode exigir PowerShell como administrador.
  Password: roda logado ou não; pede a senha do Windows (guardada pelo próprio Windows); sem toast.
            Exige PowerShell como administrador.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\register_task.ps1 -DryRun
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\register_task.ps1 -Times 08:30,20:00 -RandomDelayMinutes 10
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'Maquina de Shorts',
  [ValidatePattern('^([01]?\d|2[0-3]):[0-5]\d$')][string[]]$Times = @('09:00', '18:00'),
  [ValidateRange(0, 720)][int]$RandomDelayMinutes = 20,
  [ValidateRange(1, 1440)][double]$PipelineTimeoutMinutes = 60,
  [ValidateRange(1, 1440)][int]$ExecutionLimitMinutes = 90,
  [ValidateSet('Interactive', 'S4U', 'Password')][string]$LogonType = 'Interactive',
  [switch]$RequireAC,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isDryRun = $DryRun -or $WhatIfPreference
$repoRoot = Split-Path -Parent $PSScriptRoot
$runOnce = Join-Path $PSScriptRoot 'run_once.ps1'
if (-not (Test-Path -LiteralPath $runOnce)) { throw "run_once.ps1 não encontrado em $PSScriptRoot" }
if ($ExecutionLimitMinutes -le $PipelineTimeoutMinutes) {
  throw "ExecutionLimitMinutes ($ExecutionLimitMinutes) precisa ser maior que PipelineTimeoutMinutes ($PipelineTimeoutMinutes): o wrapper deve encerrar o pipeline antes do Agendador matar o wrapper."
}

$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$timeoutArg = $PipelineTimeoutMinutes.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -TimeoutMinutes {1}' -f $runOnce, $timeoutArg
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $arguments -WorkingDirectory $repoRoot

$triggers = foreach ($time in $Times) {
  $at = [datetime]::ParseExact($time.PadLeft(5, '0'), 'HH:mm', [System.Globalization.CultureInfo]::InvariantCulture)
  # Horário já passou hoje: começa amanhã (evita uma execução de "recuperação" logo ao registrar).
  if ($at -lt (Get-Date)) { $at = $at.AddDays(1) }
  $trigger = if ($RandomDelayMinutes -gt 0) {
    New-ScheduledTaskTrigger -Daily -At $at -RandomDelay (New-TimeSpan -Minutes $RandomDelayMinutes)
  } else {
    New-ScheduledTaskTrigger -Daily -At $at
  }
  # Hora local de parede (sem fuso/UTC): 09:00 continua 09:00 se o fuso ou horário de verão mudar.
  $trigger.StartBoundary = $at.ToString('yyyy-MM-ddTHH:mm:ss')
  $trigger
}

$settingsArgs = @{
  WakeToRun                 = $true
  RunOnlyIfNetworkAvailable = $true
  StartWhenAvailable        = $true
  MultipleInstances         = 'IgnoreNew'
  ExecutionTimeLimit        = (New-TimeSpan -Minutes $ExecutionLimitMinutes)
}
if (-not $RequireAC) {
  # Notebook: roda também na bateria (o padrão do Windows seria não iniciar / parar ao desconectar).
  $settingsArgs.AllowStartIfOnBatteries = $true
  $settingsArgs.DontStopIfGoingOnBatteries = $true
}
$settings = New-ScheduledTaskSettingsSet @settingsArgs

$userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $LogonType -RunLevel Limited

$description = "Máquina de Shorts: uma execução desassistida do pipeline (scheduler\run_once.ps1). Logs em logs\scheduler, alertas em data\alerts.jsonl. Criada por scheduler\register_task.ps1."
$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description $description

function Show-Plan {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "Tarefa:       $TaskName ($(if ($existing) { 'já existe: seria ATUALIZADA' } else { 'nova: seria CRIADA' }))"
  Write-Host "Descrição:    $description"
  Write-Host "Ação:         $($action.Execute)"
  Write-Host "Argumentos:   $($action.Arguments)"
  Write-Host "Pasta:        $($action.WorkingDirectory)"
  Write-Host "Usuário:      $($principal.UserId) (LogonType $($principal.LogonType), RunLevel $($principal.RunLevel))"
  foreach ($trigger in $task.Triggers) {
    $delay = if ($trigger.RandomDelay) { $trigger.RandomDelay } else { 'nenhum' }
    Write-Host ("Gatilho:      diário às {0:HH:mm} (hora local; primeiro em {1}), atraso aleatório {2}, a cada {3} dia(s)" -f ([datetime]$trigger.StartBoundary), $trigger.StartBoundary, $delay, $trigger.DaysInterval)
  }
  $s = $task.Settings
  Write-Host "Configuração: WakeToRun=$($s.WakeToRun) RunOnlyIfNetworkAvailable=$($s.RunOnlyIfNetworkAvailable) StartWhenAvailable=$($s.StartWhenAvailable)"
  Write-Host "              MultipleInstances=$($s.MultipleInstances) ExecutionTimeLimit=$($s.ExecutionTimeLimit) Priority=$($s.Priority)"
  Write-Host "              DisallowStartIfOnBatteries=$($s.DisallowStartIfOnBatteries) StopIfGoingOnBatteries=$($s.StopIfGoingOnBatteries)"
  Write-Host ''
}

Show-Plan
if ($isDryRun) {
  Write-Host 'DRY RUN: nada foi registrado.'
  exit 0
}

$registerArgs = @{ TaskName = $TaskName; InputObject = $task; Force = $true }
if ($LogonType -eq 'Password') {
  $credential = Get-Credential -UserName $userId -Message "Senha do Windows para a tarefa '$TaskName' rodar com você deslogado"
  $registerArgs.User = $credential.UserName
  $registerArgs.Password = $credential.GetNetworkCredential().Password
}
Register-ScheduledTask @registerArgs | Out-Null
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Tarefa '$TaskName' registrada. Próxima execução: $($info.NextRunTime)"
Write-Host "Testar agora:  Start-ScheduledTask -TaskName '$TaskName'   |   Status: scheduler\status.ps1"
