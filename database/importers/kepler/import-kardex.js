/**
 * SM.2 — Importer de movimientos de inventario (Supervisor de Movimientos, Plano 1).
 *
 * Lee md.kdij (kardex) de las sucursales Kepler, SOLO movimientos de inventario
 * (género N: ajustes/mermas/traspasos/inv.físico) → analytics.stock_ledger. Las
 * ventas (U) y compras (X) NO se ingieren aquí (viven en sales_daily/otros).
 *
 * Columnas kdij (verificado 2026-07-07): c1=suc c3=sku c4=género c5=naturaleza
 *   c6=grupo c8=folio c9=unidades c10=fecha c12=unidad c13/c21=importe c19=almacén.
 * clase_mov derivada de género/nat/grupo (ver migración 20260707200000).
 *
 * Uso (desde database/):
 *   node importers/kepler/import-kardex.js            # dry-run (resume, NO escribe)
 *   DATABASE_URL_NEW='postgres://…?sslmode=no-verify' node importers/kepler/import-kardex.js --apply
 */
const knexLib = require('knex');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const BRANCHES = process.env.SALES_BRANCH_MAP
  ? JSON.parse(process.env.SALES_BRANCH_MAP)
  : [
      { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00', name: 'CEDIS' },
      { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01', name: 'Padre Hidalgo' },
      { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02', name: 'La Piedad Abastos' },
      { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03', name: '8 Esquinas' },
      { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04', name: 'Yurécuaro' },
      { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05', name: 'Zamora Centro' },
    ];

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

function claseMov(gen, nat, grupo) {
  const g = String(grupo || '');
  if (gen === 'N' && nat === 'D') {
    if (g === '5') return 'merma';
    if (g === '6' || g === '25') return 'traspaso_salida';
    return 'ajuste_salida';
  }
  if (gen === 'N' && nat === 'A') {
    if (g === '6' || g === '25') return 'traspaso_entrada';
    if (g === '20') return 'ajuste_entrada';
    if (Number(g) >= 30 && Number(g) <= 45) return 'inv_fisico';
    return 'otro';
  }
  return 'otro';
}

async function readBranch(b) {
  const c = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 6000, statement_timeout: 60000 });
  await c.connect();
  try {
    // Solo género N (inventario) de la sucursal propia (c1 = code, evita réplicas).
    const r = await c.query(
      `SELECT c1 AS suc, c19 AS almacen, c3 AS sku, c4 AS gen, c5 AS nat, c6 AS grupo,
              c8 AS folio, c9::numeric AS unidades, c12 AS unidad,
              COALESCE(NULLIF(c13::numeric,0), c21::numeric) AS importe, c10::date AS fecha
       FROM md.kdij
       WHERE c1 = $1 AND c4 = 'N'`,
      [b.code],
    );
    return r.rows.map((x) => ({
      warehouse_code: b.code,
      almacen: x.almacen ? String(x.almacen).trim() : null,
      sku: String(x.sku).trim(),
      genero: x.gen, naturaleza: x.nat, grupo: x.grupo ? String(x.grupo).trim() : null,
      clase_mov: claseMov(x.gen, x.nat, x.grupo),
      folio: String(x.folio).trim(),
      unidades: num(x.unidades), unidad: x.unidad ? String(x.unidad).trim() : null,
      importe: Math.abs(num(x.importe)), fecha: x.fecha,
    }));
  } finally {
    await c.end();
  }
}

async function upsert(db, rows) {
  let n = 0;
  for (const r of rows) {
    await db('analytics.stock_ledger')
      .insert({ tenant_id: TENANT, ...r, source: 'kepler' })
      .onConflict(['tenant_id', 'warehouse_code', 'folio', 'genero', 'naturaleza', 'grupo', 'sku'])
      .merge({ unidades: r.unidades, importe: r.importe, clase_mov: r.clase_mov, almacen: r.almacen, unidad: r.unidad, fecha: r.fecha, updated_at: db.fn.now() });
    n++;
  }
  return n;
}

(async () => {
  const all = [];
  for (const b of BRANCHES) {
    try {
      const rows = await readBranch(b);
      all.push(...rows);
      console.log(`[${b.db}] ${rows.length} movimientos N-género`);
    } catch (e) {
      console.warn(`[${b.db}] ERROR: ${e.message}`);
    }
  }
  const byClase = {};
  for (const r of all) { byClase[r.clase_mov] = byClase[r.clase_mov] || { n: 0, importe: 0 }; byClase[r.clase_mov].n++; byClase[r.clase_mov].importe += r.importe; }
  console.log(`\nTOTAL: ${all.length} movimientos`);
  Object.entries(byClase).sort((a, b) => b[1].importe - a[1].importe).forEach(([k, v]) => console.log(`  ${k}: ${v.n} movs · $${Math.round(v.importe).toLocaleString()}`));
  const mermas = all.filter((r) => r.clase_mov === 'merma').sort((a, b) => b.importe - a.importe).slice(0, 8);
  console.log('\nTop mermas (salida por ajuste/destrucción):');
  mermas.forEach((r) => console.log(`  suc${r.warehouse_code} sku${r.sku} ${r.fecha?.toISOString?.().slice(0, 10) || r.fecha} folio${r.folio} $${r.importe} (${r.unidades} ${r.unidad || ''})`));

  if (!APPLY) { console.log('\n(dry-run — usar --apply para escribir a analytics.stock_ledger)'); return; }
  if (!process.env.DATABASE_URL_NEW) { console.error('ERROR: --apply requiere DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } });
  const n = await upsert(db, all);
  console.log(`✅ UPSERT ${n} movimientos a analytics.stock_ledger`);
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
