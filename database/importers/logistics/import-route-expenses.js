/* eslint-disable no-console */
/**
 * RD.4 — Carga la hoja `CONTROL DE GASTOS RD` de `INDICADORES RD 2026.xlsx` a
 * `logistics.route_expenses`.
 *
 * Es un backfill del histórico: de acá en adelante la captura va por la pantalla
 * (`POST /logistics/route-expenses`), con la misma validación. Mismo camino que CB.1 → CB.2.1.
 *
 * ── EL CUADRE VA ANTES DE ESCRIBIR ──────────────────────────────────────────────────────
 * Se compara la suma parseada contra la **columna cruda** `J3:J2057` de la hoja, y si no
 * empatan al centavo aborta. NO se cuadra contra el "TOTAL POR TIPO DE GASTO" del propio
 * Excel: ese total está roto — `Z7 = SUM(O7,O23,O38,O47,O60,R7,R23,R38,R47,V7,V23,)` (con
 * coma colgando) apunta a bloques de resumen rotulados con rutas **24, 25, 300 y 301**, que
 * no existen en los datos, así que suma casi puros ceros y subdeclara el combustible en
 * ~$332,000 (dice $507,341.34 cuando la columna trae $839,850.02).
 *
 * ── IDEMPOTENTE ─────────────────────────────────────────────────────────────────────────
 * UPSERT por `(tenant, ruta, fecha, folio, tipo, total)`. El importe está en la llave porque
 * el folio se repite con montos distintos (medido: `501 · 2026-04-06 · folio 38438` con $105
 * y $859.73). Re-correr no duplica y actualiza proveedor/descripción/litros.
 *
 * ── LO QUE NO ADIVINA ───────────────────────────────────────────────────────────────────
 * 5 filas vienen sin tipo. Cuatro *parecen* gasolina y una "CAMBIOS DE MUELLES" *parece*
 * reparación. Entran con tipo `0 · SIN CLASIFICAR` y se corrigen desde la UI.
 *
 *   node database/importers/logistics/import-route-expenses.js                 # dry-run
 *   node database/importers/logistics/import-route-expenses.js --apply
 *   ... [--file "C:/ruta/al.xlsx"] [--sheet "CONTROL DE GASTOS RD"]
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const ExcelJS = require('exceljs');
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
};
const FILE = arg('--file', 'C:/Users/Sistemas/Downloads/INDICADORES RD 2026.xlsx');
const SHEET = arg('--sheet', 'CONTROL DE GASTOS RD');

// B..K = PERIODO · FECHA · RUTA · FACTURA/VALE · TIPO · PROVEEDOR · DESCRIPCION · LITROS · TOTAL · REMOTO
const COL = { periodo: 2, fecha: 3, ruta: 4, folio: 5, tipo: 6, proveedor: 7, descripcion: 8, litros: 9, total: 10, remoto: 11 };
const FILA_0 = 3;
const FILA_N = 2057; // el mismo rango que usan los SUMIFS de la hoja

/** Desenvuelve una celda: literal, fórmula cacheada, richText o fecha. */
const cel = (c) => {
  const v = c && c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if (v.result !== undefined) return v.result;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return v.text;
    return null;
  }
  return v;
};
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fecha = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : null);
const texto = (v) => { const s = v === null || v === undefined ? '' : String(v).trim(); return s || null; };

(async () => {
  console.log(`\n=== RD.4 · gasto de flota → logistics.route_expenses (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`archivo: ${FILE}\nhoja:    ${SHEET}\n`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) { console.error(`No existe la hoja "${SHEET}"`); process.exit(1); }

  // ── 1) Parse + el árbitro: la columna cruda ────────────────────────────────────────────
  const filas = [];
  let crudoTotal = 0; let crudoN = 0; let crudoLitros = 0;
  let sinFecha = 0; let sinRuta = 0;

  for (let r = FILA_0; r <= FILA_N; r++) {
    const row = ws.getRow(r);
    const total = numero(cel(row.getCell(COL.total)));
    if (total === null) continue;
    crudoTotal += total; crudoN++;
    const lt = numero(cel(row.getCell(COL.litros)));
    if (lt !== null) crudoLitros += lt;

    const f = fecha(cel(row.getCell(COL.fecha)));
    const ruta = texto(cel(row.getCell(COL.ruta)));
    if (!f) { sinFecha++; continue; }
    if (!ruta) { sinRuta++; continue; }

    const tipoRaw = numero(cel(row.getCell(COL.tipo)));
    filas.push({
      tenant_id: TENANT,
      route_code: ruta,
      expense_date: f,
      expense_type: tipoRaw === null ? 0 : tipoRaw, // 0 = SIN CLASIFICAR, no se adivina
      folio: texto(cel(row.getCell(COL.folio))) || '',
      supplier: texto(cel(row.getCell(COL.proveedor))),
      description: texto(cel(row.getCell(COL.descripcion))),
      liters: lt,
      total,
      is_remote: !!texto(cel(row.getCell(COL.remoto))),
      period_no: numero(cel(row.getCell(COL.periodo))),
      source: 'excel_import',
    });
  }

  const sumaParse = filas.reduce((s, f) => s + f.total, 0);
  const litrosParse = filas.reduce((s, f) => s + (f.liters || 0), 0);
  const d = (a, b) => Math.round((a - b) * 100) / 100;

  console.log(`columna cruda J${FILA_0}:J${FILA_N}   ${crudoN} celdas · $${crudoTotal.toFixed(2)} · ${crudoLitros.toFixed(2)} lts`);
  console.log(`parseado                  ${filas.length} filas   · $${sumaParse.toFixed(2)} · ${litrosParse.toFixed(2)} lts`);
  if (sinFecha || sinRuta) console.log(`descartadas: ${sinFecha} sin fecha · ${sinRuta} sin ruta`);

  if (Math.abs(d(sumaParse, crudoTotal)) > 0.01) {
    console.error(`\n❌ el parse NO cuadra con la columna cruda (Δ $${d(sumaParse, crudoTotal)}). Abortando: primero se entiende, después se carga.`);
    process.exit(1);
  }
  console.log('✅ el parse cuadra al centavo con la columna cruda\n');

  const porTipo = {};
  const sinClasificar = [];
  for (const f of filas) {
    porTipo[f.expense_type] = porTipo[f.expense_type] || { n: 0, total: 0, litros: 0 };
    porTipo[f.expense_type].n++; porTipo[f.expense_type].total += f.total; porTipo[f.expense_type].litros += f.liters || 0;
    if (f.expense_type === 0) sinClasificar.push(f);
  }
  console.log('por tipo:');
  for (const [k, v] of Object.entries(porTipo).sort()) {
    console.log(`  ${k}  ${String(v.n).padStart(4)} filas · $${v.total.toFixed(2).padStart(12)}${v.litros ? ` · ${v.litros.toFixed(2)} lts` : ''}`);
  }
  const rutas = [...new Set(filas.map((f) => f.route_code))].sort();
  console.log(`\nrutas (${rutas.length}): ${rutas.join(', ')}`);
  console.log(`rango: ${filas.reduce((m, f) => (m < f.expense_date ? m : f.expense_date), '9')} → ${filas.reduce((m, f) => (m > f.expense_date ? m : f.expense_date), '0')}`);
  if (sinClasificar.length) {
    console.log(`\n⚠️  ${sinClasificar.length} filas SIN TIPO — entran como 0 · SIN CLASIFICAR (no se adivina):`);
    sinClasificar.forEach((f) => console.log(`     ${f.expense_date} r${f.route_code} folio ${f.folio} $${f.total} — ${f.description || ''} / ${f.supplier || ''}`));
  }

  if (!APPLY) { console.log('\n(dry-run — usar --apply)\n'); return; }

  // ── 2) UPSERT ──────────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) ? { rejectUnauthorized: false } : false },
    pool: { min: 0, max: 3 },
  });

  try {
    const antes = (await db('logistics.route_expenses').where({ tenant_id: TENANT }).whereNull('deleted_at').count('* as n'))[0].n;
    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
      // Las rutas que el Excel trae y el catálogo de tipos no conoce harían fallar la FK.
      const tipos = new Set((await trx('logistics.route_expense_types').where({ tenant_id: TENANT }).select('code')).map((t) => t.code));
      const huerfanas = [...new Set(filas.map((f) => f.expense_type))].filter((t) => !tipos.has(t));
      if (huerfanas.length) throw new Error(`tipos no catalogados: ${huerfanas.join(', ')} — sembrá logistics.route_expense_types primero`);

      // El target del ON CONFLICT lleva el WHERE porque el índice único es PARCIAL
      // (`WHERE deleted_at IS NULL`): sin él, Postgres no lo reconoce y tira
      // "no unique or exclusion constraint matching the ON CONFLICT specification".
      const target = trx.raw('(tenant_id, route_code, expense_date, folio, expense_type, total) WHERE deleted_at IS NULL');
      for (let i = 0; i < filas.length; i += 500) {
        await trx('logistics.route_expenses')
          .insert(filas.slice(i, i + 500))
          .onConflict(target)
          .merge(['supplier', 'description', 'liters', 'is_remote', 'period_no', 'source', 'updated_at']);
      }
    });
    const despues = (await db('logistics.route_expenses').where({ tenant_id: TENANT }).whereNull('deleted_at').count('* as n'))[0].n;
    const { rows: [chk] } = await db.raw(
      `SELECT count(*)::int n, round(sum(total)::numeric,2) total, round(sum(liters)::numeric,2) litros
         FROM logistics.route_expenses WHERE tenant_id = ? AND deleted_at IS NULL AND source = 'excel_import'`, [TENANT]);
    console.log(`\n✅ en DB: ${chk.n} filas · $${chk.total} · ${chk.litros} lts   (antes ${antes} → después ${despues})`);
    if (Math.abs(d(Number(chk.total), sumaParse)) > 0.01) {
      console.error(`⚠️  lo escrito no empata con lo parseado (Δ $${d(Number(chk.total), sumaParse)}) — revisá colisiones de la llave natural`);
      process.exitCode = 1;
    } else {
      console.log('✅ lo escrito empata al centavo con lo parseado\n');
    }
  } finally {
    await db.destroy();
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
