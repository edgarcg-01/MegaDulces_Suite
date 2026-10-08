/* eslint-disable no-console */
/**
 * `[RD.50]` CANDADO: **cada clave de `totalesDeCorrida()` tiene que ser una columna de
 * `commercial.commission_runs`.**
 *
 * ── El defecto que esto cierra, medido contra prod el 2026-10-08 ────────────────────────────
 *  · `commercial.commission_runs`: **0 filas. Nunca tuvo ninguna**, ni borradas.
 *  · Log de la API, 11:16:07 — alguien apretó "Calcular desde Q1":
 *      `20 cerrada(s) · 0 calculada(s) · 0 saltada(s) · 20 falla(s) · 248,596 ms`
 *  · La falla, reproducida en una transacción revertida:
 *      `42703: column "dias_multifuente" of relation "commission_runs" does not exist`
 *  · `persist()` hace `...totals` dentro del `INSERT`. Falló el **100 %** de las veces, para
 *    toda quincena, desde `c4dff2b04` (PR #303), y nadie lo vio durante días.
 *
 * ⛔ **Por qué el candado que ya existía no podía verlo.** `commission-inmutable.spec.ts` llama
 * `persist(trx, 't1', PERIODO, ESCALA, {}, [], ctx)` — **`{}` como totales**, y sobre dobles de
 * knex. El propio archivo advierte en su línea 17 que no ejecuta SQL. Un doble jamás devuelve
 * un `42703`, y un objeto vacío no tiene claves que contradigan nada.
 *
 * ⭐ Este archivo carga la función **REAL** vía `ts-node` (no una copia: una copia se
 * desincroniza y el test se queda verde midiendo código que ya nadie corre) y la contrasta
 * contra el **catálogo real** de Postgres.
 *
 * ⚠️ Lo que este candado NO cubre, dicho explícitamente: sólo mide la EXISTENCIA de la columna.
 * Un `NOT NULL` sin valor, un `CHECK` violado o un tipo incompatible son otra clase de falla y
 * otro candado. Y el payload por LÍNEA de `persist()` todavía no es extraíble — se declara
 * `NO MEDIDO` abajo en vez de dibujarse como verde.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-commission-persist.js
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla con TS5011.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const { totalesDeCorrida } = require(path.resolve(
  __dirname, '../../libs/commercial/src/lib/commercial-commissions/commission-totales.logic.ts'));

/** Una corrida mínima pero REAL: una ruta que paga, una que no, y un beneficiario con deducción. */
function totalesDeMuestra() {
  const linea = (route_code, beneficiario, extra = {}) => ({
    route_code, beneficiario, motivo_no_pago: null,
    subtotal: 100, venta: 110, comision: 5, a_pagar: 4, dias_multifuente: 1, ...extra,
  });
  return totalesDeCorrida(
    [
      linea('21', 'chofer'),
      linea('21', 'supervisor'),
      linea('99', 'chofer', { motivo_no_pago: 'sin_dato_en_la_fuente', a_pagar: 0, comision: 0 }),
    ],
    [{ route_code: '21', comisiona: true }, { route_code: '99', comisiona: true }],
    [{ deduccion: 3484.96 }],
    [{ route_code: 'VEC-PH-H' }],
    1, 1,
  );
}

(async () => {
  const db = new Client({
    connectionString: URL,
    statement_timeout: 30000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  // Sólo lectura: este candado mira el CATÁLOGO, no escribe una fila.
  await db.query('SET default_transaction_read_only = on');
  console.log(`\n=== [RD.50] la forma de la corrida contra el catalogo real · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'commission_runs'`);
  const columnas = new Set(cols.map((c) => c.column_name));

  if (!columnas.size) {
    noMedido('commercial.commission_runs', 'la tabla no existe en este destino');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
    await db.end();
    process.exit(fail ? 1 : 0);
  }

  // ── 1. La aserción de fondo ───────────────────────────────────────────────────────────────
  const totales = totalesDeMuestra();
  const claves = Object.keys(totales);
  check('totalesDeCorrida() devuelve al menos una clave', claves.length > 0, `devolvio ${claves.length}`);

  const huerfanas = claves.filter((k) => !columnas.has(k));
  check(
    `las ${claves.length} claves de totalesDeCorrida() son columnas de commission_runs`,
    huerfanas.length === 0,
    huerfanas.length ? `sin columna: ${huerfanas.join(', ')} (esto es el 42703 que dejo el motor en cero)` : '',
  );

  // La columna del incidente, nombrada aparte: si alguien revierte la migración, acá se ve.
  check('dias_multifuente existe como columna', columnas.has('dias_multifuente'));
  check('dias_multifuente sale de totalesDeCorrida()', claves.includes('dias_multifuente'));

  // ── 2. PRUEBA NEGATIVA — un gate sin prueba negativa es una intención (ADR-056) ────────────
  // Se le inventa una clave que no existe y se exige que el detector la VEA. Sin esto, un
  // detector que nunca marca nada se lee igual que "no hay huérfanas".
  // ⚠️ Se mide el DELTA contra la base, no el total: si la aserción fuera `length === 1` sólo
  // pasaría cuando la tabla ya está sana, o sea que el día que el candado hace falta también
  // se cae la prueba que lo respalda. Una mutación se evalúa aislada de lo que ya estaba roto.
  const mutado = { ...totales, columna_que_no_existe_rd50: 1 };
  const detectadas = Object.keys(mutado).filter((k) => !columnas.has(k));
  const delta = detectadas.filter((k) => !huerfanas.includes(k));
  check(
    'MUTACION: una clave inventada se detecta como huerfana',
    delta.length === 1 && delta[0] === 'columna_que_no_existe_rd50',
    `delta [${delta.join(', ')}] sobre base [${huerfanas.join(', ') || 'limpia'}]`,
  );

  // ── 3. Control positivo del propio catálogo ───────────────────────────────────────────────
  // Si la consulta de columnas devolviera basura, el punto 1 pasaría solo. Se ancla contra
  // columnas que la tabla tiene desde que nació.
  for (const c of ['tenant_id', 'period_id', 'scale_id', 'status']) {
    check(`control: la tabla declara ${c}`, columnas.has(c));
  }

  // ── 4. Lo que falta, declarado ────────────────────────────────────────────────────────────
  noMedido(
    'el payload por LINEA de persist()',
    'sigue escrito inline en el servicio y no es extraible: cuando se mueva a logica pura, este mismo candado lo cubre',
  );
  noMedido(
    'NOT NULL / CHECK / tipos',
    'esto mide EXISTENCIA de columna, que es la falla medida; un NOT NULL sin valor es otra clase y otro candado',
  );

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
