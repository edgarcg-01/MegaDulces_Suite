/* eslint-disable no-console */
/**
 * Logística: wipe de datos de prueba + import de la data REAL de Kepler.
 *
 * Decidido con Edgar (2026-06-15): logística operativa está 100% en test
 * (37 choferes TEST, 39 vehículos TEST, 241 embarques dev). Se borra todo eso
 * + liquidaciones/nómina de prueba + "Ruta Local Demo", se CONSERVAN las rutas
 * reales (import previo del Excel) y config_finance, y se importan de Kepler:
 *   - kdm_chofer     → logistics.drivers   (8 reales)
 *   - kdm_transporte → logistics.vehicles  (12 reales, placa=c3)
 *   - kdm_rutas      → logistics.routes     (52, dedup por nombre vs existentes)
 *
 * Patrón dry-run: corre todo en una transacción e imprime conteos; ROLLBACK
 * salvo --apply.
 *
 *   node database/scripts/logistics-clean-and-import-kepler.js          # dry-run
 *   node database/scripts/logistics-clean-and-import-kepler.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST });
  const src = new Client({ connectionString: SRC });
  await db.connect();
  await src.connect();

  const run = async (label, sql, params) => {
    const r = await db.query(sql, params);
    console.log(`  ${String(r.rowCount).padStart(5)}  ${label}`);
    return r.rowCount;
  };

  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    console.log(`\n=== Logística: wipe test + import Kepler (${APPLY ? 'APPLY' : 'DRY-RUN → rollback'}) ===\n`);

    console.log('WIPE datos de prueba:');
    await run('vehicle_usage_logs', `DELETE FROM logistics.vehicle_usage_logs WHERE tenant_id=$1`, [M]);
    await run('shipments (+cascade guías/gastos/checklists/fotos/detalles)', `DELETE FROM logistics.shipments WHERE tenant_id=$1`, [M]);
    await run('payroll_adjustments', `DELETE FROM logistics.payroll_adjustments WHERE tenant_id=$1`, [M]);
    await run('liquidations', `DELETE FROM logistics.liquidations WHERE tenant_id=$1`, [M]);
    await run('payroll_periods', `DELETE FROM logistics.payroll_periods WHERE tenant_id=$1`, [M]);
    await run('vehicle_maintenance', `DELETE FROM logistics.vehicle_maintenance WHERE tenant_id=$1`, [M]);
    await run('drivers (test)', `DELETE FROM logistics.drivers WHERE tenant_id=$1`, [M]);
    await run('vehicles (test)', `DELETE FROM logistics.vehicles WHERE tenant_id=$1`, [M]);
    await run('routes demo', `DELETE FROM logistics.routes WHERE tenant_id=$1 AND name ILIKE '%demo%'`, [M]);

    // ── IMPORT Kepler ──
    console.log('\nIMPORT Kepler (real):');
    const { rows: chof } = await src.query(`SELECT c1 AS code, c2 AS name FROM md.kdm_chofer WHERE c2 <> '' ORDER BY c1`);
    let dIns = 0;
    for (const c of chof) {
      await db.query(
        `INSERT INTO logistics.drivers (tenant_id, full_name, roles, employee_type, status, active, notes)
         VALUES ($1, $2, ARRAY['chofer'], 'interno', 'activo', true, $3)`,
        [M, c.name.trim(), `Kepler chofer ${c.code}`],
      );
      dIns++;
    }
    console.log(`  ${String(dIns).padStart(5)}  drivers importados`);

    const { rows: veh } = await src.query(`SELECT c1 AS code, c2 AS descr, c3 AS plate, c4 AS chofer FROM md.kdm_transporte WHERE c3 <> '' ORDER BY c1`);
    let vIns = 0;
    for (const v of veh) {
      await db.query(
        `INSERT INTO logistics.vehicles (tenant_id, plate, brand, model, status, active, notes)
         VALUES ($1, $2, '', $3, 'disponible', true, $4)`,
        [M, v.plate.trim(), v.descr.trim(), `Kepler unidad ${v.code} (chofer ${v.chofer})`],
      );
      vIns++;
    }
    console.log(`  ${String(vIns).padStart(5)}  vehicles importados`);

    const { rows: rutas } = await src.query(`SELECT c1 AS code, c2 AS name FROM md.kdm_rutas WHERE c2 <> '' ORDER BY c1`);
    const { rows: existing } = await db.query(`SELECT upper(name) AS n FROM logistics.routes WHERE tenant_id=$1`, [M]);
    const existSet = new Set(existing.map((r) => r.n));
    let rIns = 0, rSkip = 0;
    for (const rt of rutas) {
      const name = rt.name.trim();
      if (existSet.has(name.toUpperCase())) { rSkip++; continue; }
      await db.query(
        `INSERT INTO logistics.routes (tenant_id, name, active, notes) VALUES ($1, $2, true, $3)`,
        [M, name, `Kepler ruta ${rt.code}`],
      );
      existSet.add(name.toUpperCase());
      rIns++;
    }
    console.log(`  ${String(rIns).padStart(5)}  routes importadas (${rSkip} ya existían, omitidas)`);

    if (APPLY) {
      await db.query('COMMIT');
      console.log('\n[APPLY] COMMIT — logística limpia + Kepler importado.');
    } else {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió. Corré con --apply para confirmar.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
    await src.end();
  }
})();
