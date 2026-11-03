# [PDV.6] Censo de una caja de mostrador: lo que la caja de la Suite necesita saber del equipo.
#
# SOLO LEE. No abre la gaveta, no imprime, no instala nada. Escribe UNA ficha JSON junto al script
# (o en -Carpeta) y muestra el resumen en pantalla.
#
#   powershell -ExecutionPolicy Bypass -File censo-caja.ps1                 (con preguntas al encargado)
#   powershell -ExecutionPolicy Bypass -File censo-caja.ps1 -SinPreguntas   (solo lo que se mide solo)
#
# Compatible con PowerShell 2 (Windows 7): WMI en vez de Get-PnpDevice/Get-Printer y un JSON propio
# en vez de ConvertTo-Json. Texto sin acentos a proposito: un .ps1 sin BOM los rompe en PS 5.1.
# Juntar las fichas: node ops/cajas/consolidar-censo.js <carpeta>
param(
  [string]$Carpeta = '',
  [string]$Servidor = '192.168.0.222',
  [string]$Salud = 'https://megadulcessuite.com/api/health',
  [switch]$SinPreguntas
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $Carpeta) { $Carpeta = Split-Path -Parent $MyInvocation.MyCommand.Path }

# ---- JSON propio (PS2 no trae ConvertTo-Json) ----
function J($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal] -or $v -is [single] -or $v -is [uint32] -or $v -is [uint64] -or $v -is [int16] -or $v -is [uint16]) {
    return [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}', $v)
  }
  if ($v -is [hashtable]) {
    $p = @(); foreach ($k in $v.Keys) { $p += ((J ([string]$k)) + ':' + (J $v[$k])) }
    return '{' + ($p -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
    $p = @(); foreach ($x in $v) { $p += (J $x) }
    return '[' + ($p -join ',') + ']'
  }
  $s = ([string]$v).Replace('\', '\\').Replace('"', '\"') -replace '[\x00-\x1f]', ' '
  return '"' + $s + '"'
}
function Lista() { return New-Object System.Collections.ArrayList }
function VidPid($id) {
  if ([string]$id -match 'VID_([0-9A-Fa-f]{4}).*PID_([0-9A-Fa-f]{4})') { return ($matches[1].ToUpper() + ':' + $matches[2].ToUpper()) }
  return $null
}

# ---- Equipo ----
$os = Get-WmiObject Win32_OperatingSystem
$cs = Get-WmiObject Win32_ComputerSystem
$cpu = @(Get-WmiObject Win32_Processor)[0]
$disco = Get-WmiObject Win32_LogicalDisk -Filter "DeviceID='C:'"
$equipo = @{
  nombre = $env:COMPUTERNAME
  windows = [string]$os.Caption
  version = [string]$os.Version
  arquitectura = [string]$os.OSArchitecture
  fabricante = [string]$cs.Manufacturer
  modelo = [string]$cs.Model
  procesador = ([string]$cpu.Name).Trim()
  ram_gb = [math]::Round(([double]$cs.TotalPhysicalMemory) / 1GB, 1)
  disco_c_libre_gb = [math]::Round(([double]$disco.FreeSpace) / 1GB, 1)
  powershell = [string]$PSVersionTable.PSVersion
}

# ---- Pantallas: lo que ve el navegador (con la escala de Windows) y el modo fisico ----
$pantallas = Lista
[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  [void]$pantallas.Add(@{ ancho = [int]$s.Bounds.Width; alto = [int]$s.Bounds.Height; principal = [bool]$s.Primary })
}
$video = Lista
foreach ($v in @(Get-WmiObject Win32_VideoController)) {
  if ($v.CurrentHorizontalResolution) {
    [void]$video.Add(@{ adaptador = [string]$v.Name; ancho = [int]$v.CurrentHorizontalResolution; alto = [int]$v.CurrentVerticalResolution })
  }
}

# ---- Navegadores (Web Serial pide Chrome o Edge 89+) ----
function Navegador($exe) {
  $raices = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')
  foreach ($r in $raices) {
    $k = Join-Path $r $exe
    if (Test-Path $k) {
      $ruta = (Get-ItemProperty $k).'(default)'
      if ($ruta) { $ruta = $ruta.Trim('"') }
      if ($ruta -and (Test-Path $ruta)) { return [string](Get-Item $ruta).VersionInfo.ProductVersion }
    }
  }
  return $null
}
$navegadores = @{ chrome = (Navegador 'chrome.exe'); edge = (Navegador 'msedge.exe'); firefox = (Navegador 'firefox.exe') }

# ---- Impresoras y su puerto (COM = Web Serial puede; USB/red = hace falta agente) ----
$impresoras = Lista
foreach ($p in @(Get-WmiObject Win32_Printer)) {
  [void]$impresoras.Add(@{ nombre = [string]$p.Name; puerto = [string]$p.PortName; driver = [string]$p.DriverName; predeterminada = [bool]$p.Default; fuera_de_linea = [bool]$p.WorkOffline })
}

# ---- Dispositivos: impresoras USB (usbprint), puertos COM y teclados (los lectores entran como teclado) ----
$GUID_TECLADO = '{4d36e96b-e325-11ce-bfc1-08002be10318}'
$usbprint = Lista; $com = Lista; $teclados = Lista
foreach ($d in @(Get-WmiObject Win32_PnPEntity)) {
  $id = [string]$d.PNPDeviceID
  if ($d.Service -eq 'usbprint') { [void]$usbprint.Add(@{ nombre = [string]$d.Name; vid_pid = (VidPid $id); estado = [string]$d.Status }) }
  if ([string]$d.Name -match '\((COM\d+)\)') { [void]$com.Add(@{ puerto = $matches[1]; nombre = [string]$d.Name; vid_pid = (VidPid $id) }) }
  if ([string]$d.ClassGuid -eq $GUID_TECLADO -and (VidPid $id)) { [void]$teclados.Add(@{ nombre = [string]$d.Name; vid_pid = (VidPid $id) }) }
}

# ---- Red: latencia a md y a la Suite publicada ----
$red = @{ servidor = $Servidor; ping_ms = $null; ping_perdidos = $null; salud_ms = $null; salud_error = $null }
$r = @(Test-Connection -ComputerName $Servidor -Count 4)
if ($r.Count -gt 0) {
  $suma = 0; foreach ($x in $r) { $suma += [int]$x.ResponseTime }
  $red.ping_ms = [math]::Round($suma / $r.Count, 0); $red.ping_perdidos = 4 - $r.Count
} else { $red.ping_perdidos = 4 }
try {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072 } catch { }
  $wc = New-Object Net.WebClient
  $t0 = Get-Date
  [void]$wc.DownloadString($Salud)
  $red.salud_ms = [int]((Get-Date) - $t0).TotalMilliseconds
} catch { $red.salud_error = [string]$_.Exception.Message }

# ---- Lo que solo sabe quien esta en la caja ----
$encargado = @{ sucursal = $null; caja = $null; quien = $null; cajon_en_impresora = $null; bascula = $null; bascula_modelo = $null; notas = $null }
$lector = @{ probado = $false; codigo = $null; sufijo = $null; ms_entre_teclas_max = $null }
function SiNo($t) { $x = (Read-Host ($t + ' (s/n)')); if ($x -match '^[sS]') { return $true } elseif ($x -match '^[nN]') { return $false } else { return $null } }

if (-not $SinPreguntas) {
  Write-Host ''
  Write-Host '== Censo de caja (solo lee, no cambia nada) ==' -ForegroundColor Cyan
  $encargado.sucursal = Read-Host 'Sucursal (nombre, ej. Yurecuaro)'
  $encargado.caja = Read-Host 'Numero de caja (el de Kepler, ej. 1)'
  $encargado.quien = Read-Host 'Tu nombre'
  $encargado.cajon_en_impresora = SiNo 'El cajon de dinero esta conectado con cable a la impresora de tickets?'
  $encargado.bascula = SiNo 'Hay bascula conectada a esta computadora?'
  if ($encargado.bascula) { $encargado.bascula_modelo = Read-Host 'Marca y modelo de la bascula (viene en su etiqueta)' }

  # Prueba del lector: un lector teclea muy rapido (decenas de ms entre teclas) y termina con Enter o Tab.
  Write-Host ''
  Write-Host 'Escanea el codigo de barras de CUALQUIER producto con el lector. Tienes 30 segundos.' -ForegroundColor Yellow
  Write-Host '(Si no hay lector, solo espera.)'
  try {
    while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }
    $buf = ''; $max = 0; $ultimo = $null; $inicio = Get-Date
    while (((Get-Date) - $inicio).TotalSeconds -lt 30) {
      if ([Console]::KeyAvailable) {
        $k = [Console]::ReadKey($true); $ahora = Get-Date
        if ($ultimo) { $ms = ($ahora - $ultimo).TotalMilliseconds; if ($ms -gt $max) { $max = $ms } }
        $ultimo = $ahora
        if ($k.Key -eq 'Enter') { $lector.sufijo = 'Enter'; break }
        elseif ($k.Key -eq 'Tab') { $lector.sufijo = 'Tab'; break }
        else { $buf += $k.KeyChar }
      } elseif ($ultimo -and ((Get-Date) - $ultimo).TotalMilliseconds -gt 1500) { $lector.sufijo = 'ninguno'; break }
      else { Start-Sleep -Milliseconds 5 }
    }
    if ($buf) { $lector.probado = $true; $lector.codigo = $buf; $lector.ms_entre_teclas_max = [int]$max }
  } catch { $encargado.notas = 'La prueba del lector no corre en esta ventana: abrir PowerShell normal, no ISE.' }
  $n = Read-Host 'Algo mas que debamos saber de esta caja? (Enter si no)'
  if ($n) { $encargado.notas = (([string]$encargado.notas) + ' ' + $n).Trim() }
}

$ficha = @{
  censo = 'PDV.6'
  version_script = 1
  fecha = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
  equipo = $equipo
  pantallas = $pantallas
  video = $video
  navegadores = $navegadores
  impresoras = $impresoras
  usbprint = $usbprint
  com = $com
  teclados = $teclados
  red = $red
  encargado = $encargado
  lector = $lector
}

$limpio = { param($t) if ($t) { ([string]$t) -replace '[^A-Za-z0-9_-]', '' } else { 'x' } }
$archivo = Join-Path $Carpeta ('censo-' + (& $limpio $encargado.sucursal) + '-' + (& $limpio $encargado.caja) + '-' + $env:COMPUTERNAME + '.json')
(J $ficha) | Out-File -FilePath $archivo -Encoding UTF8

# ---- Resumen en pantalla ----
Write-Host ''
Write-Host '== Resumen ==' -ForegroundColor Cyan
Write-Host ('Equipo:      ' + $equipo.windows + ' - ' + $equipo.ram_gb + ' GB')
foreach ($s in $pantallas) { Write-Host ('Pantalla:    ' + $s.ancho + ' x ' + $s.alto + $(if ($s.principal) { ' (principal)' } else { ' (segunda)' })) }
Write-Host ('Chrome:      ' + $(if ($navegadores.chrome) { $navegadores.chrome } else { 'no instalado' }) + ' - Edge: ' + $(if ($navegadores.edge) { $navegadores.edge } else { 'no instalado' }))
foreach ($p in $impresoras) { Write-Host ('Impresora:   ' + $p.nombre + '  [' + $p.puerto + ']') }
foreach ($c in $com) { Write-Host ('Puerto:      ' + $c.nombre) }
Write-Host ('Lector:      ' + $(if ($lector.probado) { 'leyo ' + $lector.codigo + ' - termina con ' + $lector.sufijo } elseif ($SinPreguntas) { 'no probado' } else { 'no se escaneo nada' }))
Write-Host ('Red a md:    ' + $(if ($null -ne $red.ping_ms) { [string]$red.ping_ms + ' ms' } else { 'sin respuesta' }) + ' - Suite: ' + $(if ($red.salud_ms) { [string]$red.salud_ms + ' ms' } else { 'error: ' + $red.salud_error }))
Write-Host ''
Write-Host ('Ficha guardada en: ' + $archivo) -ForegroundColor Green
Write-Host 'Toma una FOTO de la impresora, el cajon y el lector, y mandala con este archivo.'
