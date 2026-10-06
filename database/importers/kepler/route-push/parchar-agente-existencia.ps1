# =============================================================================
#  [RD.32.3] Parcha el agente de UNA camioneta para que ademas mande su EXISTENCIA.
#
#  Se copia a la laptop (USB, VNC, carpeta compartida) y se corre ahi:
#
#      powershell -ExecutionPolicy Bypass -File .\parchar-agente-existencia.ps1
#      powershell -ExecutionPolicy Bypass -File .\parchar-agente-existencia.ps1 -Correr
#
#  No pide datos: lee el TRUCK del propio archivo. No hay nada que teclear, que es
#  justo el punto -- el pegado a mano en once laptops son once oportunidades de
#  equivocarse, y el error no se ve hasta que alguien mira un numero raro.
#
#  ── Lo que hace, en orden ───────────────────────────────────────────────────
#   1. Encuentra C:\KeplerPush\push-ruta.cmd y lee que camioneta es.
#   2. Si YA esta parchado, se detiene y lo dice. Correrlo dos veces no duplica.
#   3. Respalda con fecha antes de tocar nada.
#   4. Inserta el bloque ANTES de la ultima linea 'echo ... OK'.
#   5. Verifica que el archivo quedo bien ANTES de dar por buena la operacion.
#   6. Con -Correr: dispara la tarea y muestra el final del log.
#
#  ⚠️ El bloque usa SOLO variables que el archivo ya define (%PSQL% %SRC% %DST%
#     %TRUCK% %LOG%). Verificado contra las dos plantillas: v1 y v2 definen las
#     mismas cinco. Por eso es identico en las once y no hay nada que configurar.
# =============================================================================
[CmdletBinding()]
param(
  [string] $Archivo = 'C:\KeplerPush\push-ruta.cmd',
  [switch] $Correr,
  [switch] $Revertir
)

$ErrorActionPreference = 'Stop'
function Di($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }

# El bloque. ASCII puro a proposito: el resto del .cmd lo es, y un caracter raro
# en un archivo que corre en once maquinas con codepages distintas es un riesgo
# que no compra nada.
$BLOQUE = @'

REM ===========================================================================
REM  [RD.32] LA EXISTENCIA DEL CAMION. Mismo canal, una consulta mas.
REM  Kepler central no publica saldo de ruta y no hay documento de retorno, asi
REM  que el inventario se venia RECONSTRUYENDO. El Kepler de esta laptop si lo
REM  sabe. Columnas verificadas contra el ODS: kdii.c1=sku c2=descripcion
REM  c11=unidad, kdik.c2=sku c5=existencia c16=costo.
REM  OJO: existencia > 0 (el catalogo trae miles en cero). Es una FOTO, no lleva
REM  ventana de dias: el merge del runner REEMPLAZA la del dia.
REM ===========================================================================
%PSQL% "%DST%" -c "delete from ingest.route_stock_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

%PSQL% "%SRC%" -c "\copy (select '%TRUCK%',btrim(k.c2),btrim(i.c2),btrim(i.c11),k.c5::numeric,k.c16::numeric,(k.c5*k.c16)::numeric from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0) to stdout csv" | %PSQL% "%DST%" -c "\copy ingest.route_stock_stg (truck,sku,producto,unidad,existencia,costo,importe) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge existencia -^> filas: >> "%LOG%"
%PSQL% "%DST%" -c "select ingest.merge_route_stock('%TRUCK%')" >> "%LOG%" 2>&1

'@

$MARCA = 'ingest.route_stock_stg'

Di "`n[RD.32.3] Parche de existencia para el agente de ruta" 'Cyan'
Di   "-----------------------------------------------------"

# ── 1. El archivo ────────────────────────────────────────────────────────────
if (-not (Test-Path $Archivo)) {
  Di "ERROR: no existe $Archivo" 'Red'
  Di "       Si el agente vive en otro lado: -Archivo <ruta>" 'Yellow'
  exit 1
}
# ANSI de ida y de vuelta: un .cmd reescrito en UTF-8 puede romper el interprete.
$txt = Get-Content -LiteralPath $Archivo -Raw -Encoding Default

$m = [regex]::Match($txt, '(?im)^\s*set\s+TRUCK\s*=\s*(\S+)')
if (-not $m.Success) {
  Di "ERROR: el archivo no declara TRUCK. No parece el agente de una camioneta." 'Red'
  exit 1
}
$truck = $m.Groups[1].Value
Di "  camioneta : $truck" 'White'
Di "  archivo   : $Archivo"

# ── Revertir (por si algo sale mal y hay que volver rapido) ──────────────────
if ($Revertir) {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Archivo)
  $bak = Get-ChildItem -LiteralPath (Split-Path $Archivo) -Filter "$base.bak.*.cmd" |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $bak) { Di "ERROR: no hay respaldo que restaurar." 'Red'; exit 1 }
  Copy-Item -LiteralPath $bak.FullName -Destination $Archivo -Force
  Di "  RESTAURADO desde $($bak.Name)" 'Yellow'
  exit 0
}

# ── 2. Idempotencia ──────────────────────────────────────────────────────────
if ($txt -match [regex]::Escape($MARCA)) {
  Di "`n  YA ESTABA PARCHADO. No se toca nada." 'Yellow'
  Di "  (correrlo de nuevo no duplica el bloque; eso es a proposito)"
  if (-not $Correr) { exit 0 }
} else {
  # ── 3. Respaldo ────────────────────────────────────────────────────────────
  # El respaldo se nombra a partir del archivo REAL y del camion, no de un
  # "push-ruta" fijo: si alguien corre esto sobre otro archivo o guarda dos
  # agentes en la misma carpeta, un nombre fijo pisa el respaldo del otro.
  $sello = Get-Date -Format 'yyyyMMdd-HHmmss'
  $base = [System.IO.Path]::GetFileNameWithoutExtension($Archivo)
  $bak = Join-Path (Split-Path $Archivo) "$base.bak.$truck.$sello.cmd"
  Copy-Item -LiteralPath $Archivo -Destination $bak -Force
  Di "  respaldo  : $(Split-Path $bak -Leaf)" 'DarkGray'

  # ── 4. Insertar ANTES de la ultima linea 'echo ... OK' ─────────────────────
  # Se busca la ULTIMA, no la primera: si alguien ya agrego pasos propios, el
  # bloque tiene que quedar despues de ellos y antes del cierre.
  $anclas = [regex]::Matches($txt, '(?im)^echo\s+\[%date%\s+%time%\]\s+OK\s+%TRUCK%.*$')
  if ($anclas.Count -eq 0) {
    # Plan B: antes del endlocal. Si tampoco esta, se para -- adivinar donde va
    # un bloque que corre en produccion no es una opcion.
    $anclas = [regex]::Matches($txt, '(?im)^endlocal\s*$')
    if ($anclas.Count -eq 0) {
      Di "ERROR: no encuentro donde insertar (ni 'echo ... OK' ni 'endlocal')." 'Red'
      Di "       El archivo no tiene la forma esperada. Parar y revisar a mano." 'Yellow'
      exit 1
    }
    Di "  OJO: no habia linea 'echo ... OK'; se inserta antes de 'endlocal'." 'Yellow'
  }
  $pos = $anclas[$anclas.Count - 1].Index
  $nuevo = $txt.Substring(0, $pos) + $BLOQUE.Replace("`n", "`r`n") + $txt.Substring($pos)
  Set-Content -LiteralPath $Archivo -Value $nuevo -Encoding Default -NoNewline

  # ── 5. Verificar lo escrito, no suponerlo ──────────────────────────────────
  $check = Get-Content -LiteralPath $Archivo -Raw -Encoding Default
  $errores = @()
  if ($check -notmatch [regex]::Escape($MARCA))            { $errores += 'el bloque no quedo escrito' }
  if (([regex]::Matches($check, [regex]::Escape($MARCA))).Count -ne 2) { $errores += 'el bloque quedo duplicado o incompleto' }
  if ($check -notmatch 'merge_route_sales')                 { $errores += 'se perdio el push de VENTA' }
  if ($check -notmatch [regex]::Escape("set TRUCK=$truck")) { $errores += 'se perdio el TRUCK' }
  if ($errores.Count) {
    Copy-Item -LiteralPath $bak -Destination $Archivo -Force
    Di "`n  FALLO la verificacion: $($errores -join ' | ')" 'Red'
    Di "  Se restauro el respaldo. El agente quedo como estaba." 'Yellow'
    exit 1
  }
  Di "`n  PARCHADO y verificado." 'Green'
}

# ── 6. Correr ────────────────────────────────────────────────────────────────
if ($Correr) {
  $tarea = 'Ruta' + ($truck -replace '^ruta_', '')
  Di "`n  disparando la tarea '$tarea' ..." 'Cyan'
  # OJO: 'schtasks /Query /TN "Ruta*"' NO funciona -- /TN no acepta comodines y
  # el error se lee como si la tarea no existiera. Por eso se consulta en lista.
  $existe = (schtasks /Query /FO LIST 2>$null | Select-String -SimpleMatch $tarea)
  if (-not $existe) {
    Di "  OJO: no veo una tarea llamada '$tarea'. Tareas con 'Ruta' en el nombre:" 'Yellow'
    schtasks /Query /FO LIST 2>$null | Select-String -SimpleMatch 'Ruta' | ForEach-Object { Di "    $_" }
    Di "  Correlo a mano o ajusta el nombre." 'Yellow'
  } else {
    schtasks /Run /TN $tarea | Out-Null
    Start-Sleep -Seconds 25
  }
  $log = "C:\KeplerPush\push_$truck.log"
  if (Test-Path $log) {
    Di "`n  ultimas lineas de $(Split-Path $log -Leaf):" 'Cyan'
    Get-Content -LiteralPath $log -Tail 12 | ForEach-Object { Di "    $_" }
    $ult = (Get-Content -LiteralPath $log -Tail 40) -join "`n"
    if ($ult -match 'merge existencia') { Di "`n  OK: el agente ya corrio el paso de existencia." 'Green' }
    else { Di "`n  OJO: todavia no aparece 'merge existencia' en el log. Esperar al proximo ciclo (15 min)." 'Yellow' }
  } else { Di "  (no hay log todavia: $log)" 'Yellow' }
}

Di "`n  Verificacion REMOTA (desde la maquina de analitica):" 'Cyan'
Di "    node database/scripts/check-route-stock-push.js --truck $truck"
Di ""
