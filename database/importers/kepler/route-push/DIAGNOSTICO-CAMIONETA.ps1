# =============================================================================
#  [RD.32] Diagnostico de una camioneta. Se pega tal cual. SOLO LEE: no toca nada.
#  NUNCA imprime contrasenas: las cadenas de conexion salen enmascaradas.
# =============================================================================
# ⛔ NADA de param(): esto se PEGA en una consola, y ahi param() solo vale como
#    primera instruccion de un script. Pegado revienta y deja $f sin definir.
if (-not $f) { $f = 'C:\KeplerPush\push-ruta.cmd' }
$ErrorActionPreference = 'Continue'
# ⛔ DOS formas de cadena, y la segunda ya se escapo una vez (2026-10-06, ruta_22):
#    URI  -> postgresql://usuario:clave@host/db
#    DSN  -> host=... user=... password=... connect_timeout=...
#    Enmascarar solo la primera deja la clave en pantalla en los agentes que usan
#    la segunda, que son justo los que no conociamos. Se cubren las dos, y la del
#    DSN con \S+ para no comerse el parametro siguiente.
function Mask($s) {
  if (-not $s) { return '(vacio)' }
  return ($s -replace '://[^@]*@', '://***@' -replace '(?i)(password\s*=\s*)\S+', '${1}***')
}

if (-not (Test-Path $f)) { Write-Host "ERROR: no existe $f" -f Red; return }
$t = Get-Content $f -Raw -Encoding Default
$tr = [regex]::Match($t, '(?im)^\s*set\s+TRUCK\s*=\s*(\S+)').Groups[1].Value
Write-Host "`n=== $f ===" -f Cyan
Write-Host ("  TRUCK            : " + $(if ($tr) { $tr } else { 'NO ENCONTRADO' }))
Write-Host ("  parchado         : " + ($t -match 'route_stock_stg'))
Write-Host ("  veces que aparece: " + ([regex]::Matches($t, 'route_stock_stg')).Count + "  (1 = bien)")

Write-Host "`n--- las lineas 'set' del agente (enmascaradas) ---" -f Cyan
([regex]::Matches($t, '(?im)^\s*set\s+\w+\s*=.*$')) | ForEach-Object {
  Write-Host ("  " + (Mask $_.Value.Trim()))
}

Write-Host "`n--- donde esta psql de verdad ---" -f Cyan
$cands = @()
foreach ($r in @('C:\Program Files\PostgreSQL', 'C:\Program Files (x86)\PostgreSQL')) {
  if (Test-Path $r) { $cands += (Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } | Where-Object { Test-Path $_ }) }
}
$cmdPath = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source
if ($cmdPath) { $cands += $cmdPath }
if ($cands.Count -eq 0) { Write-Host '  NO SE ENCONTRO psql.exe en las rutas conocidas' -f Red }
else { $cands | Select-Object -Unique | ForEach-Object { Write-Host "  $_" -f Green } }

Write-Host "`n--- el Kepler local: existe md.kdik? cuanto trae? ---" -f Cyan
$psql = ($cands | Select-Object -Unique | Select-Object -First 1)
$src  = [regex]::Match($t, '(?im)^\s*set\s+SRC\s*=\s*(.+?)\s*$').Groups[1].Value
if (-not $psql) { Write-Host '  (sin psql no se puede preguntar)' -f Yellow }
elseif (-not $src) { Write-Host '  (no encontre la linea set SRC=)' -f Yellow }
else {
  Write-Host ("  usando SRC = " + (Mask $src)) -f DarkGray
  $r1 = (& $psql $src -tAc "select to_regclass('md.kdik')::text || ' | ' || to_regclass('md.kdii')::text" 2>&1) -join ' '
  Write-Host "  tablas           : $r1"
  $r2 = (& $psql $src -tAc "select count(*)::text || ' productos | ' || coalesce(to_char(sum(k.c5*k.c16),'FM999,999,990.00'),'?') from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0" 2>&1) -join ' '
  Write-Host "  EXISTENCIA LOCAL : $r2" -f White
}

Write-Host "`n--- ultimas lineas del log que importan ---" -f Cyan
$log = Join-Path (Split-Path $f) ("push_" + $tr + ".log")
if (-not (Test-Path $log)) { Write-Host "  no hay log: $log" -f Yellow }
else {
  Get-Content $log -Tail 60 |
    Select-String -Pattern 'existencia|ERROR|error|OFFLINE|ONLINE|no existe|denied|FATAL|merge' |
    Select-Object -Last 15 | ForEach-Object { Write-Host ("  " + (Mask $_.ToString().Trim())) }
}
Write-Host ""
