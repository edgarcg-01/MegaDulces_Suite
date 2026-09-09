/* eslint-disable no-console */
/**
 * `[W4.3]` CANDADO — ningún sensor de salud puede publicar una edad con el sesgo de 6 h.
 *
 * ── Qué protege ────────────────────────────────────────────────────────────────────────────
 * `DbHealthService` calcula la edad del dato **en JS** (`new Date(rows[0].last_update)` → `ageOf`).
 * Eso es correcto mientras el SQL devuelva un `timestamptz`: node-postgres lo convierte al instante
 * exacto. Si el SQL castea a `timestamp`, la zona se tira y queda el reloj de pared de la SESIÓN de
 * pg —en prod `Etc/UTC`, medido— que el driver reinterpreta como hora LOCAL del proceso, que corre
 * en `America/Mexico_City`. Resultado: la edad sale **exactamente 6.00 h más joven**.
 *
 * No es cosmético y ya estaba mordiendo (medido contra prod el 2026-09-07):
 *   · `stock_cedis_00` reportaba 29.44 h con la edad real en 35.44 h y `warnH: 30` → el warn
 *     estaba TAPADO por el sesgo, no apagado por sanidad;
 *   · `fleet_positions` tenía `warnH: 3` sobre un `timestamptz`, así que **no podía disparar** antes
 *     de las 9 h reales, y por debajo de 6 h publicaba edad negativa.
 *
 * ── Por qué un candado y no sólo el arreglo ────────────────────────────────────────────────
 * Es la clase de error que vuelve: cada sensor nuevo se escribe copiando al vecino, y el
 * `::timestamp` se ve inofensivo. Además **no se puede barrer con un sed**, y ése es el punto
 * delicado que este test codifica: hay 6 sensores donde el cast es correcto —uno de ellos,
 * `wincaja_cedis_stale`, porque su `timestamptz` guarda una fecha de NEGOCIO en medianoche UTC y el
 * cast la devuelve a medianoche MX—. Quitarlo ahí metería el error de 6 h en el sentido contrario.
 * Por eso el cast se permite, pero sólo **declarado con su motivo** en `CAST_JUSTIFICADO`.
 *
 * ── Los bloques ────────────────────────────────────────────────────────────────────────────
 *   1. ESTÁTICO (siempre corre, sin DB): ningún sensor castea `last_update` salvo los declarados,
 *      y ningún declarado dejó de castear (allowlist sin residuos). Con guarda anti-no-op: si el
 *      parseo deja de reconocer los sensores, el bloque FALLA en vez de pasar en vacío.
 *   2. DINÁMICO: se le pregunta al driver el OID que devuelve cada sensor. Sin cast → 1184
 *      (timestamptz). Declarado → 1114 (naive), consistente con su motivo.
 *   3. PRUEBA NEGATIVA: se rompe a propósito. Un sensor sintético con `::timestamp` tiene que ser
 *      detectado por el mismo predicado del bloque 1, y el sesgo se mide en vivo (`now()::timestamp`
 *      contra `now()`) para probar que son 6 h y no una teoría.
 *   4. Los sensores por-columna (`tsCandidates`, sin SQL propio) leen `max(col)` SIN cast, así que
 *      su edad sólo es válida si la columna es `timestamptz`. Se verifica el tipo de las 15.
 *
 * Read-only: no escribe una fila, por eso no lleva `assertSafeTarget` (esa guarda es para los tests
 * que ESCRIBEN, y aborta contra prod — que es justo donde este candado vale medirse).
 * Los sensores de `EXT_SOURCES` viven en otra DB (kepler_consolidado) y quedan fuera del bloque 2.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-db-health-tz-bias.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const ROOT = path.resolve(__dirname, '..', '..');
const SVC = path.join(ROOT, 'apps/api/src/modules/db-health/db-health.service.ts');
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();

const OID = { 1082: 'date', 1114: 'timestamp (naive)', 1184: 'timestamptz' };

/**
 * Sensores a los que se les PERMITE devolver `timestamp` naive, con el motivo medido.
 * Agregar una entrada acá es una decisión, no un trámite: exige haber verificado el tipo de la
 * columna de origen y qué reloj guarda.
 */
const CAST_JUSTIFICADO = {
  wincaja_cedis_stale:
    'timestamptz que NO guarda un instante sino una fecha de negocio en medianoche UTC '
    + '(3,586 de 3,586 filas de la rama 00 caen en 00:00 UTC, ninguna en 00:00 MX). El cast la '
    + 'devuelve a medianoche MX = la semántica que el sensor mide. Quitarlo envejece el dato 6 h más.',
  kepler_ods_00_stale: 'deriva de c9::date — un date, no un instante: el cast es redundante, no sesgado.',
  wincaja_feed: 'business_date es date (medido en pg_attribute) — cast redundante.',
  wincaja_branch_stale:
    'min(max(business_date)) sobre un date (medido) — cast redundante. Este sensor NO apareció en '
    + 'el primer barrido manual: el parser viejo lo saltaba por su comentario largo. Lo encontró '
    + 'este candado en su primera corrida, que es el argumento de por qué el candado existe.',
  sales_daily_date: 'sale_date es date (medido en pg_attribute) — cast redundante.',
  bank_recon_period: 'to_date(period) + 1 mes ya es naive por aritmética de fechas — cast redundante.',
};

let ok = 0; let fail = 0; let skip = 0;
const chk = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const nomedido = (msg) => { skip++; console.log(`  ◻ NO MEDIDO — ${msg}`); };

// ── Parseo del servicio ───────────────────────────────────────────────────────────────────
const SRC_FULL = fs.readFileSync(SVC, 'utf8');
/** Sólo APP_SOURCES: EXT_SOURCES apunta a otra DB. */
const iApp = SRC_FULL.indexOf('const APP_SOURCES');
const iExt = SRC_FULL.indexOf('const EXT_SOURCES');
const SRC = iApp >= 0 && iExt > iApp ? SRC_FULL.slice(iApp, iExt) : SRC_FULL;

/**
 * Parte `APP_SOURCES` en un tramo por sensor, cortando en cada `key:`. NO usa una ventana de N
 * caracteres entre `key:` y `sql:` — la primera versión de este parser sí, y al documentar los
 * arreglos los comentarios empujaron `sql:` fuera de la ventana: **desaparecieron del test justo
 * los 4 sensores que se acababan de tocar**, en silencio. Lo cazó la guarda anti-no-op del bloque 1,
 * que existe precisamente para eso. Un parser que se calla cuando no entiende se lee como "todo bien".
 */
function tramosPorSensor() {
  const re = /key:\s*'([a-z0-9_]+)'/g;
  const marcas = [];
  let m;
  while ((m = re.exec(SRC))) marcas.push({ key: m[1], i: m.index });
  return marcas.map((x, n) => ({
    key: x.key,
    texto: SRC.slice(x.i, n + 1 < marcas.length ? marcas[n + 1].i : SRC.length),
  }));
}

function sensoresConSql() {
  const out = [];
  for (const t of tramosPorSensor()) {
    const i = t.texto.indexOf('sql:');
    if (i < 0) continue;
    const a = t.texto.indexOf('`', i);
    const b = a >= 0 ? t.texto.indexOf('`', a + 1) : -1;
    if (a < 0 || b < 0) continue;
    out.push({ key: t.key, sql: t.texto.slice(a + 1, b) });
  }
  return out;
}

function sensoresPorColumna() {
  const out = [];
  for (const t of tramosPorSensor()) {
    const mt = t.texto.match(/table:\s*'([a-z_0-9.]+)'/);
    const mc = t.texto.match(/tsCandidates:\s*\[([^\]]*)\]/);
    const mw = t.texto.match(/warnH:\s*([\d.]+)/);
    if (!mt || !mc) continue;
    const cands = mc[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    if (cands.length) out.push({ key: t.key, table: mt[1], cands, warnH: mw ? Number(mw[1]) : null });
  }
  return out;
}

/**
 * El PREDICADO del candado: ¿la expresión que este sensor devuelve como last_update está casteada
 * a timestamp? Mira sólo el tramo hasta "AS last_update" — un ::timestamp en note_extra o en un
 * WHERE es irrelevante para la edad.
 */
function casteaLastUpdate(sql) {
  const i = sql.search(/AS\s+last_update/i);
  if (i < 0) return false;
  return /::\s*timestamp\b(?!\s*with)/i.test(sql.slice(0, i));
}

(async () => {
  const conSql = sensoresConSql();
  const porCol = sensoresPorColumna();

  console.log('\n[1] ESTÁTICO — el cast sólo existe donde está declarado con su motivo');
  // Guarda anti-no-op: un parseo que no reconoce nada se lee igual que "no hay casts".
  chk(conSql.length >= 12, `el parseo reconoce ${conSql.length} sensores con SQL propio (se esperan >= 12)`);
  chk(porCol.length >= 14, `el parseo reconoce ${porCol.length} sensores por-columna (se esperan >= 14)`);
  chk(conSql.some((s) => casteaLastUpdate(s.sql)),
    'el predicado encuentra al menos un cast en el archivo real (si no, no está midiendo nada)');

  const castean = conSql.filter((s) => casteaLastUpdate(s.sql)).map((s) => s.key);
  const indebidos = castean.filter((k) => !CAST_JUSTIFICADO[k]);
  chk(indebidos.length === 0,
    indebidos.length === 0
      ? `ningún sensor castea last_update sin declararlo (${castean.length} declarados)`
      : `SESGO DE 6 h sin declarar en: ${indebidos.join(', ')} — quitá el ::timestamp o declaralo en CAST_JUSTIFICADO con el tipo medido`);

  const residuos = Object.keys(CAST_JUSTIFICADO).filter((k) => !castean.includes(k));
  chk(residuos.length === 0,
    residuos.length === 0
      ? 'el allowlist no tiene residuos (todo lo declarado sigue casteando)'
      : `allowlist con residuos: ${residuos.join(', ')} ya no castea — sacá la entrada para que la lista siga siendo verdad`);

  console.log('\n[3] PRUEBA NEGATIVA — el predicado detecta lo que tiene que detectar');
  chk(casteaLastUpdate("SELECT max(x)::timestamp AS last_update, 'n' AS note_extra FROM t"),
    'un sensor sintético con max(x)::timestamp AS last_update es detectado');
  chk(!casteaLastUpdate("SELECT max(x) AS last_update, to_char(y::timestamp,'DD/MM') AS note_extra FROM t"),
    'un ::timestamp que sólo está en note_extra NO se marca (el predicado no es un grep ciego)');
  chk(!casteaLastUpdate('SELECT max(x)::timestamp with time zone AS last_update FROM t'),
    'un cast a timestamp with time zone NO se marca');

  // ── Bloques con DB ──────────────────────────────────────────────────────────────────────
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000,
    statement_timeout: 150000,
  });
  try {
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) {
      console.log('\n[2][4] con DB');
      nomedido(`no se pudo conectar (${e.code || e.message}) — el bloque estático ya corrió`);
      console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
      if (fail) process.exit(1);
      return noMedido('sin DB no se puede preguntar el OID que devuelve cada sensor');
    }
    throw e;
  }

  const tz = (await c.query('SHOW timezone')).rows[0].TimeZone;
  console.log(`\n[3b] PRUEBA NEGATIVA EN VIVO — sesión pg en ${tz}, proceso en ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  const bias = (await c.query('SELECT now() AS tz, now()::timestamp AS naive')).rows[0];
  const hTz = (Date.now() - new Date(bias.tz).getTime()) / 3600000;
  const hNaive = (Date.now() - new Date(bias.naive).getTime()) / 3600000;
  const sesgo = hTz - hNaive;
  chk(Math.abs(hTz) < 0.05, `sin cast, la edad de "ahora" es 0 (${hTz.toFixed(3)} h)`);
  chk(Math.abs(sesgo) > 0.5,
    `con cast, "ahora" aparenta ${hNaive.toFixed(2)} h → el sesgo es REAL y vale ${sesgo.toFixed(2)} h (no es una teoría)`);

  console.log('\n[2] DINÁMICO — el OID que cada sensor le entrega al driver');
  for (const s of conSql) {
    let r;
    try {
      r = await c.query(s.sql);
    } catch (e) {
      nomedido(`${s.key}: su SQL no corre en esta DB (${e.code || e.message.slice(0, 40)})`);
      continue;
    }
    const f = r.fields.find((x) => x.name === 'last_update');
    if (!f) { chk(false, `${s.key}: su SQL no devuelve una columna last_update`); continue; }
    const tipo = OID[f.dataTypeID] || `oid ${f.dataTypeID}`;
    if (CAST_JUSTIFICADO[s.key]) {
      chk(f.dataTypeID === 1114, `${s.key}: devuelve ${tipo} — declarado, y el motivo sigue aplicando`);
    } else {
      chk(f.dataTypeID === 1184,
        f.dataTypeID === 1184
          ? `${s.key}: devuelve timestamptz → la edad en JS es el instante exacto`
          : `${s.key}: devuelve ${tipo} y NO está declarado → la edad publicada sale 6 h más joven`);
    }
  }

  console.log('\n[4] Sensores por-columna — max(col) sin cast exige columna timestamptz');
  for (const s of porCol) {
    const [sch, tab] = s.table.split('.');
    const { rows: cols } = await c.query(
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) t
         FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = k.relnamespace
        WHERE n.nspname = $1 AND k.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`, [sch, tab]);
    if (!cols.length) { nomedido(`${s.key}: ${s.table} no existe en esta DB`); continue; }
    const map = new Map(cols.map((x) => [x.attname, x.t]));
    const col = s.cands.find((x) => map.has(x));
    if (!col) { chk(false, `${s.key}: ninguna de sus columnas candidatas (${s.cands.join('/')}) existe en ${s.table}`); continue; }
    const t = map.get(col);
    chk(/with time zone/.test(t), `${s.key}: ${s.table}.${col} es ${t}`);
  }

  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail) process.exit(1);
  if (ok === 0) return noMedido('no se pudo comprobar nada');
  return undefined;
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
