/* eslint-disable no-console */
/**
 * ⭐⭐ `[CGA-A.12]` — **El `.cmd` de la camioneta se GENERA y se VERIFICA. Ya no se pega.**
 *
 *   node database/importers/kepler/route-push/armar-push-camioneta.js --truck ruta_21 --serie UD1001
 *   node database/importers/kepler/route-push/armar-push-camioneta.js --verificar C:\KeplerPush\push-ruta.cmd
 *   node database/importers/kepler/route-push/armar-push-camioneta.js --self-test
 *
 * No toca la red ni ninguna base. **Nunca escribe ni imprime una credencial**: el archivo sale
 * con marcadores `<CLAVE_LOCAL>` / `<CLAVE_RUNNER>` y se llenan en la máquina, fuera del repo.
 *
 * ── Por qué existe, medido el 2026-10-16 ───────────────────────────────────────────────────
 *
 * En un solo día hubo **cuatro parches sobre el mismo carril**, y tres salían de la misma causa:
 * **cada camioneta es un archivo distinto que nadie valida.**
 *
 *  1. El bloque de cobros **no estaba en ninguna plantilla** — vivía en un `.snippet` que había
 *     que acordarse de pegar «antes del `endlocal`».
 *  2. Las variables de conexión **no coincidían**: el repo decía `%SRC%`/`%DST%` y las máquinas
 *     desplegadas usaban `%LOCAL_CONN%`/`%RUNNER_CONN%`. Un bloque pegado del repo en una
 *     máquina vieja apunta a una variable **vacía**, y `psql` con cadena vacía **no grita**.
 *  3. Un `connect_timeout` ausente dejó a `ruta_23` en «tiempo de espera agotado».
 *
 * ⛔ Y el censo del día lo dijo entero: **11 camionetas empujan VENTAS y 4 empujaban COBROS.**
 * Ninguna estaba rota. Les faltaba el bloque. Lo mide `npm run check:camioneta-sin-cobro`.
 *
 * ⭐ **La verificación es la mitad que vale.** Generar está bien, pero lo desplegado ya existe y
 * nadie lo puede mirar desde acá: `--verificar` recibe el archivo REAL de una máquina y dice qué
 * le falta, en vez de suponer que es igual a la plantilla.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RUNNER_HOST = '192.168.0.222';
const RUNNER_PORT = '5433';

const arg = (nombre) => {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : null;
};

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * 1. LA PLANTILLA — una sola, con los CUATRO bloques. No hay snippet que pegar.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

function plantilla({ truck, serie, dias }) {
  return `@echo off
REM ============================================================================
REM  PUSH de camioneta v3 — GENERADO, NO ESCRITO A MANO.
REM
REM    node database/importers/kepler/route-push/armar-push-camioneta.js \\
REM         --truck ${truck} --serie ${serie} --dias ${dias}
REM
REM  ⛔ NO EDITAR A MANO. Si hace falta un cambio, va en el generador y se
REM     regenera: un archivo editado a mano es el defecto que [CGA-A.12] cierra.
REM     Para comprobar que lo desplegado sigue siendo esto:
REM       node ...\\armar-push-camioneta.js --verificar C:\\KeplerPush\\push-ruta.cmd
REM
REM  Copiar a C:\\KeplerPush\\push-ruta.cmd (FUERA del repo: lleva credenciales)
REM  y llenar SOLO los <CLAVE_...>. Una camioneta = un archivo + una tarea.
REM
REM  Cuatro bloques, y los cuatro son obligatorios:
REM    1) VENTAS       -> ingest.route_sales_stg       -> merge_route_sales
REM    2) EXISTENCIA   -> ingest.route_stock_stg       -> merge_route_stock
REM    3) COBROS       -> ingest.route_collections_stg -> merge_route_collections
REM  El heartbeat de cada carril lo escribe su propio merge en el runner.
REM ============================================================================
setlocal
set PGCLIENTENCODING=UTF8

REM ===== CONFIG (por camioneta) ===============================================
set PSQL=
if exist "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe" set PSQL="C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe"
if not defined PSQL if exist "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe" set PSQL="C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe"
if not defined PSQL if exist "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe" set PSQL="C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe"
if not defined PSQL if exist "C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe" set PSQL="C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe"
if not defined PSQL if exist "C:\\Program Files\\PostgreSQL\\14\\bin\\psql.exe" set PSQL="C:\\Program Files\\PostgreSQL\\14\\bin\\psql.exe"

set TRUCK=${truck}
set DAYS=${dias}
set ROUTE_SERIE=${serie}

REM  ⛔ [VL.7.6] EL RUNNER ES ${RUNNER_HOST} (el servidor Linux \`md\`), NO 192.168.0.249.
REM  El :5433 de .249 sobrevive como reenvio TCP, asi que una van mal dada de alta FUNCIONA
REM  y por eso el error no se ve. Alta nueva => ${RUNNER_HOST} directo.
REM
REM  ⚠️ \`connect_timeout=5\` NO es cosmetico: sin el, una red lenta deja el push colgado y el
REM  log dice "tiempo de espera agotado" sin que nadie lo mire. Paso en ruta_23 el 2026-10-16.
set SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>?connect_timeout=5
set DST=postgresql://postgres:<CLAVE_RUNNER>@${RUNNER_HOST}:${RUNNER_PORT}/kepler_consolidado?connect_timeout=5

set LOG=C:\\KeplerPush\\push_%TRUCK%.log
REM ============================================================================

if not defined PSQL echo [%date% %time%] ERROR: psql.exe no encontrado >> "%LOG%"
if not defined PSQL goto :eof

REM 0) PRECHECK: el runner responde? Si no, salir rapido (se reintenta al reconectar).
%PSQL% "%DST%" -tAc "select 1" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] OFFLINE: runner ${RUNNER_HOST} no alcanzable; se reintenta al reconectar >> "%LOG%"
  goto :eof
)
echo [%date% %time%] --- ONLINE, push %TRUCK% (serie %ROUTE_SERIE%) --- >> "%LOG%"

REM ===========================================================================
REM  BLOQUE 1 — VENTAS
REM  Si la base tiene VARIAS rutas, el filtro por %ROUTE_SERIE% es OBLIGATORIO
REM  (si no, doble conteo). Verificar la serie con:
REM    %PSQL% "%SRC%" -c "select distinct rtrim(btrim(c63),'-') from md.kdm1 where c4=10 and c2='U' and c3='D'"
REM ===========================================================================
%PSQL% "%DST%" -c "delete from ingest.route_sales_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

%PSQL% "%SRC%" -c "\\copy (select '%TRUCK%',h.c1,h.c6,h.c9::date,h.c10,d.c8,d.c10,d.c11,d.c9::numeric,d.c12::numeric,d.c13::numeric from md.kdm2 d join md.kdm1 h on h.c1=d.c1 and h.c2=d.c2 and h.c3=d.c3 and h.c4=d.c4 and h.c5=d.c5 and h.c6=d.c6 where d.c2='U' and d.c3='D' and h.c4=10 and rtrim(btrim(h.c63),'-')='%ROUTE_SERIE%' and h.c9>=current_date-%DAYS%) to stdout csv" | %PSQL% "%DST%" -c "\\copy ingest.route_sales_stg (truck,almacen,folio,fecha,forma_pago,sku,producto,unidad,cantidad,precio_neto,importe) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge ventas -^> filas: >> "%LOG%"
%PSQL% "%DST%" -c "select ingest.merge_route_sales('%TRUCK%', %DAYS%)" >> "%LOG%" 2>&1

REM ===========================================================================
REM  BLOQUE 2 — EXISTENCIA  [RD.32]
REM  Kepler CENTRAL no publica saldo de ruta; el Kepler DE ESTA LAPTOP si.
REM  Columnas verificadas contra el ODS, NO adivinadas:
REM    kdii.c1=SKU  kdii.c2=descripcion  kdii.c11=unidad
REM    kdik.c2=SKU  kdik.c5=existencia   kdik.c16=costo
REM  OJO: existencia > 0 (el catalogo trae miles en cero) y es una FOTO del
REM  momento: el merge REEMPLAZA la del dia, no acumula.
REM ===========================================================================
%PSQL% "%DST%" -c "delete from ingest.route_stock_stg where truck='%TRUCK%'" >> "%LOG%" 2>&1

%PSQL% "%SRC%" -c "\\copy (select '%TRUCK%',btrim(k.c2),btrim(i.c2),btrim(i.c11),k.c5::numeric,k.c16::numeric,(k.c5*k.c16)::numeric from md.kdik k join md.kdii i on btrim(i.c1)=btrim(k.c2) where k.c5 > 0) to stdout csv" | %PSQL% "%DST%" -c "\\copy ingest.route_stock_stg (truck,sku,producto,unidad,existencia,costo,importe) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge existencia -^> filas: >> "%LOG%"
%PSQL% "%DST%" -c "select ingest.merge_route_stock('%TRUCK%')" >> "%LOG%" 2>&1

REM ===========================================================================
REM  BLOQUE 3 — COBROS UA0501  [RC.2]
REM
REM  El push mandaba VENTAS y EXISTENCIA, no COBROS, y por eso la Fase CSU midio
REM  1.5% cobrado sobre $4.53M de cortes POS: los cortes UD2301 se ven y el cobro
REM  UA0501 que los salda se captura aca y nunca salia.
REM
REM  ⛔⛔ EL FILTRO DE ALMACEN NO ES OPCIONAL. Medido en ruta_27 el 2026-10-12:
REM      md.kdm1  almacen 00      16,641 cobros  <- CEDIS, ajenos
REM               almacen 01-005       9 cobros  <- lo propio de esta camioneta
REM  Sin \`btrim(h.c1)=<almacen propio>\` esto mandaria 16,641 cobros ajenos Y
REM  DUPLICADOS (ya llegan a prod por el ODS desde md_00). El almacen se deriva
REM  del nombre de la base: md_01-005 -> 01-005.
REM
REM  ⚠️ c63 NO sirve para filtrar: vale 'UA0501' en los 16,650 -- es la SERIE.
REM
REM  El grano es la APLICACION (cobro x corte), no el encabezado: es N:M de
REM  verdad -- un cobro se parte entre cortes y un corte recibe varios cobros.
REM  Guardar solo la cabecera daria el total sin poder decir QUE corte quedo
REM  saldado, que es justo lo que se necesita.
REM
REM  ⚠️ Todo con btrim(x::text): los tipos estan mezclados y asumir uno rompe el
REM  JOIN EN SILENCIO -- devolveria cero filas, que se lee igual que "no hay".
REM
REM  NO se filtra por cuenta: van los de caja (0011) y los de banco (2169). La
REM  cuenta viaja en su columna y se separa del otro lado.
REM ===========================================================================
%PSQL% "%DST%" -v ON_ERROR_STOP=1 -c "DELETE FROM ingest.route_collections_stg WHERE truck='%TRUCK%'" 2>>"%LOG%"

%PSQL% "%SRC%" -v ON_ERROR_STOP=1 -c "\\copy (select '%TRUCK%', btrim(h.c1::text), btrim(h.c6::text), h.c9::date, btrim(h.c45::text), btrim(a.c8::text)||'-'||btrim(a.c9::text)||'-'||btrim(a.c10::text), btrim(a.c11::text), a.c12::numeric, btrim(a.c14::text) from md.kdm5 a join md.kdm1 h on btrim(h.c1::text)=btrim(a.c1::text) and btrim(h.c2::text)=btrim(a.c2::text) and btrim(h.c3::text)=btrim(a.c3::text) and btrim(h.c4::text)=btrim(a.c4::text) and btrim(h.c5::text)=btrim(a.c5::text) and btrim(h.c6::text)=btrim(a.c6::text) where btrim(a.c2::text)='U' and btrim(a.c3::text)='A' and btrim(a.c4::text)='5' and btrim(h.c1::text)=regexp_replace(current_database(),'^md_','') and h.c9 >= current_date - %DAYS%) to stdout csv" | %PSQL% "%DST%" -v ON_ERROR_STOP=1 -c "\\copy ingest.route_collections_stg (truck,almacen,cobro_folio,fecha,cuenta,doc_tipo,folio_corte,importe,referencia) from stdin csv" >> "%LOG%" 2>&1

echo [%date% %time%] merge cobros -^> filas: >> "%LOG%"
%PSQL% "%DST%" -tAc "SELECT ingest.merge_route_collections('%TRUCK%')" >> "%LOG%" 2>&1

echo [%date% %time%] OK %TRUCK% >> "%LOG%"

endlocal
`;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * 2. LA VERIFICACIÓN — la mitad que vale. Cada regla costó algo.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * ⭐ `conexion` es la regla que cierra el incidente del día: un bloque pegado del repo usa
 * `%SRC%`/`%DST%`, y la máquina vieja define `%LOCAL_CONN%`/`%RUNNER_CONN%`. `psql` con una
 * variable vacía **no grita**, así que el bloque "corre" y no manda nada.
 */
const REGLAS = [
  { id: 'ventas', texto: 'manda VENTAS', ok: (s) => /route_sales_stg/.test(s) && /merge_route_sales/.test(s) },
  { id: 'existencia', texto: 'manda EXISTENCIA', ok: (s) => /route_stock_stg/.test(s) && /merge_route_stock/.test(s) },
  { id: 'cobros', texto: 'manda COBROS', ok: (s) => /route_collections_stg/.test(s) && /merge_route_collections/.test(s) },
  {
    id: 'filtro_almacen',
    texto: 'el bloque de cobros filtra por ALMACÉN propio',
    ok: (s) => !/route_collections_stg/.test(s) || /regexp_replace\(current_database\(\)/.test(s),
    duele: 'sin esto manda 16,641 cobros del CEDIS atribuidos a esta ruta, y duplicados',
  },
  {
    id: 'conexion',
    texto: 'toda variable de conexión USADA está DEFINIDA en el mismo archivo',
    ok: (s) => variablesHuerfanas(s).length === 0,
    detalle: (s) => `usa ${variablesHuerfanas(s).map((v) => '%' + v + '%').join(', ')} y no la define`,
    duele: 'psql con una cadena vacía no grita: el bloque "corre" y no manda nada',
  },
  {
    id: 'runner',
    texto: `el runner es ${RUNNER_HOST}, no .249`,
    ok: (s) => !/192\.168\.0\.249/.test(codigo(s)),
    duele: '.249 sobrevive como reenvío TCP, así que la van mal dada de alta FUNCIONA y nadie ve el error',
  },
  {
    id: 'timeout',
    texto: 'las cadenas llevan connect_timeout',
    ok: (s) => codigo(s).split(/\r?\n/).filter((l) => /postgresql:\/\//.test(l))
      .every((l) => /connect_timeout=/.test(l)),
    duele: 'sin él, una red lenta deja el push colgado («tiempo de espera agotado», ruta_23)',
  },
];

/**
 * ⚠️ **Las reglas que buscan algo PROHIBIDO tienen que mirar el código, no los comentarios.**
 * La primera versión de esta compuerta salió roja sobre su propia plantilla: el `REM` que
 * explica por qué el runner NO es `.249` **contiene** `192.168.0.249`. Un archivo correcto
 * marcado como malo se apaga el primer día.
 */
function codigo(s) {
  return s.split(/\r?\n/).filter((l) => !/^\s*(REM\b|::)/i.test(l)).join('\n');
}

/** Variables `%X%` usadas en una cadena de conexión que el archivo nunca hace `set X=`. */
function variablesHuerfanas(s) {
  const definidas = new Set();
  for (const m of s.matchAll(/^\s*set\s+([A-Za-z_]\w*)\s*=/gim)) definidas.add(m[1].toUpperCase());
  const usadas = new Set();
  // Sólo las que aparecen como destino de psql: `%PSQL% "%X%"` o `%PSQL% -d "%X%"`.
  for (const m of s.matchAll(/%PSQL%\s+(?:-d\s+)?"%([A-Za-z_]\w*)%"/gi)) usadas.add(m[1].toUpperCase());
  return [...usadas].filter((v) => !definidas.has(v));
}

function verificar(texto, etiqueta) {
  console.log(`\n[CGA-A.12] Verificando ${etiqueta}\n`);
  let malas = 0;
  for (const r of REGLAS) {
    if (r.ok(texto)) { console.log(`  ✓ ${r.texto}`); continue; }
    malas++;
    console.log(`  ✗ ${r.texto}`);
    if (r.detalle) console.log(`      ${r.detalle(texto)}`);
    if (r.duele) console.log(`      → ${r.duele}`);
  }
  console.log('');
  if (malas) {
    console.log(`⛔ ${malas} regla(s) incumplidas. Regenerá el archivo en vez de parcharlo:`);
    console.log('   node database/importers/kepler/route-push/armar-push-camioneta.js --truck <ruta> --serie <UDxxxx>\n');
    return 1;
  }
  console.log('✓ El archivo tiene los tres carriles y sus candados.\n');
  return 0;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * 3. Prueba negativa — una compuerta que nunca se vio en rojo es una intención.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

function selfTest() {
  const bueno = plantilla({ truck: 'ruta_21', serie: 'UD1001', dias: 15 });
  const fallas = [];
  const corre = (s) => REGLAS.filter((r) => !r.ok(s)).map((r) => r.id);

  const sano = corre(bueno);
  if (sano.length) fallas.push(`la plantilla propia incumple: ${sano.join(', ')}`);

  /** Cada mutación rompe UNA cosa, y tiene que salir esa y no otra. */
  const casos = [
    ['cobros', bueno.replace(/route_collections_stg/g, 'route_collections_XXX')
                    .replace(/merge_route_collections/g, 'merge_route_XXX')],
    ['filtro_almacen', bueno.replace(/regexp_replace\(current_database\(\)[^)]*\)[^ ]*/, "'01-005'")],
    ['conexion', bueno.replace(/^set SRC=/m, 'set LOCAL_CONN=')],
    ['runner', bueno.replace(/192\.168\.0\.222/g, '192.168.0.249')],
    ['timeout', bueno.replace(/\?connect_timeout=5/g, '')],
  ];

  console.log('\n[self-test] Cada mutación rompe UNA regla, y tiene que salir ESA.\n');
  for (const [esperada, mutado] of casos) {
    const rotas = corre(mutado);
    const bien = rotas.includes(esperada);
    console.log(`  ${bien ? '✓' : '✗'} romper «${esperada}» → detecta: ${rotas.join(', ') || 'NADA'}`);
    if (!bien) fallas.push(`romper ${esperada} no la detecta`);
  }

  console.log('');
  if (fallas.length) { for (const f of fallas) console.log(`  ✗ ${f}`); console.log(''); return 1; }
  console.log('✓ prueba negativa: la plantilla propia pasa las 7 reglas, y las 5 mutaciones caen.\n');
  return 0;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────*/

if (process.argv.includes('--self-test')) process.exit(selfTest());

const aVerificar = arg('--verificar');
if (aVerificar) {
  const p = path.resolve(aVerificar);
  if (!fs.existsSync(p)) { console.error(`⛔ no existe: ${p}`); process.exit(1); }
  process.exit(verificar(fs.readFileSync(p, 'utf8'), p));
}

const truck = arg('--truck');
const serie = arg('--serie');
if (!truck || !serie) {
  console.error('uso: --truck ruta_21 --serie UD1001 [--dias 15] [--salida <archivo>]');
  console.error('     --verificar <archivo.cmd>   |   --self-test');
  process.exit(1);
}
const dias = Number(arg('--dias') || 15);
const texto = plantilla({ truck, serie, dias });
const salida = arg('--salida');
if (salida) {
  fs.writeFileSync(path.resolve(salida), texto);
  console.log(`✓ escrito ${path.resolve(salida)} — falta llenar <CLAVE_LOCAL>, <CLAVE_RUNNER> y <DB_LOCAL>.`);
} else {
  process.stdout.write(texto);
}
