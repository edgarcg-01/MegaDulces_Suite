<#
  ⛔⛔ RETIRADO 2026-09-23 [NORM.3] — NO CORRER ESTE SCRIPT. ⛔⛔

  El carril `live` NO vive en el Programador de Windows desde [VL.4] (2026-09-11): vive en
  `ops/vl/crontab.feeds`, dentro del contenedor `feeds-cron` del servidor `md` (192.168.0.222).
  Su tarea en `.249` quedó DESHABILITADA, no borrada.

  Correr este instalador reinstala esa tarea y crea un SEGUNDO emisor del mismo carril contra la
  misma base de prod. Y no es teórico: hasta hoy la llave de latido `kepler_sales_fact` la
  escribían dos carriles a la vez, y la PK de `analytics.cron_runs` es `(tenant_id, job_key)` SIN
  host — se pisaban el renglón, lo que fabricó **304 errores falsos en 7 días** ("la corrida
  anterior no reportó cierre") y, al revés, dejaba que un carril muerto se viera verde porque el
  otro repintaba la llave. Un tercer emisor repite exactamente eso.

  Además el script está DESACTUALIZADO respecto de lo que hace hoy el carril: [NORM.3] le sacó
  `import-sales-fact` e `import-cash-sessions` (los corre `livefast` cada 60 s).

  Si hay que cambiar la agenda del carril `live`, se cambia en `ops/vl/crontab.feeds` y se
  despliega con `ops/vl/deploy.sh`. Se conserva el archivo como documentación de cómo estaba
  configurada la tarea original (cadencia, ventana, settings), no como herramienta.

  ── texto original ──────────────────────────────────────────────────────────────────────────
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
