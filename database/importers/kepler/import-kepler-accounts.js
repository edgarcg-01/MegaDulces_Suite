/* eslint-disable no-console */
/**
 * CB.13 (Fase 1) — Puebla finance.kepler_accounts (catálogo real de cuentas) desde
 * analytics.ledger_monthly, canónico = almacén 00 (CEDIS). Distinct cuenta con su
 * nombre + mayor. Idempotente (UPSERT por cuenta). Es la fuente de verdad para mapear
 * — reemplaza el adivinar mayores.
 *
 *   node database/importers/kepler/import-kepler-accounts.js            # dry-run
 *   node database/importers/kepler/import-kepler-accounts.js --apply
 */
const { Client } = require('pg');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

async function main() {
  const c = new Client({ connectionString: DST, ssl: /localhost|127\.0\.0\.1/.test(DST) ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    // Catálogo canónico desde almacén 00: una fila por cuenta con su mejor nombre + mayor.
    const rows = (await c.query(
      `SELECT cuenta,
              MAX(cuenta_nombre) FILTER (WHERE cuenta_nombre IS NOT NULL) AS cuenta_nombre,
              MIN(cuenta_mayor) AS cuenta_mayor
       FROM analytics.ledger_monthly
       WHERE tenant_id = $1 AND sucursal = '00' AND cuenta IS NOT NULL
       GROUP BY cuenta`, [MEGA])).rows;
    // Nombre de mayor = nombre de la cuenta cuyo código == mayor (si existe).
    const mayorName = {};
    for (const r of rows) if (r.cuenta === r.cuenta_mayor && r.cuenta_nombre) mayorName[r.cuenta_mayor] = r.cuenta_nombre;

    console.log(`Catálogo (almacén 00): ${rows.length} cuentas, ${new Set(rows.map(r => r.cuenta_mayor)).size} mayores.`);
    if (!APPLY) { console.log('(dry-run; usa --apply para escribir)'); await c.end(); return; }

    await c.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO finance.kepler_accounts (tenant_id, cuenta, cuenta_nombre, cuenta_mayor, cuenta_mayor_nombre, es_mayor, sucursal_ref, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'00',now())
         ON CONFLICT (tenant_id, cuenta) DO UPDATE SET
           cuenta_nombre=EXCLUDED.cuenta_nombre, cuenta_mayor=EXCLUDED.cuenta_mayor,
           cuenta_mayor_nombre=EXCLUDED.cuenta_mayor_nombre, es_mayor=EXCLUDED.es_mayor, computed_at=now()`,
        [MEGA, r.cuenta, r.cuenta_nombre, r.cuenta_mayor, mayorName[r.cuenta_mayor] || null, r.cuenta === r.cuenta_mayor],
      );
      n++;
    }
    await c.query('COMMIT');
    console.log(`✅ ${n} cuentas upsert en finance.kepler_accounts.`);
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
