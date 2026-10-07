/* eslint-disable no-console */
/**
 * RD.3 — Alimenta `analytics.route_cost_snapshot`. Dos modos, dos orígenes.
 *
 *   --excel    carga el COSTO de la hoja `CONTROL DE INFORMACIÓN`… (CONCENTRADO) como
 *              `origen='excel_captura'`. Es el registro CONTEMPORÁNEO: lo que la persona
 *              tecleó cuando el dato era fresco. Para ene–ago 2026 es el único que existe,
 *              porque lo que la réplica tiene hoy ya está re-expresado. Corre UNA vez.
 *
 *   --erp      observa lo que `analytics.v_rd_route_daily` dice AHORA y lo guarda como
 *              `origen='erp_observado'`, **sólo si cambió** respecto de la última
 *              observación de ese día. Va agendado (diario). Cada corrida que no encuentra
 *              cambios no escribe nada, y eso también es información: significa que el
 *              costo de esos días ya se asentó.
 *
 * El punto de la deriva: hoy nadie sabe si el costo de Wincaja se estabiliza en 2 días o en
 * 20. Guardando cada cambio, `v_route_cost_resolved.deriva_erp_pct` lo contesta con datos
 * en unas semanas, en vez de que elijamos una ventana a ojo.
 *
 *   node database/importers/logistics/snapshot-route-cost.js --erp                 # dry-run
 *   node database/importers/logistics/snapshot-route-cost.js --erp --apply [--days 90]
 *   node database/importers/logistics/snapshot-route-cost.js --excel --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const MODO_EXCEL = process.argv.includes('--excel');
const MODO_ERP = process.argv.includes('--erp');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const arg = (f, d) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('--days', 120));
const FILE = arg('--file', 'C:/Users/Sistemas/Downloads/INDICADORES RD 2026.xlsx');

// CONCENTRADO: bloques de 4 cols por ruta, stride 5 (COSTO, SUBTOTAL, VENTA, %, blanco).
const BLOQUES = [
  ['21', 'D'], ['22', 'I'], ['23', 'N'], ['26', 'S'], ['27', 'X'], ['28', 'AC'],
  ['501', 'AH'], ['502', 'AM'], ['503', 'AR'], ['504', 'AW'], ['505', 'BB'],
  ['321', 'BG'], ['322', 'BL'],
];
const colNum = (s) => s.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

const db = () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
  return knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) ? { rejectUnauthorized: false } : false },
    pool: { min: 0, max: 3 },
  });
};

async function desdeExcel() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.getWorksheet('CONCENTRADO DE INFORMACIÓN');
  if (!ws) throw new Error('No existe la hoja CONCENTRADO DE INFORMACIÓN');

  const num = (v) => {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && typeof v.result === 'number') return v.result;
    return null;
  };
  const fecha = (v) => {
    const d = v instanceof Date ? v : (v && v.result instanceof Date ? v.result : null);
    return d ? d.toISOString().slice(0, 10) : null;
  };

  const filas = [];
  for (let r = 5; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const f = fecha(row.getCell(1).value);
    if (!f) continue;
    for (const [ruta, col0] of BLOQUES) {
      const c0 = colNum(col0);
      const costo = num(row.getCell(c0).value);
      const subtotal = num(row.getCell(c0 + 1).value);
      const venta = num(row.getCell(c0 + 2).value);
      if (!costo && !subtotal && !venta) continue;
      filas.push({
        tenant_id: TENANT, route_code: ruta, business_date: f, origen: 'excel_captura',
        observed_at: new Date('2026-09-02T00:00:00Z'), // últ. modificación del workbook
        costo, subtotal, venta,
        notes: 'CONCENTRADO DE INFORMACION — registro contemporaneo, tecleado cuando el dato era fresco',
      });
    }
  }
  console.log(`CONCENTRADO → ${filas.length} observaciones ruta×día`);
  console.log(`  con costo: ${filas.filter((f) => f.costo).length} · Σ costo $${filas.reduce((s, f) => s + (f.costo || 0), 0).toFixed(2)}`);
  return filas;
}

async function desdeErp(k) {
  const { rows } = await k.raw(
    `SELECT route_code, business_date, costo, subtotal, venta, lineas
       FROM analytics.v_rd_route_daily
      WHERE tenant_id = ? AND business_date >= current_date - ?::int
      ORDER BY business_date, route_code`, [TENANT, DAYS]);
  // Sólo lo que CAMBIÓ respecto de la última observación de ese (ruta, día).
  const { rows: previas } = await k.raw(
    `SELECT DISTINCT ON (route_code, business_date)
            route_code, business_date::text AS d, costo
       FROM analytics.route_cost_snapshot
      WHERE tenant_id = ? AND origen = 'erp_observado' AND business_date >= current_date - ?::int
      ORDER BY route_code, business_date, observed_at DESC`, [TENANT, DAYS]);
  const ult = new Map(previas.map((p) => [`${p.route_code}|${p.d}`, p.costo === null ? null : Number(p.costo)]));

  const nuevas = [];
  let sinCambio = 0;
  for (const r of rows) {
    const d = String(r.business_date).slice(0, 10);
    const key = `${r.route_code}|${d}`;
    const antes = ult.has(key) ? ult.get(key) : undefined;
    const ahora = r.costo === null ? null : Number(r.costo);
    if (antes !== undefined && antes === ahora) { sinCambio++; continue; }
    nuevas.push({
      tenant_id: TENANT, route_code: r.route_code, business_date: d, origen: 'erp_observado',
      costo: ahora, subtotal: r.subtotal, venta: r.venta, lineas: r.lineas,
      notes: antes === undefined ? 'primera observacion' : `cambio desde ${antes}`,
    });
  }
  console.log(`v_rd_route_daily (últimos ${DAYS} días) → ${rows.length} filas ruta×día`);
  console.log(`  sin cambio: ${sinCambio} · a guardar: ${nuevas.length}` +
    (nuevas.length ? ` (${nuevas.filter((n) => n.notes === 'primera observacion').length} primeras, ${nuevas.filter((n) => n.notes !== 'primera observacion').length} derivas)` : ''));
  return nuevas;
}

(async () => {
  if (!MODO_EXCEL && !MODO_ERP) {
    console.error('Elegí un modo: --excel  o  --erp');
    process.exit(1);
  }
  console.log(`\n=== RD.3 · snapshot de costo de ruta (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  const k = db();
  try {
    const filas = MODO_EXCEL ? await desdeExcel() : await desdeErp(k);
    if (!filas.length) { console.log('\nnada que guardar.\n'); return; }
    if (!APPLY) { console.log('\n(dry-run — usar --apply)\n'); return; }

    const ahora = new Date();
    for (const f of filas) if (!f.observed_at) f.observed_at = ahora;
    await k.transaction(async (trx) => {
      for (let i = 0; i < filas.length; i += 500) {
        await trx('analytics.route_cost_snapshot')
          .insert(filas.slice(i, i + 500))
          .onConflict(['tenant_id', 'route_code', 'business_date', 'origen', 'observed_at']).ignore();
      }
    });
    const { rows: [chk] } = await k.raw(
      `SELECT origen, count(*)::int n, count(DISTINCT (route_code, business_date))::int dias
         FROM analytics.route_cost_snapshot WHERE tenant_id = ? GROUP BY 1 ORDER BY 1`, [TENANT])
      .then((r) => ({ rows: r.rows.length ? r.rows : [{}] }));
    const { rows: resumen } = await k.raw(
      `SELECT origen, count(*)::int n FROM analytics.route_cost_snapshot WHERE tenant_id = ? GROUP BY 1 ORDER BY 1`, [TENANT]);
    console.log(`\n✅ guardadas ${filas.length} observaciones`);
    resumen.forEach((r) => console.log(`   ${r.origen.padEnd(16)} ${r.n} filas`));
    void chk;
  } finally {
    await k.destroy();
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
