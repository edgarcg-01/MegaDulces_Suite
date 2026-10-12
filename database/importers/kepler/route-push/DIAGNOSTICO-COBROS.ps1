# =============================================================================
#  [RC.0] SONDA DE COBROS UA0501 EN LA CAMIONETA. Se pega tal cual. SOLO LEE.
#
#  Edgar, 2026-10-12: *"necesito que saquemos los cobros PUE UA0501 de cada base
#  de datos de cada ruta... para sacar los cobros y se salden"*.
#
#  El push de camioneta ya existe y ya empuja VENTAS, EXISTENCIA y MOVIMIENTOS
#  (`push-ruta.v2.template.cmd`). Lo que NO empuja son los COBROS -- y por eso la
#  Fase CSU midio **1.5% cobrado** sobre $4.53M de cortes de caja (1-5 oct): los
#  cortes `UD2301` SI estan en la plaza, pero el cobro `UA0501` que los salda se
#  captura en el Kepler LOCAL de la camioneta (`//127.0.0.1/cobro.kpl`) y nunca
#  sale de ahi.
#
#  ⛔ Esta sonda existe porque el esquema de la camioneta NO se adivina. Las
#  columnas de `kdm5` estan decodificadas contra el ODS y contra la pantalla real
#  (c2-c6 = el cobro · c7-c11 = el corte que salda · c12 = importe · c14 = caja),
#  pero faltan CUATRO cosas que solo se pueden ver desde la laptop:
#
#    1. ¿Los TIPOS de columna son los mismos que en el ODS? (el ODS lo arma el
#       shipper; `md.*` local puede diferir, y de eso depende el JOIN).
#    2. ¿El cobro trae `c63` (la serie de ruta) como la venta, o no hace falta
#       filtrar porque la laptop solo tiene lo suyo?
#    3. ¿Que trae `c45` (la cuenta de tesoreria)? En la pantalla decia
#       "BAJIO 4166" -- si va a banco y no a caja, el cobro NO es de Caja General.
#    4. ¿Cuantos cobros hay y desde cuando? Decide la ventana del push.
#
#  Correr:  pegar en PowerShell EN LA CAMIONETA.
# =============================================================================
$ErrorActionPreference = 'Continue'
function Mask($s) { if (-not $s) { return '(vacio)' }; return ($s -replace '://[^@]*@', '://***@') }

# --- de donde sale la conexion: del propio agente, para no re-teclear la clave ---
if (-not $f) { $f = 'C:\KeplerPush\push-ruta.cmd' }
if (-not (Test-Path $f)) { $f = 'C:\KeplerPush\push-ruta.v2.cmd' }
if (-not (Test-Path $f)) { Write-Host "ERROR: no encuentro el agente en C:\KeplerPush" -f Red; return }
$t   = Get-Content $f -Raw -Encoding Default
$SRC = [regex]::Match($t, '(?im)^\s*set\s+SRC\s*=\s*(\S+)').Groups[1].Value
$TR  = [regex]::Match($t, '(?im)^\s*set\s+TRUCK\s*=\s*(\S+)').Groups[1].Value
$SER = [regex]::Match($t, '(?im)^\s*set\s+ROUTE_SERIE\s*=\s*(\S+)').Groups[1].Value
$PSQL = (Get-Command psql.exe -ErrorAction SilentlyContinue).Source
if (-not $PSQL) {
  foreach ($r in @('C:\Program Files\PostgreSQL','C:\Program Files (x86)\PostgreSQL')) {
    if (Test-Path $r) { $PSQL = (Get-ChildItem $r -Directory -EA SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'bin\psql.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1) }
  }
}
Write-Host "`n=== SONDA DE COBROS ===" -f Cyan
Write-Host ("  agente : " + $f)
Write-Host ("  TRUCK  : " + $TR + "   ROUTE_SERIE: " + $SER)
Write-Host ("  SRC    : " + (Mask $SRC))
Write-Host ("  psql   : " + $(if ($PSQL) { $PSQL } else { 'NO ENCONTRADO' }))
if (-not $PSQL -or -not $SRC) { Write-Host "falta psql o SRC: no se puede sondear" -f Red; return }

function Q($titulo, $sql) {
  Write-Host "`n--- $titulo ---" -f Cyan
  & $PSQL "$SRC" -c $sql 2>&1 | ForEach-Object { Write-Host ("  " + $_) }
}

# 1) TIPOS -- de esto depende el JOIN. No se asume: se pregunta.
Q "1) tipos de kdm1 y kdm5 (las columnas que usa el push)" @"
select table_name, column_name, data_type
  from information_schema.columns
 where table_schema='md' and ((table_name='kdm5' and column_name in ('c1','c2','c3','c4','c5','c6','c7','c8','c9','c10','c11','c12','c14'))
    or (table_name='kdm1' and column_name in ('c1','c2','c3','c4','c5','c6','c9','c45','c63')))
 order by table_name, ordinal_position
"@

# 2) ¿HAY cobros, y desde cuando? Decide la ventana del push.
Q "2) cobros U-A-5 en esta laptop" @"
select count(*) as cobros, min(c9)::date as desde, max(c9)::date as hasta
  from md.kdm1 where c2='U' and c3='A' and c4=5
"@

# 3) La MUESTRA: el cobro con lo que salda. Si esto sale, el push es una linea mas.
Q "3) ultimos cobros con el corte que saldan (kdm1 join kdm5)" @"
select h.c6 as cobro, h.c9::date as fecha, h.c45 as cuenta, h.c63 as serie,
       a.c8||'-'||a.c9||'-'||a.c10 as doc_tipo, a.c11 as folio_corte,
       a.c12 as importe, a.c14 as referencia
  from md.kdm5 a
  join md.kdm1 h on h.c1=a.c1 and h.c2=a.c2 and h.c3=a.c3
                and h.c4::text=a.c4::text and h.c5=a.c5 and h.c6=a.c6
 where a.c2='U' and a.c3='A' and a.c4::text='5'
 order by h.c9 desc, h.c6 desc
 limit 12
"@

# 4) ¿A CAJA o a BANCO? En la pantalla decia "BAJIO 4166" -- si todo va a banco,
#    el cobro no entra por Caja General y el destino en prod es otro.
Q "4) a que cuenta de tesoreria van (c45)" @"
select c45 as cuenta, count(*) as n, max(c9)::date as ultima
  from md.kdm1 where c2='U' and c3='A' and c4=5 group by 1 order by 2 desc
"@

# 5) ¿La laptop tiene SOLO lo suyo? Si aparece mas de una serie, el push filtra.
Q "5) series de ruta presentes (c63) -- decide si hace falta filtrar" @"
select rtrim(btrim(c63),'-') as serie, count(*) as n
  from md.kdm1 where c2='U' and c3='A' and c4=5 group by 1 order by 2 desc
"@

Write-Host "`n=== fin. Pegar la salida completa. ===" -f Green
