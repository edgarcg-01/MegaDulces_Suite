<#
  Barre procesos node HUÉRFANOS de una corrida previa del runner de feeds.

  Contexto (incidente 2026-08-05): un run intradía se colgó en un ECONNRESET contra
  prod y dejó 2 procesos node vivos a 0% CPU por 3 días; con la política IgnoreNew del
  Task Scheduler, bloquearon todas las corridas siguientes del feed (no volvió a avanzar).

  Este script mata SOLO los procesos node que:
    - corren uno de los scripts pasados en -Names (los del modo actual del runner), y
    - llevan más de -MaxAgeMin minutos vivos (→ colgados; un run sano termina en minutos),
    - excluyendo -SelfPid (el propio orquestador).
  El umbral de edad protege una corrida CONCURRENTE legítima de otro modo (que es joven):
  ej. \Kepler\Stock y \Live comparten import-replenishment-plan.js.

  Uso (lo invoca run-prod-feeds.js con spawnSync, sin shell):
    powershell -NoProfile -ExecutionPolicy Bypass -File kill-stale-feeds.ps1 `
      -Names "import-sales-fact.js,import-demand-clean.js" -MaxAgeMin 13 -SelfPid 1234
#>
param(
  [string]$Names = '',
  [int]$MaxAgeMin = 13,
  [int]$SelfPid = 0
)
$ErrorActionPreference = 'SilentlyContinue'
$list = $Names.Split(',') | Where-Object { $_ } | ForEach-Object { [regex]::Escape($_.Trim()) }
if (-not $list) { exit 0 }
$re = '(' + ($list -join '|') + ')'

Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.ProcessId -ne $SelfPid -and $_.CommandLine -match $re
} | ForEach-Object {
  $age = ((Get-Date) - $_.CreationDate).TotalMinutes
  if ($age -gt $MaxAgeMin) {
    $scr = if ($_.CommandLine -match '([\w-]+\.js)') { $matches[1] } else { '?' }
    Write-Output ("stale-kill PID {0} ({1}, {2} min colgado)" -f $_.ProcessId, $scr, [math]::Round($age))
    Stop-Process -Id $_.ProcessId -Force
  }
}
