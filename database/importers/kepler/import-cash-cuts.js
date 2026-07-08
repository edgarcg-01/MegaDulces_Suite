/**
 * SM.1 — Importer de cortes/arqueos de caja POS (Supervisor de Movimientos, Plano 2).
 *
 * Lee `md.kdpv_folio_caja` de las 6 sucursales Kepler (LAN) y UPSERT a
 * `analytics.cash_cuts` en la newdb. Idempotente (ON CONFLICT por corte).
 *
 * Columnas kdpv_folio_caja (verificado 2026-07-07, ver KEPLER_TABLAS_COMPLETO.md):
 *   c1=suc c2=caja c3=folio c5=fecha_apertura c6=hora_ap c7=cajero_ap c8=cajero_cierre
 *   c10=fecha_cierre c11=hora_cierre c13=turno
 *   c15=efectivo ESPERADO  c25=efectivo CONTADO  c35=DIFERENCIA(=c15−c25)
 *   c16/c26/c36=tarjeta esp/cont/DIFF  c17/c27/c37=transf esp/cont/DIFF
 *   c43/c44/c45=arqueo billetes/monedas/otros  c48=efectivo retirado  c49≈c15 (NO venta total)
 *   venta_total real = c15+c16+c17 (efectivo+tarjeta+transf esperados).
 * Corte ABIERTO: c10='1800-01-01', montos en 0 → se ignora (solo cerrados: c25<>0 OR c35<>0).
 *
 * Uso (desde database/):
 *   node importers/kepler/import-cash-cuts.js            # dry-run (lee+resume, NO escribe)
 *   DATABASE_URL_NEW='postgres://…?sslmode=no-verify' node importers/kepler/import-cash-cuts.js --apply
 *   SALES_BRANCH_MAP='[…]'  override de sucursales (mismo formato que live-tickets-poller)
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

async function readBranch(b) {
  const c = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 6000, statement_timeout: 30000 });
  await c.connect();
  try {
    // Solo cortes CERRADOS con actividad (ignora abiertos c10=1800 / montos 0).
    // Filtro c1 = sucursal propia (las DBs arrastran réplicas de otras sucursales).
    const r = await c.query(
      `SELECT c1 AS suc, c2 AS caja, c3 AS folio, c5::date AS fecha,
              c5 AS opened_at, NULLIF(c10,'1800-01-01')::timestamptz AS closed_at,
              c7 AS cajero_ap, c8 AS cajero_cierre, c13 AS turno,
              c15::numeric AS ef_esp, c25::numeric AS ef_cont, c35::numeric AS ef_diff,
              c16::numeric AS tj_esp, c26::numeric AS tj_cont, c36::numeric AS tj_diff,
              c17::numeric AS tr_esp, c27::numeric AS tr_cont, c37::numeric AS tr_diff,
              c43::numeric AS arq_bil, c44::numeric AS arq_mon, c45::numeric AS arq_otros,
              c48::numeric AS retirado, c49::numeric AS total
       FROM md.kdpv_folio_caja
       WHERE c1 = $1 AND (c25::numeric <> 0 OR c35::numeric <> 0)`,
      [b.code],
    );
    return r.rows.map((x) => {
      const efEsp = num(x.ef_esp), tjEsp = num(x.tj_esp), trEsp = num(x.tr_esp);
      return {
        warehouse_code: b.code,
        warehouse_name: b.name,
        caja: String(x.caja),
        folio: String(x.folio),
        business_date: x.fecha,
        opened_at: x.opened_at,
        closed_at: x.closed_at,
        cajero_apertura: x.cajero_ap ? String(x.cajero_ap).trim() : null,
        cajero_cierre: x.cajero_cierre ? String(x.cajero_cierre).trim() : null,
        turno: x.turno ? String(x.turno).trim() : null,
        efectivo_esperado: efEsp, efectivo_contado: num(x.ef_cont), efectivo_diff: num(x.ef_diff),
        tarjeta_esperado: tjEsp, tarjeta_contado: num(x.tj_cont), tarjeta_diff: num(x.tj_diff),
        transfer_esperado: trEsp, transfer_contado: num(x.tr_cont), transfer_diff: num(x.tr_diff),
        arqueo_billetes: num(x.arq_bil), arqueo_monedas: num(x.arq_mon), arqueo_otros: num(x.arq_otros),
        efectivo_retirado: num(x.retirado),
        total_venta: num(x.total),
        venta_total: Math.round((efEsp + tjEsp + trEsp) * 100) / 100,
      };
    });
  } finally {
    await c.end();
  }
}

async function upsert(db, rows) {
  let n = 0;
  for (const r of rows) {
    await db('analytics.cash_cuts')
      .insert({ tenant_id: TENANT, ...r, cerrado: true, source: 'kepler' })
      .onConflict(['tenant_id', 'warehouse_code', 'caja', 'business_date', 'folio'])
      .merge({
        efectivo_esperado: r.efectivo_esperado, efectivo_contado: r.efectivo_contado, efectivo_diff: r.efectivo_diff,
        tarjeta_esperado: r.tarjeta_esperado, tarjeta_contado: r.tarjeta_contado, tarjeta_diff: r.tarjeta_diff,
        transfer_esperado: r.transfer_esperado, transfer_contado: r.transfer_contado, transfer_diff: r.transfer_diff,
        arqueo_billetes: r.arqueo_billetes, arqueo_monedas: r.arqueo_monedas, arqueo_otros: r.arqueo_otros,
        efectivo_retirado: r.efectivo_retirado, total_venta: r.total_venta, venta_total: r.venta_total,
        cajero_cierre: r.cajero_cierre, closed_at: r.closed_at, updated_at: db.fn.now(),
      });
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
      console.log(`[${b.db}] ${rows.length} cortes cerrados`);
    } catch (e) {
      console.warn(`[${b.db}] ERROR: ${e.message}`);
    }
  }
  const conDescuadre = all.filter((r) => Math.abs(r.efectivo_diff) >= 50);
  const sumaDiff = Math.round(all.reduce((s, r) => s + r.efectivo_diff, 0) * 100) / 100;
  console.log(`\nTOTAL: ${all.length} cortes · ${conDescuadre.length} con |diff|≥$50 · suma diff $${sumaDiff}`);
  conDescuadre.sort((a, b) => Math.abs(b.efectivo_diff) - Math.abs(a.efectivo_diff)).slice(0, 8)
    .forEach((r) => console.log(`  suc${r.warehouse_code} caja${r.caja} ${r.business_date?.toISOString?.().slice(0, 10) || r.business_date} cajero=${r.cajero_cierre} diff=$${r.efectivo_diff}`));

  if (!APPLY) { console.log('\n(dry-run — usar --apply para escribir a analytics.cash_cuts)'); return; }
  if (!process.env.DATABASE_URL_NEW) { console.error('ERROR: --apply requiere DATABASE_URL_NEW'); process.exit(1); }
  const isLocal = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW || '');
  const db = knexLib({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: isLocal ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } });
  const n = await upsert(db, all);
  console.log(`✅ UPSERT ${n} cortes a analytics.cash_cuts`);
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
