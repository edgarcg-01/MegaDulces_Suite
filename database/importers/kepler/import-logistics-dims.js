/* eslint-disable no-console */
/**
 * KV.8 — Dimensiones de logística de Kepler → logistics.* (IDEMPOTENTE, sin wipe).
 *
 * Versión de pipeline del one-off `scripts/logistics-clean-and-import-kepler.js`
 * (que hacía wipe+import una vez). Este sincroniza sin borrar:
 *   md.kdm_chofer     → logistics.drivers   (dedup por full_name)
 *   md.kdm_transporte → logistics.vehicles  (upsert por plate)
 *   md.kdm_rutas      → logistics.routes     (dedup por name)
 * logistics.* tiene RLS forzado → SET LOCAL app.tenant_id en la trx.
 *
 * Env:
 *   DATABASE_URL_NEW        = destino
 *   LOGISTICS_DIMS_SRC      = sucursal fuente (default md_03; los catálogos se
 *                             repiten entre sucursales, con una alcanza)
 *
 *   node database/importers/kepler/import-logistics-dims.js          # dry-run
 *   node database/importers/kepler/import-logistics-dims.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.LOGISTICS_DIMS_SRC || 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST });
  const src = new Client({ connectionString: SRC });
  await db.connect();
  await src.connect();
  try {
    console.log(`\n=== Dims logística Kepler → logistics.* (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // Drivers (dedup por full_name).
    const chof = (await src.query(`SELECT c1 AS code, c2 AS name FROM md.kdm_chofer WHERE btrim(coalesce(c2,''))<>'' ORDER BY c1`)).rows;
    const existDrv = new Set((await db.query(`SELECT upper(full_name) n FROM logistics.drivers WHERE tenant_id=$1`, [M])).rows.map((r) => r.n));
    let dIns = 0;
    for (const c of chof) {
      const name = c.name.trim();
      if (existDrv.has(name.toUpperCase())) continue;
      await db.query(
        `INSERT INTO logistics.drivers (tenant_id, full_name, roles, employee_type, status, active, notes)
         VALUES ($1,$2,ARRAY['chofer'],'interno','activo',true,$3)`,
        [M, name, `Kepler chofer ${c.code}`]);
      existDrv.add(name.toUpperCase()); dIns++;
    }
    console.log(`  drivers: +${dIns} (${chof.length} en Kepler)`);

    // Vehicles (upsert por plate).
    const veh = (await src.query(`SELECT c1 AS code, c2 AS descr, c3 AS plate, c4 AS chofer FROM md.kdm_transporte WHERE btrim(coalesce(c3,''))<>'' ORDER BY c1`)).rows;
    let vIns = 0, vUpd = 0;
    for (const v of veh) {
      const plate = v.plate.trim();
      const r = await db.query(
        `UPDATE logistics.vehicles SET model=$2, notes=$3, updated_at=now()
          WHERE tenant_id=$1 AND upper(plate)=upper($4)`,
        [M, v.descr.trim(), `Kepler unidad ${v.code} (chofer ${v.chofer})`, plate]);
      if (r.rowCount) { vUpd++; continue; }
      await db.query(
        `INSERT INTO logistics.vehicles (tenant_id, plate, brand, model, status, active, notes)
         VALUES ($1,$2,'',$3,'disponible',true,$4)`,
        [M, plate, v.descr.trim(), `Kepler unidad ${v.code} (chofer ${v.chofer})`]);
      vIns++;
    }
    console.log(`  vehicles: +${vIns} nuevos, ${vUpd} actualizados (${veh.length} en Kepler)`);

    // Routes (dedup por name).
    const rutas = (await src.query(`SELECT c1 AS code, c2 AS name FROM md.kdm_rutas WHERE btrim(coalesce(c2,''))<>'' ORDER BY c1`)).rows;
    const existRt = new Set((await db.query(`SELECT upper(name) n FROM logistics.routes WHERE tenant_id=$1`, [M])).rows.map((r) => r.n));
    let rIns = 0;
    for (const rt of rutas) {
      const name = rt.name.trim();
      if (existRt.has(name.toUpperCase())) continue;
      await db.query(`INSERT INTO logistics.routes (tenant_id, name, active, notes) VALUES ($1,$2,true,$3)`,
        [M, name, `Kepler ruta ${rt.code}`]);
      existRt.add(name.toUpperCase()); rIns++;
    }
    console.log(`  routes: +${rIns} (${rutas.length} en Kepler)`);

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
    await src.end();
  }
})();
