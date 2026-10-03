<#
.SYNOPSIS
  Remove a tarefa "Maquina de Shorts" do Agendador de Tarefas. Idempotente (não existe = nada a fazer).
  Não apaga logs nem alertas. Uma execução em andamento é interrompida antes (Stop-ScheduledTask).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\unregister_task.ps1 -DryRun
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = 'Maquina de Shorts',
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Tarefa '$TaskName' não está registrada: nada a fazer."
  exit 0
}
if ($DryRun -or $WhatIfPreference) {
  Write-Host "DRY RUN: removeria '$($task.TaskPath)$TaskName' (estado atual: $($task.State))."
  exit 0
}
if ($task.State -eq 'Running') {
  Write-Host 'Execução em andamento: interrompendo.'
  Stop-ScheduledTask -TaskName $TaskName
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Tarefa '$TaskName' removida. Logs (logs\scheduler) e alertas (data\alerts.jsonl) foram mantidos."
