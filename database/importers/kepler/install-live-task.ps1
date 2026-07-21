<#
  Instala la tarea programada "Live" — feed intradía de VENTA → prod (Command Center).
  Corre `run-prod-feeds.js live` (import-sales-fact con SALES_FACT_DAYS=2 + import-sales-stats),
  todo por UPSERT (no borra filas). Cadencia horario comercial, settings resilientes.

  Requiere: correr COMO ADMIN en el runner on-prem (.249) con Docker/VPN de sesión arriba.
  El env SALES_FACT_DAYS=2 lo setea run-feeds.cmd cuando el modo es "live".

  powershell -ExecutionPolicy Bypass -File install-live-task.ps1
#>
param(
  [string]$RunUser  = "SISTEMAS\Desarrollo MD",
  [string]$StartAt  = "07:00",
  [int]   $EveryMinutes = 30,
  [int]   $WindowHours  = 15,       # 07:00 + 15h = ~22:00
  [string]$TaskName = "Live"
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path "C:\KeplerRunner\run-hidden.vbs")) { throw "Falta C:\KeplerRunner\run-hidden.vbs" }

$act = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\KeplerRunner\run-hidden.vbs" live'
$trg = New-ScheduledTaskTrigger -Daily -At $StartAt
$trg.Repetition = (New-ScheduledTaskTrigger -Once -At $StartAt `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
  -RepetitionDuration (New-TimeSpan -Hours $WindowHours)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
  -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $RunUser -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $settings -Principal $principal -Force | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
$i = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Tarea '$TaskName' registrada."
Write-Host ("  repeticion: cada {0} por {1}" -f $t.Triggers[0].Repetition.Interval, $t.Triggers[0].Repetition.Duration)
Write-Host ("  StartWhenAvailable={0} · MultipleInstances={1}" -f $t.Settings.StartWhenAvailable, $t.Settings.MultipleInstances)
Write-Host ("  next run: {0}" -f $i.NextRunTime)
