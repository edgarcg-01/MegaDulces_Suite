<#
  Fase CP (ADR-040) - SONDEO DEL SDK DE CONTPAQi. Read-only: no instala, no escribe, no abre
  empresa, no consume licencia. Imprime un reporte y sale.

  POR QUE EXISTE
  --------------
  La decision de construir la conexion directa de ESCRITURA a ContPAQi depende de cuatro datos
  que NO se pueden medir por red (medido 2026-10-08 contra 192.168.0.35: WinRM 5985 cerrado,
  RDP 3389 cerrado, SMB 445 abierto pero Acceso denegado). Son:

    1. Esta instalado el SDK?  (es una casilla del instalador de ContPAQi)
    2. De cuantos bits es?     (decide si un Node que lo cargue tiene que ser x86 - y Node dejo
                                de publicar binarios x86 de Windows en la v23)
    3. Expone IDispatch?       (decide si `winax` desde Node es siquiera posible, o si el unico
                                camino es un .exe en C#)
    4. Que version del producto? (el SDK no se debe cruzar de version con el sistema)

  Mientras estas cuatro no esten medidas, cualquier estimado del SDK es un numero inventado.

  DONDE CORRERLO
  --------------
  En una maquina Windows que tenga CONTPAQi Contabilidad instalado. Puede ser el servidor
  (192.168.0.35) o una TERMINAL - la documentacion del SDK contempla el modo Servidor/Terminal
  explicitamente, y una terminal es MUCHO mejor opcion: no se toca el servidor contable.

      powershell -ExecutionPolicy Bypass -File 01-probe-sdk.ps1

  No requiere administrador para sondear. (El SDK SI lo requiere para operar - eso es otra cosa
  y se verifica el dia que se use de verdad.)
#>

$ErrorActionPreference = 'Continue'

function Seccion($t) { Write-Output ''; Write-Output "=== $t ===" }

# --------------------------------------------------------------------------------------------
# Lee el tipo de maquina del encabezado PE. Es la unica forma honesta de saber los bits de un
# DLL: el nombre del archivo y la carpeta MIENTEN (hay DLLs de 32 bits en Program Files a secas).
#   e_lfanew vive en 0x3C; la firma PE arranca ahi; el campo Machine esta 4 bytes despues.
# --------------------------------------------------------------------------------------------
function Get-DllBitness($ruta) {
  try {
    $fs = [System.IO.File]::OpenRead($ruta)
    try {
      $buf = New-Object byte[] 4
      $null = $fs.Seek(0x3C, 'Begin'); $null = $fs.Read($buf, 0, 4)
      $peOff = [BitConverter]::ToInt32($buf, 0)
      $null = $fs.Seek($peOff + 4, 'Begin'); $null = $fs.Read($buf, 0, 2)
      $machine = [BitConverter]::ToUInt16($buf, 0)
    } finally { $fs.Close() }
    switch ($machine) {
      0x014c  { return 'x86 (32 bits)' }
      0x8664  { return 'x64 (64 bits)' }
      0x01c4  { return 'ARM' }
      default { return ("desconocido 0x{0:X}" -f $machine) }
    }
  } catch { return "NO SE PUDO LEER ($($_.Exception.Message))" }
}

Write-Output "Sondeo SDK CONTPAQi - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Output "Maquina: $env:COMPUTERNAME   Usuario: $env:USERNAME"
Write-Output "SO: $((Get-CimInstance Win32_OperatingSystem).Caption) ($(if ([Environment]::Is64BitOperatingSystem) {'64'} else {'32'}) bits)"

# --- 1. Donde esta instalado -----------------------------------------------------------------
Seccion '1. Instalacion de CONTPAQi'
$raices = @('C:\Compac', 'C:\Program Files (x86)\Compac', 'C:\Program Files\Compac',
            'C:\Archivos de programa\Compac', 'C:\Program Files (x86)\Compacw', 'C:\Compacw') |
          Where-Object { Test-Path $_ }
if (-not $raices) {
  Write-Output 'NO SE ENCONTRO ninguna carpeta de CONTPAQi.'
  Write-Output 'VEREDICTO: esta maquina NO sirve de agente. Correr el sondeo donde este instalado.'
} else {
  $raices | ForEach-Object { Write-Output "  encontrado: $_" }
}

# --- 2. El SDK ---------------------------------------------------------------------------------
Seccion '2. DLLs del SDK (lo que decide si se puede, y con que)'
$patrones = @('Poldll32.dll', 'SDK*.dll', '*SDK*.dll', 'MGW*.dll', 'CntSdk*.dll', 'Contab*.dll')
$dlls = @()
foreach ($r in $raices) {
  foreach ($p in $patrones) {
    $dlls += Get-ChildItem -Path $r -Filter $p -Recurse -ErrorAction SilentlyContinue -File
  }
}
$dlls = $dlls | Sort-Object FullName -Unique
if (-not $dlls) {
  Write-Output 'NO SE ENCONTRO ningun DLL de SDK.'
  Write-Output 'VEREDICTO PROBABLE: el SDK no se instalo (es una casilla del instalador).'
  Write-Output 'Accion: reinstalar/modificar la instalacion de CONTPAQi habilitando el SDK.'
} else {
  foreach ($d in $dlls) {
    $v = $d.VersionInfo.FileVersion
    if ([string]::IsNullOrWhiteSpace($v)) { $v = '(sin version)' }
    Write-Output ("  {0}`n      bits: {1} | version: {2} | {3:N0} bytes | {4:yyyy-MM-dd}" -f `
      $d.FullName, (Get-DllBitness $d.FullName), $v, $d.Length, $d.LastWriteTime)
  }
  Write-Output ''
  Write-Output 'LEER ASI: si el DLL de polizas (Poldll32.dll) dice x86, un Node que lo cargue'
  Write-Output 'en proceso tiene que ser x86 -> linea 22 de Node, fin de mantenimiento abr-2027.'
}

# --- 3. Registro COM: IDispatch o no ----------------------------------------------------------
# ⛔ El filtro NO puede ser por nombre suelto. La primera version buscaba 'Sdk|Contpaq|Compac|
# Poliza' y en una maquina SIN ContPAQi enganchó `aura.sdk`, `JScript.Compact` y 5 `WMSDK*` de
# Windows - y los INSTANCIÓ. Un sondeo no debe crear objetos COM ajenos para contestar una
# pregunta sobre ContPAQi. La evidencia correcta es DONDE VIVE EL DLL, no como se llama la clave.
Seccion '3. Registro COM (decide si `winax` desde Node es posible)'
if (-not $raices) {
  Write-Output 'NO APLICA: sin instalacion de CONTPAQi en esta maquina, no hay nada que sondear.'
} else {
  $progIds = @()
  foreach ($hive in 'HKLM:\SOFTWARE\Classes', 'HKLM:\SOFTWARE\Classes\Wow6432Node', 'HKCU:\SOFTWARE\Classes') {
    if (-not (Test-Path $hive)) { continue }
    foreach ($k in (Get-ChildItem $hive -ErrorAction SilentlyContinue)) {
      $nombre = $k.PSChildName
      # (a) el nombre habla de ContPAQi -- 'Sdk' a secas NO califica, es demasiado comun
      $porNombre = $nombre -match 'Contpaq|Compac|Poliza'
      # (b) o su servidor in-proc vive dentro de una carpeta de ContPAQi: la evidencia dura
      $porRuta = $false
      $srv = (Get-ItemProperty "$hive\$nombre\CLSID" -ErrorAction SilentlyContinue).'(default)'
      if ($srv) {
        $dll = (Get-ItemProperty "$hive\CLSID\$srv\InprocServer32" -ErrorAction SilentlyContinue).'(default)'
        if ($dll) { foreach ($r in $raices) { if ($dll -like "$r*") { $porRuta = $true } } }
      }
      if ($porNombre -or $porRuta) { $progIds += $nombre }
    }
  }
  $progIds = $progIds | Sort-Object -Unique
  if (-not $progIds) {
    Write-Output 'Sin ProgIDs de CONTPAQi en el registro.'
    Write-Output 'IMPLICA: no hay automatizacion COM por nombre -> `winax` NO sirve; queda el .exe en C#.'
  } else {
    $progIds | ForEach-Object { Write-Output "  ProgID: $_" }
    Write-Output ''
    Write-Output 'Prueba REAL de IDispatch (lo unico que decide; que el ProgID exista no basta):'
    foreach ($nombreProg in $progIds) {
      try {
        $o = New-Object -ComObject $nombreProg -ErrorAction Stop
        Write-Output "  OK  $nombreProg -> instanciable por nombre (IDispatch disponible)"
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o)
      } catch {
        Write-Output "  --  $nombreProg -> no se pudo instanciar: $($_.Exception.Message)"
      }
    }
  }
}

# --- 4. Version del producto ------------------------------------------------------------------
Seccion '4. Version del producto instalado (no cruzar versiones con el SDK)'
$apps = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                         'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match 'CONTPAQ' } |
        Select-Object DisplayName, DisplayVersion, InstallDate
if (-not $apps) { Write-Output 'No aparece CONTPAQi en programas instalados.' }
else { $apps | ForEach-Object { Write-Output ("  {0} = {1} (instalado {2})" -f $_.DisplayName, $_.DisplayVersion, $_.InstallDate) } }
Write-Output ''
Write-Output 'Contraste: el ESQUEMA de la base dice VersionBDD 1912 (empresa) / 1841 (GeneralesSQL),'
Write-Output 'medido el 2026-10-08. Eso es el esquema, no el producto: aca sale el producto.'

# --- 5. Servidor o terminal -------------------------------------------------------------------
Seccion '5. Esta maquina es el servidor de datos, o una terminal?'
# ⛔ TRES estados, no dos. La primera version tenia if/else y en una maquina SIN ContPAQi
# dictaminaba "parece una TERMINAL, la mejor ubicacion para el agente" - una AUSENCIA publicada
# como veredicto positivo, que es justo el modo de falla que ADR-056 prohibe.
$esSrv = $false
foreach ($r in $raices) { if (Test-Path (Join-Path $r 'Empresas')) { $esSrv = $true } }
if (-not $raices) {
  Write-Output 'NO MEDIDO: sin CONTPAQi instalado no es ni servidor ni terminal.'
  Write-Output 'Esta maquina NO puede alojar el agente hasta que se instale CONTPAQi + SDK.'
} elseif ($esSrv) {
  Write-Output 'Hay carpeta Empresas -> parece el SERVIDOR de datos.'
  Write-Output 'OJO: poner el agente aqui toca el servidor contable. Preferir una terminal.'
} else {
  Write-Output 'Sin carpeta Empresas, pero CON CONTPAQi instalado -> es una TERMINAL.'
  Write-Output 'Es la mejor ubicacion para el agente: no se toca el servidor contable.'
}
Write-Output ''
Write-Output 'PENDIENTE que este sondeo NO puede contestar (hay que abrir el sistema):'
Write-Output '  - Login del SDK consume un asiento de licencia? (compite con quien este trabajando)'
Write-Output '  - La empresa dice RutaDatos=localhost; una TERMINAL la resuelve bien?'

Seccion 'FIN'
Write-Output 'Pegar esta salida completa en FASE_CP_CONTPAQI.md seccion 7.7.'
