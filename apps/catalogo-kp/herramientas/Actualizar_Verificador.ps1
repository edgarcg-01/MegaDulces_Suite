# ============================================================================
#  Regenera los verificadores de precios con los datos vigentes.
#
#  Genera UNO POR SUCURSAL (verificador-NN.html) porque hay codigos que
#  cuestan distinto segun la plaza: un archivo unico mostraria el precio de
#  una sucursal cualquiera y cambiaria solo cada vez que alguna se
#  re-sincroniza. Tambien mantiene verificador.html (sin filtro) para lo que
#  ya apunte ahi.
#
#  La lista de sucursales se consulta a la API, no va codificada: cuando
#  Kepler de de alta una plaza nueva, aparece sola.
#
#  Si algo falla -- API caida, respuesta corta, JSON invalido, sucursal sin
#  datos -- NO toca el archivo bueno. Un verificador viejo sirve; uno roto deja
#  sin precios al mostrador.
#
#  Adaptado del script original de megadulces-api-ready (mismo mecanismo,
#  mismas guardas de encoding/sello) para el layout de apps/catalogo-kp
#  (recortado al verificador de precios dentro del monorepo Suite):
#    - la plantilla vive DENTRO de este app, en plantilla/ (no un nivel arriba)
#    - el endpoint de sucursales es /api/sucursales (no /api/catalogo/sucursales)
#
#  ----------------------------------------------------------------------------
#  DOS ERRORES QUE YA SE COMETIERON EN EL SCRIPT ORIGINAL Y NO DEBEN REPETIRSE:
#
#  1. ENCODING. Get-Content / Set-Content de PowerShell 5.1 leen y escriben con
#     la pagina de codigos ANSI del sistema, no UTF-8. Aqui se usan las
#     funciones de .NET con UTF-8 SIN BOM, que es como esta escrito el original.
#
#  2. EL SELLO. El HTML contiene la linea
#         var f = window.MD_ACTUALIZADO || null;
#     DENTRO del bloque <script>. Buscar "MD_ACTUALIZADO" a secas la encontraba
#     y la reemplazaba por un <script> completo, cerrando el bloque a media
#     funcion y volcando el resto del JavaScript como texto visible en pantalla.
#     Solo se reemplazan lineas que YA sean un <script> suelto del sello.
#  ----------------------------------------------------------------------------
# ============================================================================

$ErrorActionPreference = 'Stop'

$repo      = Split-Path $PSScriptRoot -Parent
$publico   = Join-Path $repo 'public'
$log       = Join-Path $PSScriptRoot 'actualizar_verificador.log'

# Apuntar al despliegue real de catalogo-kp. Default: la misma maquina,
# puerto 3000 (ver apps/catalogo-kp/src/main.ts, env PORT).
$base      = 'http://localhost:3000/api/kp/precios-todos'
$urlSucs   = 'http://localhost:3000/api/sucursales'

# Plantilla DENTRO de este app (a diferencia del proyecto origen, que la
# guardaba un nivel arriba del proyecto): asi clonar/desplegar no depende de
# un archivo suelto fuera de git.
$plantilla = Join-Path $repo 'plantilla\Verificador_Precios_OFFLINE.html'

$MIN_PRODUCTOS = 8000
$MIN_BYTES     = 900KB

# UTF-8 sin BOM, igual que el original
$UTF8 = New-Object System.Text.UTF8Encoding($false)

function Anotar($txt) {
    $linea = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $txt
    # Write-Host y no Write-Output: dentro de una funcion, Write-Output se suma
    # al valor de retorno y un fallo se contaria como exito.
    Write-Host $linea
    try { Add-Content -LiteralPath $log -Value $linea -Encoding UTF8 } catch { }
}

<#
  Genera un verificador. Devuelve $true solo si lo reemplazo.
  $suc = '00'..'NN', o $null para el consolidado sin filtro.
#>
function Generar($suc, $destino, $etiqueta) {
    try {
        $url = $base
        if ($suc) { $url = $base + '?sucursal=' + $suc }

        $json = (Invoke-WebRequest -Uri $url -TimeoutSec 300 -UseBasicParsing).Content
        if ($json.Length -lt $MIN_BYTES) { throw "respuesta corta ($($json.Length) bytes)" }

        $datos = $json | ConvertFrom-Json
        $n = $datos.productos.Count
        if ($n -lt $MIN_PRODUCTOS) { throw "solo $n productos, se esperaban $MIN_PRODUCTOS o mas" }

        if (-not (Test-Path -LiteralPath $plantilla)) { throw "falta la plantilla $plantilla" }

        # UTF-8 explicito: NO usar Get-Content aqui (ver nota 1 arriba)
        $lineas = [System.Collections.ArrayList]@(
            [System.IO.File]::ReadAllLines($plantilla, [System.Text.Encoding]::UTF8)
        )

        # -- Linea de datos --------------------------------------------------
        $iDatos = -1
        for ($i = 0; $i -lt $lineas.Count; $i++) {
            if ($lineas[$i] -like '*window.MDPRECIOS=*') { $iDatos = $i; break }
        }
        if ($iDatos -lt 0) { throw 'la plantilla no contiene window.MDPRECIOS' }
        $lineas[$iDatos] = '<script>window.MDPRECIOS=' + $json + '</script>'

        # -- Sello de fecha y plaza (la pagina lo lee en window.MD_ACTUALIZADO)
        $sello = '<script>window.MD_ACTUALIZADO=' +
                 (ConvertTo-Json ((Get-Date -Format 'dd/MM/yyyy HH:mm') + ' - ' + $etiqueta) -Compress) +
                 ';</script>'

        # Solo un <script> suelto del sello es reemplazable (ver nota 2 arriba)
        $iSello = -1
        for ($i = 0; $i -lt $lineas.Count; $i++) {
            if ($lineas[$i].TrimStart() -like '<script>window.MD_ACTUALIZADO=*') { $iSello = $i; break }
        }
        if ($iSello -ge 0) { $lineas[$iSello] = $sello }
        else { $lineas.Insert($iDatos + 1, $sello) | Out-Null }

        # -- Escribir a temporal y validar antes de reemplazar ---------------
        $temp = $destino + '.nuevo'
        [System.IO.File]::WriteAllLines($temp, $lineas, $UTF8)

        $tam = (Get-Item -LiteralPath $temp).Length
        if ($tam -lt $MIN_BYTES) { Remove-Item -LiteralPath $temp -Force; throw "quedo en $tam bytes" }

        $texto = [System.IO.File]::ReadAllText($temp, [System.Text.Encoding]::UTF8)
        if ($texto -notlike '*window.MDPRECIOS=*') {
            Remove-Item -LiteralPath $temp -Force; throw 'el archivo generado no trae precios'
        }
        # Guarda de encoding. Comprobacion POSITIVA: la palabra "codigo" debe
        # aparecer con su o acentuada real (U+00F3). Si el archivo se leyo o
        # escribio como ANSI, ahi habria dos caracteres basura en su lugar.
        # El literal se arma con [char] para que este .ps1 siga siendo ASCII
        # puro: escribir la acentuada aqui reintroduce el mismo problema.
        $oAcento = [char]0xF3
        if ($texto -notlike ("*c" + $oAcento + "digo*")) {
            Remove-Item -LiteralPath $temp -Force
            throw 'acentos corruptos: el archivo no quedo en UTF-8'
        }
        # Guarda de estructura: si el sello se inserto donde no debia, quedarian
        # etiquetas <script> sin cerrar y el JavaScript se veria como texto.
        $aperturas = ([regex]::Matches($texto, [regex]::Escape('<script'))).Count
        $cierres   = ([regex]::Matches($texto, [regex]::Escape('</script>'))).Count
        if ($aperturas -ne $cierres) {
            Remove-Item -LiteralPath $temp -Force
            throw "etiquetas script desbalanceadas ($aperturas abren, $cierres cierran)"
        }

        Move-Item -LiteralPath $temp -Destination $destino -Force
        Anotar ("  OK  {0,-24} {1,5} productos  {2,5} KB" -f $etiqueta, $n, [math]::Round($tam/1KB))
        return $true
    }
    catch {
        Anotar ("  ERROR {0}: {1}  (se conserva el anterior)" -f $etiqueta, $_.Exception.Message)
        return $false
    }
}

Anotar '--- inicio ---'

# -- Sucursales vigentes, consultadas a la API -------------------------------
$sucursales = @()
try {
    # Se aplana elemento por elemento: envolver la respuesta en @() puede dejar
    # un arreglo dentro de otro, y entonces $s seria la lista completa en vez de
    # una sucursal (se generaba "verificador-00 01 02 03 04 05.html").
    $resp = Invoke-RestMethod -Uri $urlSucs -TimeoutSec 60
    foreach ($x in $resp) { $sucursales += $x }
    Anotar ("Sucursales reportadas por la API: " + (($sucursales | ForEach-Object { $_.codigo }) -join ', '))
} catch {
    Anotar "ERROR: no se pudo consultar la lista de sucursales: $($_.Exception.Message)"
    Anotar '--- fin: nada generado ---'
    exit 1
}

$okey = 0
$total = 0

$total++
if (Generar $null (Join-Path $publico 'verificador.html') 'TODAS (no determinista)') { $okey++ }

foreach ($s in $sucursales) {
    $total++
    $destino = Join-Path $publico ('verificador-' + $s.codigo + '.html')
    if (Generar $s.codigo $destino $s.nombre) { $okey++ }
}

Anotar "--- fin: $okey de $total generados ---"
if ($okey -eq 0) { exit 1 }
exit 0
