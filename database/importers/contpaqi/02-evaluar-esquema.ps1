<#
  Fase CP `[CP.8.4]` — EVALUACION DEL ESQUEMA DE IMPORTACION DE CONTPAQi.

  Read-only: no instala, no modifica, no abre el sistema, no toca la base. Lee archivos, los
  copia a una carpeta de salida y escribe un reporte.

  ───────────────────────────────────────────────────────────────────────────────────────────
  PARA QUE SIRVE
  ───────────────────────────────────────────────────────────────────────────────────────────
  ContPAQi no lee el TXT de polizas con un formato fijo: lo lee segun un ARCHIVO DE ESQUEMA que
  vive en la instalacion de la empresa. O sea que el formato es configuracion nuestra, no una
  ley de ContPAQi -- pero hay que mirar cual esta puesto.

  Hoy el puente tiene TRES anchos en disputa y UNA pregunta de capacidad. Cada uno corre todos
  los campos siguientes de su renglon, asi que no se degradan: a partir de ahi ContPAQi lee
  basura.

      clase (renglon P)        nuestro layout 1    fuentes externas 4
      referencia (renglon M)   nuestro layout 10   fuentes externas 30
      fecha de aplicacion (P)  no la tenemos       agregada en versiones recientes
      renglones "AD " + UUID   no los emitimos     dos fuentes dicen que el formato SI los lleva

  Lo ultimo es lo de mas valor: si el formato transporta el UUID, los 0 de 33,303 movimientos
  sin CFDI asociado en cinco anios no son una limitacion del formato -- son renglones que nadie
  emitio, y se cierran sin comprar nada.

  ───────────────────────────────────────────────────────────────────────────────────────────
  DONDE Y COMO CORRERLO
  ───────────────────────────────────────────────────────────────────────────────────────────
  En el servidor de ContPAQi (192.168.0.35) o en cualquier maquina que tenga ContPAQi instalado.

      powershell -ExecutionPolicy Bypass -File 02-evaluar-esquema.ps1

  Deja todo en  C:\contpaqi-evaluacion\  : el reporte y una COPIA de los archivos de esquema.
  Traer esa carpeta completa.

  ⚠️ No requiere administrador para leer. Si algo sale "ACCESO DENEGADO", volver a correrlo
  como administrador y comparar: la diferencia tambien es informacion.
#>

$ErrorActionPreference = 'Continue'
$SALIDA = 'C:\contpaqi-evaluacion'
$REPORTE = Join-Path $SALIDA 'reporte.txt'

if (-not (Test-Path $SALIDA)) { New-Item -ItemType Directory -Path $SALIDA -Force | Out-Null }
if (Test-Path $REPORTE) { Remove-Item $REPORTE -Force }

function Decir($t) { $t | Tee-Object -FilePath $REPORTE -Append }
function Seccion($t) { Decir ''; Decir "=== $t ===" }

Decir "Evaluacion del esquema de ContPAQi - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Decir "Maquina: $env:COMPUTERNAME   Usuario: $env:USERNAME"
Decir "Administrador: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

# --- 1. Donde viven los esquemas ---------------------------------------------------------------
Seccion '1. Carpetas de esquemas'
$CANDIDATAS = @(
  'C:\Compac\Empresas\Esquemas',
  'C:\Compac\Esquemas',
  'C:\Program Files (x86)\Compac\Esquemas',
  'C:\Archivos de programa\Compac\Esquemas'
)
$raices = @()
foreach ($c in $CANDIDATAS) {
  if (Test-Path $c) { $raices += $c; Decir "  ENCONTRADA: $c" }
}
if (-not $raices) {
  Decir '  NO SE ENCONTRO ninguna carpeta de esquemas en las rutas conocidas.'
  Decir '  Buscando en todo C:\Compac (puede tardar)...'
  if (Test-Path 'C:\Compac') {
    $hallados = Get-ChildItem 'C:\Compac' -Recurse -Directory -Filter '*squema*' -ErrorAction SilentlyContinue
    foreach ($h in $hallados) { $raices += $h.FullName; Decir "  ENCONTRADA: $($h.FullName)" }
  }
  if (-not $raices) { Decir '  NADA. Esta maquina probablemente no tiene ContPAQi instalado.' }
}

# --- 2. El archivo que manda --------------------------------------------------------------------
Seccion '2. Archivos de esquema (se copian a la carpeta de salida)'
$copiados = 0
foreach ($r in $raices) {
  $archivos = Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Extension -match '^\.(xls|xlsx|txt|ini|xml|cfg)$' }
  foreach ($a in $archivos) {
    $marca = ''
    if ($a.Name -match 'Poliza') { $marca = '   <<< ESTE ES EL DEL TXT DE POLIZAS' }
    Decir ("  {0,-62} {1,9:N0} bytes  {2:yyyy-MM-dd}{3}" -f $a.FullName, $a.Length, $a.LastWriteTime, $marca)
    $destino = Join-Path $SALIDA ("esquema__" + ($a.FullName -replace '[\\:]', '_'))
    try { Copy-Item $a.FullName -Destination $destino -Force -ErrorAction Stop; $copiados++ }
    catch { Decir "      NO SE PUDO COPIAR: $($_.Exception.Message)" }
  }
}
Decir "  -> copiados $copiados archivo(s) a $SALIDA"

# --- 3. Intento de leer el .xls del esquema sin abrirlo a mano ----------------------------------
Seccion '3. Contenido del esquema de polizas (si Excel esta disponible)'
$xlsPoliza = @()
foreach ($r in $raices) {
  $xlsPoliza += Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match 'Poliza' -and $_.Extension -match '^\.(xls|xlsx)$' }
}
if (-not $xlsPoliza) {
  Decir '  No se encontro un .xls de polizas. Revisar la lista de la seccion 2.'
} else {
  $excel = $null
  try { $excel = New-Object -ComObject Excel.Application -ErrorAction Stop } catch { }
  if (-not $excel) {
    Decir '  Excel no esta instalado en esta maquina: no se puede volcar el contenido aca.'
    Decir '  NO IMPORTA -- el archivo ya se copio en la seccion 2. Abrirlo en otra maquina.'
  } else {
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    foreach ($x in $xlsPoliza) {
      Decir ''
      Decir "  --- $($x.FullName) ---"
      try {
        $wb = $excel.Workbooks.Open($x.FullName, 0, $true)   # $true = solo lectura
        foreach ($hoja in $wb.Worksheets) {
          Decir "    [hoja: $($hoja.Name)]"
          $usado = $hoja.UsedRange
          $filas = [Math]::Min($usado.Rows.Count, 80)
          $cols  = [Math]::Min($usado.Columns.Count, 12)
          for ($i = 1; $i -le $filas; $i++) {
            $celdas = @()
            for ($j = 1; $j -le $cols; $j++) {
              $v = $usado.Cells.Item($i, $j).Text
              if ($null -eq $v) { $v = '' }
              $celdas += $v
            }
            $linea = ($celdas -join ' | ').TrimEnd(' |')
            if ($linea.Trim()) { Decir "      $linea" }
          }
        }
        $wb.Close($false)
      } catch { Decir "    NO SE PUDO LEER: $($_.Exception.Message)" }
    }
    $excel.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  }
}

# --- 4. Un TXT real ya importado vale tanto como el esquema -------------------------------------
Seccion '4. TXT de polizas que ya se hayan importado (cualquiera sirve)'
$buscarEn = @("$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents", "$env:USERPROFILE\Downloads",
              'C:\Compac', 'C:\temp', 'C:\tmp') | Where-Object { Test-Path $_ }
$txts = @()
foreach ($d in $buscarEn) {
  $txts += Get-ChildItem $d -Recurse -File -Filter '*.txt' -ErrorAction SilentlyContinue |
           Where-Object { $_.Length -gt 100 -and $_.Length -lt 20MB }
}
$polizaTxt = @()
foreach ($t in ($txts | Sort-Object FullName -Unique)) {
  try {
    $primera = (Get-Content $t.FullName -TotalCount 1 -ErrorAction Stop)
    # El encabezado de una poliza arranca con "P" y la segunda posicion es espacio.
    if ($primera -match '^P\s') { $polizaTxt += $t }
  } catch { }
}
if (-not $polizaTxt) {
  Decir '  No se encontro ningun TXT con pinta de poliza en las carpetas revisadas.'
  Decir '  Si la contadora guarda los archivos que importa, pedirle UNO: con eso se miden'
  Decir '  los anchos solos y las cuatro dudas se cierran.'
} else {
  foreach ($t in $polizaTxt) {
    Decir ''
    Decir "  >>> ENCONTRADO: $($t.FullName)  ($($t.Length) bytes, $($t.LastWriteTime))"
    $destino = Join-Path $SALIDA ("poliza__" + $t.Name)
    try { Copy-Item $t.FullName -Destination $destino -Force; Decir "      copiado a $destino" } catch { }
    # Los largos de linea son la medicion: ahi se leen los anchos sin abrir nada.
    $lineas = Get-Content $t.FullName -TotalCount 6
    $n = 0
    foreach ($l in $lineas) {
      $n++
      Decir ("      linea {0}: {1,4} caracteres | arranca con '{2}'" -f $n, $l.Length, $l.Substring(0, [Math]::Min(2, $l.Length)))
    }
    Decir '      (nuestro layout produce P=147 y M=211 caracteres; si estos numeros difieren,'
    Decir '       la diferencia ES la respuesta)'
    if (($lineas | Where-Object { $_ -match '^AD\s' })) {
      Decir '      *** TIENE RENGLONES "AD" -> el formato SI transporta el UUID del CFDI ***'
    }
  }
}

# --- 5. Version del producto ---------------------------------------------------------------------
Seccion '5. Version de ContPAQi instalada'
$apps = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                         'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match 'CONTPAQ' }
if (-not $apps) { Decir '  No aparece CONTPAQi en programas instalados.' }
else { foreach ($a in $apps) { Decir ("  {0} = {1}" -f $a.DisplayName, $a.DisplayVersion) } }
Decir '  (la base dice VersionBDD 1912; aca sale la del producto, que es la que importa'
Decir '   para no cruzar versiones de esquema)'

Seccion 'FIN'
Decir "Reporte: $REPORTE"
Decir "Traer la carpeta completa: $SALIDA"
Write-Output ''
Write-Output "LISTO. Todo quedo en $SALIDA"
