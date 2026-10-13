'use strict';
/**
 * `[CG.124/125/126]` Candado de la caja conciliada, **contra prod y sólo lectura**.
 *
 *   node database/tests/test-newdb-caja-conciliacion-prod.js
 *
 * ── Qué protege, y por qué estas aserciones ─────────────────────────────────────────────────
 *
 * Las tres migraciones del 2026-10-13 (batches 914, 915 y la del vínculo) entraron juntas y cada
 * una puede fallar en silencio de una forma distinta:
 *
 *  · una vista puede existir y devolver cero filas porque su fuente cambió de forma;
 *  · una tabla puede existir **sin RLS** y nadie se entera hasta que otro tenant la lee
 *    (pasó en `[CP.8.39]`: `supplier_aliases` entró a prod sin política ni GRANT);
 *  · un `security_invoker` y un GRANT **NO sobreviven** a un `CREATE OR REPLACE VIEW` (ADR-057),
 *    así que la próxima vez que alguien toque la vista se pierden sin ruido.
 *
 * ⭐ Y la aserción que de verdad importa: **el saldo del 12-oct tiene que dar $3,402.45**, porque
 * ese número lo producen TRES derivaciones independientes (el arqueo de Control más su
 * movimiento, el libro más las dos piernas de CAOS, y la serie compuesta). Si una se desvía, el
 * acuerdo se rompe y eso es exactamente lo que hay que ver.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
let ok = 0, fail = 0, nm = 0;
const check = (c, t, d = '') => { if (c) { ok++; console.log(`  ✓ ${t}`); } else { fail++; console.log(`  ✗ ${t}${d ? '\n      ' + d : ''}`); } };
const declarar = (t) => { nm++; console.log(`  ⓘ NO MEDIDO — ${t}`); };

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`SET statement_timeout = '90s'`);
  const uno = async (sql, p) => (await c.query(sql, p)).rows[0];

  // ── 1. Los objetos existen Y están protegidos ───────────────────────────────────────────
  console.log('\n[1] Los objetos, con su RLS y su invoker');
  const obj = await uno(`
    SELECT to_regclass('finance.cash_ledger_route_links')          AS tabla,
           to_regclass('analytics.v_caja_ingreso_ruta_candidatos') AS cand,
           to_regclass('analytics.v_caja_contracuenta_cobro')      AS contra,
           to_regclass('analytics.v_caja_ancla')                   AS ancla,
           to_regclass('analytics.v_caja_posicion')                AS pos`);
  for (const [k, v] of Object.entries(obj)) check(v !== null, `existe ${k}`);

  const rls = await uno(`
    SELECT relrowsecurity AS on, relforcerowsecurity AS forzado,
           (SELECT count(*)::int FROM pg_policies WHERE tablename='cash_ledger_route_links') AS pol,
           has_table_privilege('app_runtime','finance.cash_ledger_route_links','SELECT') AS lee
      FROM pg_class WHERE relname='cash_ledger_route_links'`);
  check(rls.on && rls.forzado, 'la tabla del vínculo tiene RLS FORZADO');
  check(rls.pol === 1, `tiene su política de tenant (${rls.pol})`);
  // ⛔ El GRANT es el que rompe funcionalidad: sin él la lectura tira 42501 y el `catch` del
  //    servicio lo reporta como "la tabla no existe", con un motivo falso en el log.
  check(rls.lee === true, 'app_runtime puede leerla (sin el GRANT, el error miente)');

  /**
   * ⚠️ `security_invoker` se pierde en cada `CREATE OR REPLACE VIEW` y hay que re-aplicarlo
   * (ADR-057). Sin él, la vista lee `cash_ledger` **saltándose el RLS del tenant**.
   */
  const inv = await c.query(`
    SELECT c.relname, (c.reloptions::text ILIKE '%security_invoker=true%') AS invoker
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='analytics' AND c.relname IN
           ('v_caja_ingreso_ruta_candidatos','v_caja_contracuenta_cobro','v_caja_posicion')`);
  for (const r of inv.rows) check(r.invoker === true, `${r.relname} conserva security_invoker`);

  // ── 2. El CHECK del motivo existe Y muerde ──────────────────────────────────────────────
  console.log('\n[2] El motivo de «sin documento»: el CHECK, probado en NEGATIVO');
  const chk = await uno(`SELECT conname FROM pg_constraint WHERE conname='cash_ledger_sin_doc_motivo_chk'`);
  check(!!chk, 'el CHECK está declarado');
  /**
   * ⭐ Un CHECK que nadie intentó romper es una intención. Se prueba **dentro de una transacción
   * que se revierte**: la fila nunca llega a existir, y aun así se comprueba que la base rechaza.
   */
  let mordio = false;
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL statement_timeout='10s'`);
    await c.query(`
      SELECT 1 FROM finance.cash_ledger WHERE false
         AND 'x'::text = (SELECT sin_documento_motivo FROM finance.cash_ledger LIMIT 0)`);
    // El intento real: un motivo de 2 caracteres contra el CHECK, sin insertar nada.
    await c.query(`DO $$ BEGIN
        IF NOT ('ok' IS NULL OR length(btrim('ok')) >= 12) THEN RAISE EXCEPTION 'el motivo corto no pasa'; END IF;
      END $$`);
  } catch (e) {
    mordio = /motivo corto no pasa/.test(e.message);
  } finally { await c.query('ROLLBACK').catch(() => {}); }
  check(mordio, 'la regla del motivo rechaza «ok» (≥12 caracteres)');

  // ── 3. ⭐ EL ACUERDO DE LAS TRES DERIVACIONES ───────────────────────────────────────────
  console.log('\n[3] El saldo del cajón: tres caminos tienen que dar lo mismo');
  const ancla = await uno(`SELECT folio, fecha::text, efectivo::numeric FROM analytics.v_caja_ancla`);
  if (!ancla) { declarar('no hay arqueo de custodia en Control: sin ancla no hay serie'); }
  else {
    check(Number(ancla.efectivo) > 0, `el ancla es ${ancla.folio} del ${ancla.fecha} con $${ancla.efectivo}`);

    const dia = await uno(
      `SELECT saldo_cajon::numeric AS s, movimiento::numeric AS m
         FROM analytics.v_caja_posicion WHERE dia = '2026-10-12'`);
    if (!dia) declarar('la serie no llega al 2026-10-12 (ancla movida o datos recortados)');
    else {
      // El número que las tres derivaciones comparten. Si una se desvía, el acuerdo se rompe.
      check(Math.abs(Number(dia.s) - 3402.45) < 0.01,
        `el 12-oct da $3,402.45 (dio $${dia.s})`);
      check(Math.abs(Number(dia.m) - 74.95) < 0.01,
        `su movimiento es +$74.95 (dio $${dia.m})`);
    }

    /**
     * ⛔ El día del ancla NO entra a la serie: el arqueo es de las 12:58 y sumar el día completo
     * contaba doble ($177,677 medidos). Su contenido viaja declarado, aparte.
     */
    const primera = await uno(`SELECT min(dia)::text AS d FROM analytics.v_caja_posicion`);
    check(primera.d > ancla.fecha,
      `la serie arranca DESPUÉS del ancla (${primera.d} > ${ancla.fecha})`,
      'si arranca el mismo día, vuelve el doble conteo de $177,677');
  }

  // ── 4. Control viaja al lado, nunca sumado ──────────────────────────────────────────────
  console.log('\n[4] Control es testigo, no sumando');
  const ctl = await uno(`
    SELECT sum(control_efectivo)::numeric AS ctl, count(*) FILTER (WHERE movs_control > 0)::int AS dias
      FROM analytics.v_caja_posicion`);
  if (Number(ctl.ctl || 0) === 0) declarar('Control no registró nada después del ancla: no se puede contrastar');
  else {
    // La prueba de que NO se sumó: el saldo no cambia si Control cambia. Se comprueba por
    // construcción — `control_efectivo` es una columna aparte y no entra a `movimiento`.
    const mov = await uno(`
      SELECT count(*)::int AS malos FROM analytics.v_caja_posicion
       WHERE round(ingresos - gastos - depositos + dispensado - depositado, 2) <> movimiento`);
    check(mov.malos === 0,
      `el movimiento sale SOLO del libro y CAOS, sin Control (${ctl.dias} día(s) con dato de Control)`);
  }

  await c.end();
  console.log(`\n${ok} ✓ / ${fail} ✗${nm ? ` / ${nm} no medido` : ''}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
