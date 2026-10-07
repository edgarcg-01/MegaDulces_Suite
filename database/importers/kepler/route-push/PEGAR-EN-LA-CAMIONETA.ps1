# =============================================================================
#  [RD.32] TODO EN UNO. Se pega tal cual en una consola PowerShell de la camioneta.
#
#  Hace, en orden:  parcha -> dispara la tarea -> lee el log -> le PREGUNTA al
#  Kepler de esta laptop cuanto trae, que es el numero con el que se compara.
#
#  No pide datos: el TRUCK, el psql y las credenciales salen del propio agente.
#  Correrlo dos veces no duplica nada.
# =============================================================================
# ⛔ NADA de param() aca: esto se PEGA en una consola interactiva, y ahi param()
#    solo es valido como primera instruccion de un script -- al pegarlo revienta
#    y las lineas siguientes corren igual, con $f sin definir. Medido en la
#    ruta_22 el 2026-10-06: el paso [4] dijo "psql o SRC no encontrados" porque
#    las variables nunca se llenaron. Una asignacion simple se comporta igual
#    pegada que ejecutada como archivo.
if (-not $f) { $f = 'C:\KeplerPush\push-ruta.cmd' }
$ErrorActionPreference = 'Continue'
if (-not (Test-Path $f)) { Write-Host "ERROR: no existe $f" -f Red; return }
$t = Get-Content $f -Raw -Encoding Default
$k = [regex]::Match($t, '(?im)^\s*set\s+TRUCK\s*=\s*(\S+)')
if (-not $k.Success) { Write-Host 'ERROR: este archivo no es el agente de una camioneta' -f Red; return }
$tr = $k.Groups[1].Value
Write-Host "`n=== $tr ===" -f Cyan

# ---- 1. Parchar (idempotente) -----------------------------------------------
if ($t -match 'route_stock_stg') {
  Write-Host "  [1] ya estaba parchado" -f Yellow
} else {
  $bak = "$f.bak." + (Get-Date -f 'yyyyMMdd-HHmmss'); Copy-Item $f $bak -Force
  $b = @(
   ''
   'REM ==========================================================================='
   'REM  [RD.32] LA EXISTENCIA DEL CAMION. Mismo canal, una consulta mas.'
   'REM  kdii.c1=sku c2=descripcion c11=unidad | kdik.c2=sku c5=existencia c16=costo'
   'REM  OJO: existencia > 0, y es una FOTO (el merge del runner REEMPLAZA la del dia).'
   'REM ==========================================================================='
   '%PSQL% "%DST%" -c "delete from ingest.route_stock_stg where truck=''%TRUCK%''" >> "%LOG%" 2>&1'
   ''
   '%PSQL% "%SRC%" -c "\copy (select ''%TRUCK%'',btrim(k.c2),btrim(i.c2),btrim(i.c11),k.c5::numeric,k.c16::numeric,(k.c5*k.c16)::numeric from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0) to stdout csv" | %PSQL% "%DST%" -c "\copy ingest.route_stock_stg (truck,sku,producto,unidad,existencia,costo,importe) from stdin csv" >> "%LOG%" 2>&1'
   ''
   'echo [%date% %time%] merge existencia -^> filas: >> "%LOG%"'
   '%PSQL% "%DST%" -c "select ingest.merge_route_stock(''%TRUCK%'')" >> "%LOG%" 2>&1'
   ''
  ) -join "`r`n"
  $m = [regex]::Matches($t, '(?im)^echo\s+\[%date%\s+%time%\]\s+OK\s+%TRUCK%.*$')
  if ($m.Count -eq 0) { $m = [regex]::Matches($t, '(?im)^endlocal\s*$') }
  if ($m.Count -eq 0) { Write-Host '  ERROR: no encuentro donde insertar. Parar y revisar a mano.' -f Red; return }
  $p = $m[$m.Count - 1].Index
  Set-Content $f -Value ($t.Substring(0,$p) + $b + $t.Substring($p)) -Encoding Default -NoNewline
  $c = Get-Content $f -Raw -Encoding Default
  if (($c -match 'route_stock_stg') -and ($c -match 'merge_route_sales') -and ($c -match "set TRUCK=$tr")) {
    Write-Host "  [1] PARCHADO  (respaldo: $(Split-Path $bak -Leaf))" -f Green
  } else {
    Copy-Item $bak $f -Force
    Write-Host '  [1] FALLO la verificacion: se restauro el respaldo, el agente quedo como estaba.' -f Red
    return
  }
}

# ---- 2. Disparar la tarea ---------------------------------------------------
# OJO: 'schtasks /Query /TN "Ruta*"' NO funciona -- /TN no acepta comodines y el
# error se lee como si la tarea no existiera. Por eso se consulta en lista.
$tarea = 'Ruta' + ($tr -replace '^ruta_','')
if (schtasks /Query /FO LIST 2>$null | Select-String -SimpleMatch $tarea) {
  schtasks /Run /TN $tarea | Out-Null
  Write-Host "  [2] tarea '$tarea' disparada, esperando 40 s ..." -f Cyan
  Start-Sleep -Seconds 40
} else {
  Write-Host "  [2] OJO: no veo la tarea '$tarea'. Las que tienen 'Ruta' en el nombre:" -f Yellow
  schtasks /Query /FO LIST 2>$null | Select-String -SimpleMatch 'Ruta' | ForEach-Object { Write-Host "      $_" }
}

# ---- 3. El log --------------------------------------------------------------
$log = Join-Path (Split-Path $f) "push_$tr.log"
if (Test-Path $log) {
  $ult = Get-Content $log -Tail 30
  $linea = ($ult | Select-String 'merge existencia' -Context 0,2 | Select-Object -Last 1)
  if ($linea) { Write-Host "  [3] el agente corrio el paso de existencia:" -f Green; $linea.ToString().Split("`n") | ForEach-Object { Write-Host "      $($_.Trim())" } }
  else { Write-Host "  [3] todavia no aparece 'merge existencia' en el log (esperar el proximo ciclo de 15 min)" -f Yellow }
  if ($ult -match 'OFFLINE') { Write-Host "      OJO: el log dice OFFLINE -- el runner no contesta desde aqui" -f Red }
} else { Write-Host "  [3] no hay log todavia: $log" -f Yellow }

# ---- 4. El numero con el que se compara, preguntado a ESTA laptop ------------
# El agente ya trae el psql y la cadena local: se reusan en vez de pedirlos.
# Se BUSCA psql donde este, no en una lista de versiones: el agente mira 14..18 y
# si manana hay una 19 la lista queda vieja sin que nadie se entere.
$psql = @()
foreach ($r in @('C:\Program Files\PostgreSQL','C:\Program Files (x86)\PostgreSQL')) {
  if (Test-Path $r) { $psql += (Get-ChildItem $r -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } | Where-Object { Test-Path $_ }) }
}
if (-not $psql) { $psql = @((Get-Command psql.exe -ErrorAction SilentlyContinue).Source) }
$psql = $psql | Where-Object { $_ } | Select-Object -First 1
# `(.+?)\s*$` y no `(\S+)`: una cadena con espacios o entre comillas se cortaria.
$src  = [regex]::Match($t, '(?im)^\s*set\s+SRC\s*=\s*(.+?)\s*$').Groups[1].Value
if ($psql -and $src) {
  $q = "select count(*)::text || ' productos | ' || to_char(sum(k.c5*k.c16),'FM999,999,990.00') from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0"
  $r = (& $psql $src -tAc $q 2>&1) -join ' '
  # Un error NO puede leerse como un dato: si la respuesta no tiene la forma
  # esperada, se declara el fallo en vez de imprimirlo como si fuera el total.
  if ($r -match '^\s*\d[\d,]*\s+productos') {
    Write-Host "`n  [4] EL KEPLER DE ESTA LAPTOP DICE:  $r" -f White
    Write-Host "      Ese es el numero que tiene que llegar al runner." -f Gray
  } else {
    Write-Host "`n  [4] NO SE PUDO preguntarle al Kepler local. Respuesta:" -f Yellow
    Write-Host "      $r" -f DarkYellow
    Write-Host "      (el total hay que sacarlo a mano antes de dar por buena la foto)" -f Yellow
  }
} else {
  Write-Host "`n  [4] no pude preguntarle al Kepler local (psql o SRC no encontrados)" -f Yellow
}

Write-Host "`n  Verificar desde analitica:" -f Cyan
Write-Host "     node database/scripts/check-route-stock-push.js --truck $tr`n"
