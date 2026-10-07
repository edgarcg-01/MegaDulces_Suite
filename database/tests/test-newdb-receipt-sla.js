#!/usr/bin/env node
/**
 * `[RE.27.C]` — **El reloj de la cola de entradas.**
 *
 * Los dos plazos (`sla_review_days`, `sla_capture_days`) vivían en
 * `finance.receipt_settings` desde RE.16.3 y **ninguno disparaba nada**. Este smoke
 * fija que el barrido que ahora los lee cuente lo mismo que muestra la pantalla:
 * si el aviso dice "12 esperando en la 01" y al hacer clic aparecen 30, el aviso
 * deja de creerse a la segunda vez.
 *
 * ⚠️ **El SQL se lee del archivo de producción**, no se copia acá. Una copia se
 * desincroniza en silencio y el test se pondría verde midiendo una consulta que ya
 * nadie ejecuta — que es exactamente cómo se ve un test inútil desde afuera.
 *
 * Correr: node database/tests/test-newdb-receipt-sla.js
 *         DATABASE_URL_NEW=<prod> node database/tests/test-newdb-receipt-sla.js
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST)
    ? DST
    : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 3 },
});

/** Saca el literal `SQL_SLA` del servicio real. Si cambia de nombre, esto falla. */
function sqlDelServicio() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs/receipt-sla.service.ts'), 'utf8');
  const m = src.match(/const SQL_SLA = `([\s\S]*?)`;/);
  return m ? m[1] : null;
}

(async () => {
  try {
    const SQL = sqlDelServicio();
    console.log('\n═══ 1. El barrido corre el SQL de producción ═══');
    assert(!!SQL, 'se extrajo `SQL_SLA` del servicio (no una copia de este archivo)');
    if (!SQL) throw new Error('sin SQL no hay nada que verificar');

    const cfg = await knex('finance.receipt_settings').where({ tenant_id: T }).first();
    assert(!!cfg, 'existen los parámetros del proceso en `finance.receipt_settings`');
    const slaRev = Number(cfg?.sla_review_days ?? 3);
    const slaCap = Number(cfg?.sla_capture_days ?? 3);
    const arranque = cfg?.reception_start ?? '2026-08-01';
    console.log(`     plazos vigentes: revisión ${slaRev} d · captura ${slaCap} d · arranque ${String(arranque).slice(0, 10)}`);

    const { rows } = await knex.raw(SQL, { tenant: T, sla_revision: slaRev, sla_captura: slaCap, arranque });
    assert(Array.isArray(rows), `la consulta corre contra el esquema real (${rows.length} sucursal(es) fuera de plazo)`);

    // ── 2. Los números son los de la pantalla ────────────────────────────────
    //
    // El contraste es contra una consulta INDEPENDIENTE, escrita distinto. Si las
    // dos derivaran de la misma expresión no probarían nada: se estarían dando la
    // razón entre ellas.
    console.log('\n═══ 2. El aviso cuenta lo mismo que la pantalla ═══');
    const esperandoSql = rows.reduce((a, r) => a + Number(r.esperando || 0), 0);
    const { rows: [ind] } = await knex.raw(`
      SELECT count(*)::int n
        FROM (
          SELECT p.sucursal, p.folio,
                 (array_agg(p.status     ORDER BY p.created_at DESC, (p.status='recibido') DESC, p.id DESC))[1] AS st,
                 (array_agg(p.created_at ORDER BY p.created_at DESC, (p.status='recibido') DESC, p.id DESC))[1] AS at
            FROM finance.goods_receipt_proofs p WHERE p.tenant_id = ?
           GROUP BY p.sucursal, p.folio) u
        JOIN analytics.erp_goods_receipts c
          ON c.tenant_id = ? AND c.sucursal = u.sucursal AND c.folio = u.folio
       WHERE u.st = 'recibido'
         AND (current_date - (u.at AT TIME ZONE 'America/Mexico_City')::date) > ?
         AND c.dup_of_folio IS NULL
         AND c.receipt_date >= ?
         AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_discards x
             WHERE x.tenant_id = c.tenant_id AND x.sucursal = c.sucursal AND x.folio = c.folio)`,
      [T, T, slaRev, arranque]);
    assert(
      esperandoSql === Number(ind.n),
      `los comprobantes vencidos coinciden con el conteo independiente (${esperandoSql} vs ${ind.n})`,
    );

    // ── 3. Invariantes de forma ──────────────────────────────────────────────
    console.log('\n═══ 3. Ninguna fila miente ═══');
    assert(
      rows.every((r) => Number(r.esperando) > 0 || Number(r.sin_evidencia) > 0),
      'ninguna sucursal sin nada vencido se cuela en el aviso (el HAVING hace su trabajo)',
    );
    assert(
      rows.every((r) => Number(r.esperando) === 0 || Number(r.dias_peor_revision) > slaRev),
      'si hay algo esperando, el peor caso supera el plazo (si no, el aviso sería falso)',
    );
    assert(
      rows.every((r) => Number(r.sin_evidencia) === 0 || Number(r.dias_peor_captura) > slaCap),
      'lo mismo del lado de captura',
    );
    // El nombre de la sucursal sale por la llave canónica (RE.23): si alguien lo
    // resolviera por `code`, Morelia saldría sin nombre y el aviso diría "en 30".
    const morelia = rows.filter((r) => ['30', '32'].includes(String(r.sucursal)));
    if (morelia.length) {
      assert(morelia.every((r) => !!r.sucursal_nombre), 'las sucursales Wincaja traen su nombre (llave canónica)');
    } else {
      console.log('  ⚠️  ninguna sucursal Wincaja vencida en este momento — el nombre queda SIN VERIFICAR');
    }

    // ── 3-bis. `[RE.28.2]` El espejo: coverage cuenta lo mismo que el barrido ─
    //
    // El plazo de revisión se calcula en DOS lugares: acá (el cron, que avisa) y en
    // `coverage()` (la pantalla, que muestra). Es el riesgo que nombra ADR-056 — dos
    // implementaciones de una misma regla se desincronizan solas — y se cierra igual
    // que el cuadre: comparándolas. Si el aviso dice 12 y la pantalla muestra 30, el
    // aviso deja de creerse a la segunda vez.
    console.log('\n═══ 3-bis. El aviso y el tablero cuentan lo mismo ═══');
    const cov = await knex.raw(`
      WITH d AS (
        SELECT sucursal, folio,
               (array_agg(status     ORDER BY created_at DESC))[1] AS last_status,
               (array_agg(created_at ORDER BY created_at DESC))[1] AS last_at
          FROM finance.goods_receipt_proofs WHERE tenant_id = ? GROUP BY sucursal, folio
      )
      SELECT c.sucursal,
             COUNT(*) FILTER (
               WHERE d.last_status = 'recibido'
                 AND (current_date - (d.last_at AT TIME ZONE 'America/Mexico_City')::date) > ?
             )::int AS n
        FROM analytics.erp_goods_receipts c
        LEFT JOIN d ON d.sucursal = c.sucursal AND d.folio = c.folio
       WHERE c.tenant_id = ? AND c.dup_of_folio IS NULL AND c.receipt_date >= ?
         AND NOT EXISTS (SELECT 1 FROM finance.goods_receipt_discards x
             WHERE x.tenant_id = c.tenant_id AND x.sucursal = c.sucursal AND x.folio = c.folio)
       GROUP BY c.sucursal`, [T, slaRev, T, arranque]);
    const porSucCov = new Map(cov.rows.map((r) => [String(r.sucursal), Number(r.n)]));
    const porSucSla = new Map(rows.map((r) => [String(r.sucursal), Number(r.esperando)]));
    const sucursales = [...new Set([...porSucCov.keys(), ...porSucSla.keys()])].sort();
    const difieren = sucursales.filter((s) => (porSucCov.get(s) ?? 0) !== (porSucSla.get(s) ?? 0));
    assert(
      difieren.length === 0,
      `las dos consultas coinciden sucursal por sucursal (${sucursales.length} revisadas; difieren: `
      + `${difieren.map((s) => `${s}: tablero ${porSucCov.get(s) ?? 0} vs aviso ${porSucSla.get(s) ?? 0}`).join(' · ') || 'ninguna'})`,
    );

    // ── 4. La foto, para poder discutirla ────────────────────────────────────
    if (rows.length) {
      console.log('\n═══ 4. Lo que hoy está fuera de plazo ═══');
      console.table(rows.map((r) => ({
        sucursal: `${r.sucursal} ${r.sucursal_nombre || ''}`.trim(),
        esperando: Number(r.esperando), dias: Number(r.dias_peor_revision),
        'sin evidencia': Number(r.sin_evidencia), 'días': Number(r.dias_peor_captura),
        '$ revisión': Math.round(Number(r.monto_revision)).toLocaleString('es-MX'),
        '$ captura': Math.round(Number(r.monto_captura)).toLocaleString('es-MX'),
      })));
    } else {
      console.log('\n  ⚠️  nada fuera de plazo en este ambiente — los bloques 2-3 no probaron gran cosa');
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
