# =============================================================================
#  [RD.94] ¿Qué SERIES de venta tiene la camioneta, día por día? Se pega tal cual
#  en la consola de la van. SOLO LEE: no toca nada. NUNCA imprime contrasenas.
#
#  Por qué existe (medido el 2026-10-28, Q21):
#   · al motor le faltan DOS días que el libro sí tiene: la 501 el 15-oct ($26,594.75)
#     y la 504 el 10-oct ($11,284.43). No están en el runner ni en prod.
#   · el agente sólo sube la serie de ROUTE_SERIE (UD1001) y tipo U-D-10. Un día vendido
#     con OTRA serie no sube, y el merge del runner no lo nota: sólo reescribe las
#     fechas que llegan en el lote.
#   · huella en la 501: el folio va 0001553 (14-oct) y vuelve a 0000001 el 16-oct.
#     En la 504 los folios del 9 y el 12 son consecutivos: el 10 no hubo UD1001.
#
#  Lo que contesta: por día, cada serie y tipo de documento con su importe, y si el
#  agente la SUBE o NO. Si el día faltante aparece con otra serie, ésa es la causa.
#
#  Uso: pegar en PowerShell de la camioneta. Para otro rango, antes de pegar:
#     $desde = '2026-10-08'; $hasta = '2026-10-21'
#  El resultado queda también en C:\KeplerPush\diagnostico-series-<TRUCK>.txt
# =============================================================================
# ⛔ NADA de param(): esto se PEGA en una consola (ver DIAGNOSTICO-CAMIONETA.ps1).
if (-not $f)     { $f = 'C:\KeplerPush\push-ruta.cmd' }
if (-not $desde) { $desde = '2026-10-08' }
if (-not $hasta) { $hasta = '2026-10-21' }
$ErrorActionPreference = 'Continue'
function Mask($s) { if (-not $s) { return '(vacio)' }; return ($s -replace '://[^@]*@', '://***@') }
if (-not (Test-Path $f)) { Write-Host "ERROR: no existe $f" -f Red; return }
$t     = Get-Content $f -Raw -Encoding Default
$truck = [regex]::Match($t, '(?im)^\s*set\s+TRUCK\s*=\s*(\S+)').Groups[1].Value
$serie = [regex]::Match($t, '(?im)^\s*set\s+ROUTE_SERIE\s*=\s*(\S+)').Groups[1].Value
$src   = [regex]::Match($t, '(?im)^\s*set\s+SRC\s*=\s*(.+?)\s*$').Groups[1].Value
$psql  = $null
foreach ($r in @('C:\Program Files\PostgreSQL', 'C:\Program Files (x86)\PostgreSQL')) {
  if (-not $psql -and (Test-Path $r)) {
    $psql = Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
}
if (-not $psql) { $psql = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source }
if (-not $psql) { Write-Host 'NO SE ENCONTRO psql.exe' -f Red; return }
if (-not $src)  { Write-Host 'no encontre la linea set SRC= en el agente' -f Red; return }
if ($desde -notmatch '^\d{4}-\d{2}-\d{2}$' -or $hasta -notmatch '^\d{4}-\d{2}-\d{2}$') { Write-Host 'fechas: YYYY-MM-DD' -f Red; return }

$out = "C:\KeplerPush\diagnostico-series-$truck.txt"
$enc = @(
  "=== [RD.94] series de venta - $truck - $desde a $hasta - $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===",
  "  agente : $f",
  "  sube   : serie '$serie' tipo U-D-10 (lo demas NO sube)",
  "  base   : $(Mask $src)",
  "  reloj de la van: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')", ""
)
$enc | ForEach-Object { Write-Host $_ -f Cyan }

# Todos los documentos U-D (venta) del rango, por dia x serie x tipo, con su importe de
# renglones (kdm2.c13, la misma columna que sube el agente). c68 = fecha de CAPTURA: si
# difiere de c9 (fecha del documento), se ve.
$sql = @"
select h.c9::date as fecha,
       rtrim(btrim(h.c63),'-') as serie,
       h.c2||'-'||h.c3||'-'||h.c4 as tipo,
       count(distinct h.c6) as docs,
       min(h.c6) as folio_min, max(h.c6) as folio_max,
       to_char(coalesce(sum(d.c13::numeric),0),'FM999,999,990.00') as importe,
       string_agg(distinct h.c68::date::text, ',') as capturado,
       case when h.c4 = 10 and rtrim(btrim(h.c63),'-') = '$serie' then 'SUBE' else 'NO SUBE' end as agente
  from md.kdm1 h
  left join md.kdm2 d on d.c1=h.c1 and d.c2=h.c2 and d.c3=h.c3 and d.c4=h.c4 and d.c5=h.c5 and d.c6=h.c6
 where h.c2 = 'U' and h.c3 = 'D' and h.c9::date between '$desde' and '$hasta'
 group by 1,2,3,h.c4
 order by 1,2,3
"@
$res = & $psql -d $src -A -F ' | ' -P footer=off -c $sql 2>&1
$res | ForEach-Object { $l = $_.ToString(); if ($l -match 'NO SUBE') { Write-Host "  $l" -f Yellow } else { Write-Host "  $l" } }

# El consecutivo de la serie que sube: un salto o un reinicio es la huella de un cambio.
$sql2 = "select rtrim(btrim(c63),'-') as serie, c9::date as fecha, min(c6) as primero, max(c6) as ultimo, count(*) as docs from md.kdm1 where c2='U' and c3='D' and c4=10 and c9::date between '$desde' and '$hasta' group by 1,2 order by 1,2"
Write-Host "`n--- consecutivo por serie (U-D-10) ---" -f Cyan
$res2 = & $psql -d $src -A -F ' | ' -P footer=off -c $sql2 2>&1
$res2 | ForEach-Object { Write-Host "  $_" }

($enc + @('--- por dia x serie x tipo ---') + $res + @('', '--- consecutivo por serie (U-D-10) ---') + $res2) |
  ForEach-Object { $_.ToString() } | Set-Content -Path $out -Encoding UTF8
Write-Host "`nGuardado en $out - mandalo de vuelta tal cual." -f Green
