/* eslint-disable no-console */
/**
 * Limpieza puntual de datos-basura en analytics.sales_daily: filas con
 * `sale_date > current_date` (fechas IMPOSIBLES que llegan corruptas del origen
 * Kepler — visto Dic-2026 estando en jul-2026). Envenenan el max(sale_date) que
 * usan los tableros para mostrar "último dato".
 *
 * Por qué existe como script aparte: el feed (import-sales-fact) refresca por
 * UPSERT y NO borra (decisión de recursos del usuario), así que ya no barre estas
 * filas. El filtro `fecha <= current_date` del feed evita NUEVAS, pero las
 * preexistentes hay que quitarlas una vez. NO borra data real (solo fechas futuras).
 *
 *   node database/scripts/cleanup-future-sales.js          # dry-run (reporta)
 *   node database/scripts/cleanup-future-sales.js --apply  # borra
 *
 * Requiere DATABASE_URL_NEW apuntando a prod (evita pegarle al local sin querer).
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW;
const APPLY = process.argv.includes('--apply');

(async () => {
  if (!DST) { console.error('ABORT: falta DATABASE_URL_NEW'); process.exit(2); }
  if (APPLY && !/proxy\.rlwy\.net|railway/i.test(DST)) {
    console.error('ABORT: --apply requiere DATABASE_URL_NEW apuntando a prod. Actual: ' + DST);
    process.exit(3);
  }
  const db = new Client({ connectionString: DST, statement_timeout: 30000 });
  await db.connect();
  try {
    console.log(`\n=== Cleanup sale_date futuro en analytics.sales_daily (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const { rows: prev } = await db.query(
      `SELECT sale_date, count(*)::int filas, round(sum(revenue)::numeric,2) revenue
         FROM analytics.sales_daily WHERE tenant_id=$1 AND sale_date > current_date
        GROUP BY sale_date ORDER BY sale_date`, [M]);
    if (!prev.length) { console.log('  No hay filas con fecha futura. Nada que hacer.'); return; }
    console.table(prev.map((r) => ({ sale_date: String(r.sale_date).slice(0, 10), filas: r.filas, revenue: Number(r.revenue) })));
    const total = prev.reduce((a, r) => a + r.filas, 0);

    if (!APPLY) { console.log(`\n[DRY-RUN] borraría ${total} fila(s). Correr con --apply.`); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const del = await db.query(
      `DELETE FROM analytics.sales_daily WHERE tenant_id=$1 AND sale_date > current_date`, [M]);
    await db.query('COMMIT');
    const [{ n }] = (await db.query(
      `SELECT count(*)::int n FROM analytics.sales_daily WHERE tenant_id=$1 AND sale_date > current_date`, [M])).rows;
    console.log(`\n[APPLY] COMMIT — ${del.rowCount} fila(s) borradas. Futuras restantes: ${n}.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
