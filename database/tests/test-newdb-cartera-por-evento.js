#!/usr/bin/env node
/**
 * [CXC.21] La cartera por EVENTO (migración 20261117144732): `customer_receivables_current` se pone al día por cuenta
 * al llegar el cambio, y tiene que quedar IDÉNTICA a la vista `analytics.customer_receivables`.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **Paridad de la función por cuenta:** `customer_receivables_for(todas las cuentas)` da exactamente las filas de
 *     la vista (md5 por fila, sin `computed_at`), en la misma foto.
 *  2. **Llenado:** el primer drenado con la tabla vacía es `completo` y deja la tabla = vista.
 *  3. **Cada fuente avisa y el drenado por llave deja tabla = vista** (todas las cuentas, no sólo la tocada):
 *     `kdue` (importe de una factura), `kdm5` (monto de una aplicación), `kdud` (zona de un cliente → todas sus
 *     sucursales) y `kdm1` (cancelar un abono saca sus aplicaciones de `kepler_kdm5_vigente`).
 *  4. **Negativa del interruptor:** apagado, una escritura no anota nada.
 *  5. **El árbitro:** con todo por evento, un completo encuentra 0 diferencias; y su negativa — se corrompe UNA fila
 *     guardada a mano y el completo la cuenta y la arregla.
 *  6. **`ocupado`:** con otro drenado en curso no se espera.
 *  7. **La ingesta nunca se frena:** si el disparador falla, la escritura pasa y la falla queda en
 *     `receivables_dirty_errors`.
 *
 * Todo en UNA transacción que se revierte: no deja filas ni cambios en `kepler_ods`.
 * ⚠️ Sin datos de cartera (base sin ODS) reporta NO MEDIDO, nunca ✔. ⛔ Contra producción se NIEGA.
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cartera-por-evento', { url: DST });

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('\n[CXC.21] cartera por evento\n');
  const inst = (await c.query(`SELECT to_regprocedure('analytics.drain_customer_receivables()') IS NOT NULL AS d,
                                      to_regclass('analytics.customer_receivables') IS NOT NULL AS v`)).rows[0];
  if (!inst.d || !inst.v) { NM('sin la migración 20261117144732 o sin las vistas de la cartera'); return fin(c); }
  const COLS = (await c.query(`SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) l FROM pg_attribute a
     WHERE a.attrelid = 'analytics.customer_receivables'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'computed_at'`)).rows[0].l;
  const huella = async (rel) => (await c.query(`SELECT count(*)::int n, md5(COALESCE(string_agg(md5(row(${COLS})::text), ',' ORDER BY folio_digital), '')) h FROM ${rel}`)).rows[0];
  const igual = async (que) => {
    const [t, v] = [await huella('analytics.customer_receivables_current'), await huella('analytics.customer_receivables')];
    if (t.h === v.h && t.n === v.n) P(`${que}: tabla = vista (${v.n} filas)`);
    else F(`${que}: tabla ${t.n} filas ≠ vista ${v.n} filas`);
  };
  const drenar = async () => (await c.query('SELECT * FROM analytics.drain_customer_receivables()')).rows[0];
  const cola = async () => (await c.query('SELECT sucursal, cliente_code FROM analytics.receivables_dirty_accounts ORDER BY id')).rows;

  await c.query('BEGIN');
  try {
    const nv = (await c.query('SELECT count(*)::int n FROM analytics.customer_receivables')).rows[0].n;
    if (!nv) { NM('la vista de cartera está vacía (base sin ODS)'); await c.query('ROLLBACK'); return fin(c); }

    // 1. Paridad de la función por cuenta.
    const fn = await huella(`(SELECT * FROM analytics.customer_receivables_for(
        (SELECT array_agg(s) FROM (SELECT DISTINCT sucursal s, COALESCE(cliente_code, '') k FROM analytics.customer_receivables) x),
        (SELECT array_agg(k) FROM (SELECT DISTINCT sucursal s, COALESCE(cliente_code, '') k FROM analytics.customer_receivables) x))) z`);
    const vw = await huella('analytics.customer_receivables');
    if (fn.h === vw.h && fn.n === vw.n) P(`customer_receivables_for(todas) = vista (${vw.n} filas, md5 por fila)`);
    else F(`customer_receivables_for(todas) ${fn.n} filas ≠ vista ${vw.n}`);

    // 1b. El costo por cuenta: la más pesada no puede volver a los 12 s. Medido en prod el 2026-11-17: 228 ms con los
    // abonos buscados por índice, 12,300 ms cuando se cruzaban contra el CTE (nested loop sin índice). Tope holgado.
    const pesada = (await c.query(`SELECT sucursal s, COALESCE(cliente_code, '') k, count(*)::int n FROM analytics.customer_receivables
                                    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 1`)).rows[0];
    const t0 = Date.now();
    await c.query('SELECT count(*) FROM analytics.customer_receivables_for($1::text[], $2::text[])', [[pesada.s], [pesada.k]]);
    const ms = Date.now() - t0;
    if (pesada.n < 1000) NM(`costo por cuenta: la cuenta más pesada de esta base tiene ${pesada.n} documentos (hace falta ≥1,000)`);
    else if (ms < 3000) P(`la cuenta más pesada (${pesada.n} documentos) se recalcula en ${ms} ms (tope 3,000)`);
    else F(`la cuenta más pesada (${pesada.n} documentos) tardó ${ms} ms: ¿se perdió la búsqueda del abono por índice?`);

    // 2. Llenado.
    await c.query('DELETE FROM analytics.customer_receivables_current');
    const d0 = await drenar();
    if (d0.mode === 'completo' && d0.reason === 'tabla_vacia') P(`el primer drenado es completo por tabla vacía (${d0.inserted} filas, ${d0.ms} ms)`);
    else F(`primer drenado: ${JSON.stringify(d0)}`);
    await igual('llenado');

    // 3. Cada fuente, con el interruptor prendido.
    await c.query(`UPDATE analytics.receivables_by_event SET enabled = true`);
    const fact = (await c.query(`SELECT btrim(c1) s, btrim(c2) k, c4, c5, c6 FROM kepler_ods.kdue WHERE c29 = 'C' AND COALESCE(btrim(c2), '') <> '' LIMIT 1`)).rows[0];
    const casos = [
      ['kdue (importe de una factura)', `UPDATE kepler_ods.kdue SET c11 = c11 + 123.45 WHERE btrim(c1) = $1 AND c29 = 'C' AND c4 = $2 AND c5 = $3 AND c6 = $4`, [fact.s, fact.c4, fact.c5, fact.c6]],
      ['kdm5 (monto de una aplicación)', `UPDATE kepler_ods.kdm5 SET c13 = c13 + 1 WHERE ctid = (SELECT ctid FROM kepler_ods.kdm5 WHERE c2 = 'U' AND btrim(c8) = 'D' LIMIT 1)`, []],
      ['kdud (zona de un cliente)', `UPDATE kepler_ods.kdud SET c14 = 'ZZ-PRUEBA' WHERE btrim(c2) = $1`, [fact.k]],
      ['kdm1 (cancelar un abono)', `UPDATE kepler_ods.kdm1 SET c43 = 'C' WHERE ctid = (SELECT k.ctid FROM kepler_ods.kdm1 k JOIN kepler_ods.kdm5 m
          ON m.c1 = k.c1 AND m.c2 = k.c2 AND m.c3 = k.c3 AND m.c4 = k.c4 AND m.c5 = k.c5 AND m.c6 = k.c6
         WHERE k.sucursal = k.c1 AND k.c2 = 'U' AND k.c3 = 'A' AND btrim(COALESCE(k.c43, '')) <> 'C' AND btrim(m.c8) = 'D' LIMIT 1)`, []],
    ];
    for (const [que, sql, params] of casos) {
      const r = await c.query(sql, params);
      if (!r.rowCount) { NM(`${que}: no hay renglón con qué probarlo en esta base`); continue; }
      const q = await cola();
      if (!q.length) { F(`${que}: la escritura no anotó ninguna cuenta`); continue; }
      const d = await drenar();
      if (d.mode === 'llave') P(`${que}: anotó ${q.length} marca(s), drenado por llave (${d.accounts} cuentas, ${d.inserted}/${d.updated}/${d.deleted}, ${d.ms} ms)`);
      else F(`${que}: el drenado fue ${JSON.stringify(d)}`);
      await igual(que);
    }

    // 4. Negativa del interruptor.
    await c.query(`UPDATE analytics.receivables_by_event SET enabled = false`);
    await c.query(`UPDATE kepler_ods.kdue SET c11 = c11 + 1 WHERE btrim(c1) = $1 AND c29 = 'C' AND c4 = $2 AND c5 = $3 AND c6 = $4`, [fact.s, fact.c4, fact.c5, fact.c6]);
    if ((await cola()).length === 0) P('prueba negativa: con el interruptor apagado, la escritura no anota nada');
    else F('con el interruptor apagado se anotaron cuentas');
    await c.query(`UPDATE kepler_ods.kdue SET c11 = c11 - 1 WHERE btrim(c1) = $1 AND c29 = 'C' AND c4 = $2 AND c5 = $3 AND c6 = $4`, [fact.s, fact.c4, fact.c5, fact.c6]);
    await c.query(`UPDATE analytics.receivables_by_event SET enabled = true`);

    // 5. El árbitro: completo con 0 diferencias, y su negativa.
    await c.query(`INSERT INTO analytics.receivables_dirty_accounts (sucursal, cliente_code, source) VALUES ('*', '*', 'prueba')`);
    const a0 = await drenar();
    if (a0.mode === 'completo' && a0.inserted + a0.updated + a0.deleted === 0) P(`el árbitro (completo) no encuentra diferencias: todo llegó por evento (${a0.ms} ms)`);
    else F(`el árbitro encontró diferencias: ${JSON.stringify(a0)}`);
    await c.query(`UPDATE analytics.customer_receivables_current SET zona = 'CORRUPTA' WHERE folio_digital = (SELECT min(folio_digital) FROM analytics.customer_receivables_current)`);
    await c.query(`INSERT INTO analytics.receivables_dirty_accounts (sucursal, cliente_code, source) VALUES ('*', '*', 'prueba')`);
    const a1 = await drenar();
    if (a1.updated === 1 && a1.inserted === 0 && a1.deleted === 0) P('prueba negativa del árbitro: una fila corrompida a mano se cuenta (1) y se arregla');
    else F(`el árbitro no vio la fila corrompida: ${JSON.stringify(a1)}`);
    await igual('después del árbitro');

    // 6. ocupado: otro drenado en curso (esta transacción retiene el candado del último drenado).
    const otra = new Client({ connectionString: DST }); await otra.connect();
    const o = (await otra.query('SELECT * FROM analytics.drain_customer_receivables()')).rows[0];
    await otra.end();
    if (o.mode === 'ocupado') P('con otro drenado en curso contesta «ocupado» sin esperar');
    else F(`el segundo drenado no dijo ocupado: ${JSON.stringify(o)}`);

    // 7. La ingesta nunca se frena.
    await c.query('SAVEPOINT roto');
    await c.query('ALTER TABLE analytics.receivables_dirty_accounts RENAME TO receivables_dirty_accounts_x');
    const w = await c.query(`UPDATE kepler_ods.kdue SET c11 = c11 + 2 WHERE btrim(c1) = $1 AND c29 = 'C' AND c4 = $2 AND c5 = $3 AND c6 = $4`, [fact.s, fact.c4, fact.c5, fact.c6]);
    const e = (await c.query(`SELECT count(*)::int n FROM analytics.receivables_dirty_errors WHERE source_table = 'kepler_ods.kdue'`)).rows[0].n;
    if (w.rowCount > 0 && e > 0) P(`con el disparador roto la escritura pasa (${w.rowCount} renglones) y la falla queda escrita`);
    else F(`disparador roto: escritura ${w.rowCount}, errores ${e}`);
    await c.query('ROLLBACK TO SAVEPOINT roto');
  } finally {
    await c.query('ROLLBACK');
  }
  return fin(c);
})().catch((e) => { console.error(e); process.exit(1); });

async function fin(c) {
  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
}
