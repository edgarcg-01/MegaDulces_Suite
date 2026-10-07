# ---------------------------------------------------------------------------
# register-backup-task.ps1 - Registra el respaldo diario en Task Scheduler.
#
# Ejecutar UNA vez como Administrador:
#   powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1
#
# Para desinstalar:
#   Unregister-ScheduledTask -TaskName 'TradeMarketing-DailyBackup' -Confirm:$false
# ---------------------------------------------------------------------------

param(
    [string]$TaskName = 'TradeMarketing-DailyBackup',
    [string]$RunAt    = '17:00'  # hora local diaria (5:00 PM)
)

$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'sync-from-prod.ps1'
if (-not (Test-Path $scriptPath)) {
    throw "No se encontro sync-from-prod.ps1 en $scriptPath"
}

# Si existe una version previa, la reemplazamos
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# LogonType S4U = "Run whether user is logged on or not" SIN almacenar
# contrasena. Funciona aunque la sesion este cerrada o la pantalla bloqueada.
# Para Postgres/Railway solo se necesita salida TCP a internet (no creds
# de Windows), asi que S4U es suficiente. Requiere permiso "Log on as a
# batch job" -- los usuarios locales lo tienen por defecto.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName    $TaskName `
    -Description 'Respaldo diario de Trade Marketing (Railway) + restore a BD local para consulta en pgAdmin.' `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Principal   $principal | Out-Null

Write-Host "Tarea '$TaskName' registrada. Corre diario a las $RunAt."
Write-Host "Para probar ahora: Start-ScheduledTask -TaskName '$TaskName'"
