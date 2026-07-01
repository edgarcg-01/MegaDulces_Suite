/* eslint-disable no-console */
/**
 * DISCOVERY pass 5 (read-only) — retención de historia de VENTA en cada sucursal viva
 * + ¿el consolidado mart.ventas tiene más historia (y podría llevar la ruta c63)?
 *   node database/scripts/explore-md01-routes.js
 */
const { Client } = require('pg');

const BRANCHES = [
  { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
  { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
  { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
  { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
  { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
  { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
];
const CONS = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';

(async () => {
  console.log(`\n=== pass 5: retención de VENTA (U/D/10) por sucursal viva ===\n`);
  for (const b of BRANCHES) {
    const c = new Client({ connectionString: b.url, connectionTimeoutMillis: 6000, statement_timeout: 60000 });
    try {
      await c.connect();
      const r = (await c.query(
        `SELECT min(c9)::date lo, max(c9)::date hi, count(*) docs, count(DISTINCT date_trunc('month',c9)) meses
           FROM md.kdm1 WHERE c2='U' AND c3='D' AND c4=10`)).rows[0];
      console.log(`   md_${b.code}: ${r.lo} → ${r.hi}  (${r.meses} meses, ${r.docs} docs venta)`);
    } catch (e) {
      console.log(`   md_${b.code}: ❌ ${e.message}`);
    } finally { await c.end().catch(() => {}); }
  }

  console.log(`\n── consolidado mart.ventas (localhost:5433) — historia acumulada ──`);
  const cc = new Client({ connectionString: CONS, connectionTimeoutMillis: 6000, statement_timeout: 60000 });
  try {
    await cc.connect();
    const r = (await cc.query(`SELECT min(fecha) lo, max(fecha) hi, count(*) filas, count(DISTINCT date_trunc('month',fecha)) meses FROM mart.ventas`)).rows[0];
    console.log(`   mart.ventas: ${r.lo?.toISOString?.().slice(0,10)} → ${r.hi?.toISOString?.().slice(0,10)}  (${r.meses} meses, ${r.filas} filas)`);
    // ¿mart.ventas ya tiene alguna columna que se parezca a la serie c63?
    const cols = (await cc.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='mart' AND table_name='ventas' ORDER BY ordinal_position`)).rows;
    console.log(`   columnas mart.ventas: ${cols.map((x) => x.column_name).join(', ')}`);
  } catch (e) {
    console.log(`   ❌ consolidado no accesible: ${e.message}`);
  } finally { await cc.end().catch(() => {}); }
  console.log('');
})();
