<#
  Instala la tarea programada RESILIENTE del concentrador KP_CONCENTRADA.

  Correr COMO ADMINISTRADOR en el host que tenga:
    - Node instalado
    - el repo Trade_marketing clonado
    - ruta/VPN a las 6 sucursales Kepler (192.168.9/10/40/42/44/54) y a .245

  Modelo de resiliencia (responde "que siga aunque se apague/reinicie/cuelgue"):
    - Trigger diario + REPEAT cada N horas indefinidamente.
    - StartWhenAvailable = ejecuta lo antes posible una corrida PERDIDA (PC estuvo
      apagada/dormida a la hora del disparo -> la lanza al volver).
    - RestartCount/Interval = reintenta si la corrida falla (cuelgue puntual).
    - WakeToRun = despierta la PC si está dormida (NO si está apagada del todo).
    - Corre INTERACTIVE (usuario logueado) porque la VPN/Docker viven en la sesión.
      => Para sobrevivir a un reinicio, el host necesita AUTO-LOGIN + VPN/Docker en
         autostart + BIOS "Restore on AC Power Loss = Power On" (pasos manuales).

  Uso:
    powershell -ExecutionPolicy Bypass -File install-concentrate-task.ps1 `
      -RepoPath "C:\Users\Sistemas\CascadeProjects\Trade_marketing" `
      -RunUser  "MEGADULCES\Sistemas" `
      -EveryHours 4
#>
param(
  [string]$RepoPath   = "C:\Users\Sistemas\CascadeProjects\Trade_marketing",
  [string]$NodeExe    = "C:\Program Files\nodejs\node.exe",
  [string]$RunUser    = "$env:USERDOMAIN\$env:USERNAME",
  [string]$LogDir     = "C:\KeplerRunner\logs",
  [int]   $EveryHours = 4,
  [int]   $FirstRunDelayMinutes = 15,      # cuándo arranca la 1ra incremental (evita chocar con un full en curso)
  [string]$DailyFullAt = "03:30",          # una reconciliación --full por día
  [string]$TaskName   = "KP-Concentrate"
)

$ErrorActionPreference = "Stop"
$script = Join-Path $RepoPath "database\importers\kepler\concentrate-kepler.js"
if (-not (Test-Path $script))  { throw "No existe el script: $script" }
if (-not (Test-Path $NodeExe)) { throw "No existe node: $NodeExe" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# --- Runner .cmd (incremental por default; 'full' para la reconciliación diaria) ---
$runnerCmd = Join-Path $LogDir "..\run-concentrate.cmd"
$runnerCmd = [System.IO.Path]::GetFullPath($runnerCmd)
@"
@echo off
REM Runner del concentrador KP_CONCENTRADA. Uso: run-concentrate.cmd [full]
cd /d "$RepoPath"
set "MODE_FLAGS=--apply"
if /I "%~1"=="full" set "MODE_FLAGS=--apply --full"
echo ==== %DATE% %TIME% :: %MODE_FLAGS% ==== >> "$LogDir\concentrate.log"
"$NodeExe" database\importers\kepler\concentrate-kepler.js %MODE_FLAGS% >> "$LogDir\concentrate.log" 2>&1
"@ | Set-Content -Encoding ASCII $runnerCmd
Write-Host "Runner escrito: $runnerCmd"

# --- Lanzador VBS OCULTO (WindowStyle=0): evita que aparezca la consola en pantalla.
#     Mismo patrón que C:\KeplerRunner\run-hidden.vbs de los feeds de prod. ---
$hiddenVbs = Join-Path $LogDir "..\run-concentrate-hidden.vbs"
$hiddenVbs = [System.IO.Path]::GetFullPath($hiddenVbs)
@"
' Lanza run-concentrate.cmd SIN mostrar consola (WindowStyle=0, oculto).
' Interactive (VPN/Docker viven en la sesion del usuario) pero sin ventana visible.
Set sh = CreateObject("WScript.Shell")
mode = ""
If WScript.Arguments.Count > 0 Then mode = WScript.Arguments(0)
sh.Run "$runnerCmd " & mode, 0, True
"@ | Set-Content -Encoding ASCII $hiddenVbs
Write-Host "Lanzador oculto escrito: $hiddenVbs"

# --- Acciones: incremental cada N horas + full diario (via wscript OCULTO) ---
$actIncr = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$hiddenVbs`""
$actFull = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$hiddenVbs`" full"

# --- Triggers ---
$trgIncr = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($FirstRunDelayMinutes) `
             -RepetitionInterval (New-TimeSpan -Hours $EveryHours)
$trgFull = New-ScheduledTaskTrigger -Daily -At $DailyFullAt

# --- Settings resilientes ---
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

# INTERACTIVE (usuario logueado) -> la VPN/Docker de la sesión están disponibles.
$principal = New-ScheduledTaskPrincipal -UserId $RunUser -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName `
  -Action @($actIncr, $actFull) -Trigger @($trgIncr, $trgFull) `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Tarea '$TaskName' registrada: incremental cada $EveryHours h + --full diario $DailyFullAt."
Write-Host "Recordá (manual, para sobrevivir reinicios): auto-login + VPN/Docker autostart + BIOS Restore-on-AC."
