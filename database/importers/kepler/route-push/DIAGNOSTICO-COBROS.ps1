# =============================================================================
#  [RC.0] SONDA DE COBROS UA0501 EN LA CAMIONETA. SOLO LEE: no toca nada.
#
#  Edgar, 2026-10-12: *"necesito que saquemos los cobros PUE UA0501 de cada base
#  de datos de cada ruta... para sacar los cobros y se salden"*.
#
#  El push de camioneta ya empuja VENTAS, EXISTENCIA y MOVIMIENTOS. No empuja
#  COBROS -- y por eso la Fase CSU midio 1.5% cobrado sobre $4.53M de cortes de
#  caja POS: los cortes `UD2301` estan en la base de la plaza, pero el cobro
#  `UA0501` que los salda se captura en el Kepler LOCAL de la camioneta
#  (`//127.0.0.1/cobro.kpl`) y nunca sale de ahi.
#
#  ⛔ Esta sonda existe porque el esquema de la camioneta NO se adivina (regla 0
#  del proyecto). `kdm5` esta decodificado contra el ODS y contra la pantalla
#  real -- c2-c6 el cobro, c7-c11 el corte que salda, c12 importe, c14 la caja --
#  pero faltan cuatro cosas que solo se ven desde la laptop: los TIPOS de columna
#  (de ahi depende el JOIN; el ODS lo arma el shipper y `md.*` puede diferir),
#  cuantos cobros hay, a que cuenta de tesoreria van (`c45`: en la pantalla decia
#  "BAJIO 4166" -- si va a banco, el cobro NO es de Caja General) y si hace falta
#  filtrar por serie de ruta (`c63`).
#
#  ⛔ NADA de param(), NADA de here-strings y NADA de `return` al tope: esto se
#  PEGA en una consola. `param()` solo vale como primera instruccion de un script
#  y pegado revienta; un here-string exige su `"@` en la columna 0 y al pegarlo se
#  rompe. Por eso cada consulta va en UNA linea. Ya costo una vez: se entrego la
#  version con here-strings y en la camioneta no existia el archivo.
#
#  Se PEGA como UNA SOLA LINEA en PowerShell (abajo). Tambien corre como archivo:
#    powershell -ExecutionPolicy Bypass -File C:KeplerPushDIAGNOSTICO-COBROS.ps1
$f='C:\KeplerPush\push-ruta.cmd'; $t=Get-Content $f -Raw -Encoding Default; Write-Host "--- set del agente ---" -f Cyan; ([regex]::Matches($t,'(?im)^\s*set\s+.*$'))|%{Write-Host ("  "+($_.Value.Trim() -replace '://[^@]*@','://***@'))}; $SRC=([regex]::Match($t,'(?im)^\s*set\s+"?\s*SRC\s*=\s*([^"\r\n]*)')).Groups[1].Value.Trim().TrimEnd('"'); $TR=([regex]::Match($t,'(?im)^\s*set\s+"?\s*TRUCK\s*=\s*([^"\r\n]*)')).Groups[1].Value.Trim().TrimEnd('"'); $SER=([regex]::Match($t,'(?im)^\s*set\s+"?\s*ROUTE_SERIE\s*=\s*([^"\r\n]*)')).Groups[1].Value.Trim().TrimEnd('"'); $P=(Get-Command psql.exe -EA SilentlyContinue).Source; if(-not $P){$P='C:\Program Files\PostgreSQL\16\bin\psql.exe'}; Write-Host ("`nTRUCK: $TR  SERIE: $SER") -f Cyan; Write-Host ("SRC  : "+($SRC -replace '://[^@]*@','://***@')); if(-not $SRC){Write-Host 'SIN SRC: pegame las lineas de arriba' -f Red}else{$qs=@(@('1) TIPOS kdm1/kdm5',"select table_name,column_name,data_type from information_schema.columns where table_schema='md' and table_name in ('kdm1','kdm5') and column_name in ('c1','c2','c3','c4','c5','c6','c7','c8','c9','c10','c11','c12','c14','c45','c63') order by table_name,ordinal_position"),@('2) CUANTOS cobros',"select count(*) cobros, min(c9)::date desde, max(c9)::date hasta from md.kdm1 where btrim(c2)='U' and btrim(c3)='A' and btrim(c4::text)='5'"),@('3) MUESTRA cobro+corte',"select h.c6 cobro, h.c9::date fecha, h.c45 cuenta, h.c63 serie, btrim(a.c8::text)||'-'||btrim(a.c9::text)||'-'||btrim(a.c10::text) doc, a.c11 folio_corte, a.c12 importe, a.c14 referencia from md.kdm5 a join md.kdm1 h on btrim(h.c1)=btrim(a.c1) and btrim(h.c2)=btrim(a.c2) and btrim(h.c3)=btrim(a.c3) and btrim(h.c4::text)=btrim(a.c4::text) and btrim(h.c5::text)=btrim(a.c5::text) and btrim(h.c6)=btrim(a.c6) where btrim(a.c2)='U' and btrim(a.c3)='A' and btrim(a.c4::text)='5' order by h.c9 desc, h.c6 desc limit 12"),@('4) CUENTA c45',"select c45 cuenta, count(*) n, max(c9)::date ultima from md.kdm1 where btrim(c2)='U' and btrim(c3)='A' and btrim(c4::text)='5' group by 1 order by 2 desc"),@('5) SERIES c63',"select rtrim(btrim(c63),'-') serie, count(*) n from md.kdm1 where btrim(c2)='U' and btrim(c3)='A' and btrim(c4::text)='5' group by 1 order by 2 desc")); foreach($q in $qs){Write-Host ("`n--- "+$q[0]+" ---") -f Cyan; & $P "$SRC" -c $q[1] 2>&1|%{Write-Host ("  "+$_)}}; Write-Host "`n=== fin ===" -f Green}
