/* eslint-disable no-console */
/**
 * PV.1 (Fase PV, ADR-041) — Detalle de pólizas de Kepler → analytics.gl_polizas + gl_poliza_lines
 * con source='kepler'. A diferencia de import-expenses-polizas.js (que guarda SOLO la pata de
 * cargo de 511/6xx), este trae la PARTIDA DOBLE COMPLETA (ambas patas, todas las familias) para
 * poder verificar el cuadre por póliza y el detalle por SUCURSAL (lo que ContPAQi consolida al ~2%).
 *
 * Modelo kdc2YYMM (verificado, ver KEPLER_CONTABILIDAD_MODELO.md):
 *   cuenta=c3 · cargo/abono=c4 ('C'|'A') · importe=c5 (c9 llega 0 → NO usar) · concepto=c6
 *   fecha=c2 · sucursal=c14 · linea=c10 · doc_tipo=c15||c16||lpad(c17,2)||lpad(c18,2) · folio=c19
 * Póliza = (sucursal, doc_tipo, folio). Las de diario/resumen tienen folio vacío → 'S/F'
 * (agregan; el cuadre fino por póliza es ContPAQi, esta fuente es el detalle por sucursal).
 *
 *   node database/importers/kepler/import-kepler-polizas.js               # dry-run (6 meses)
 *   node database/importers/kepler/import-kepler-polizas.js --apply --months 18
 *
 * READ-ONLY sobre Kepler. UPSERT idempotente. Filtra c5>0 (líneas $0 de cancelaciones).
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 800;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 6))));

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { stockMap } = require('../lib/kepler-branches');
const MAP = process.env.EXPENSES_BRANCH_MAP ? JSON.parse(process.env.EXPENSES_BRANCH_MAP) : stockMap({ cedis: true });

function monthWindow(n) {
  const now = new Date();
  const tables = [];
  let y = now.getFullYear(), m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    tables.push({ tbl: `kdc2${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`, y, m });
    m--; if (m === 0) { m = 12; y--; }
  }
  return tables;
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);

(async () => {
  console.log(`Kepler pólizas → ${APPLY ? 'APPLY' : 'DRY-RUN'} · ${MONTHS} meses · ${MAP.length} sucursales`);
  const tables = monthWindow(MONTHS);
  const heads = new Map();  // key → header row
  const lineOut = [];

  for (const b of MAP) {
    const src = new Client({ connectionString: b.url });
    try { await src.connect(); } catch (e) { console.warn(`  ⚠ suc ${b.code} sin conexión (${e.message}) — skip`); continue; }
    // catálogo de cuentas (kdco): c3=código, c2=nombre (sucio, min() para colapsar duplicados)
    let nameByAcct = new Map();
    try {
      const cat = await src.query(`SELECT c3 AS cod, min(c2) AS nom FROM md.kdco WHERE c3 IS NOT NULL GROUP BY c3`);
      nameByAcct = new Map(cat.rows.map((r) => [String(r.cod).trim(), (r.nom || '').trim()]));
    } catch { /* catálogo opcional */ }

    let bLines = 0;
    for (const t of tables) {
      // Las tablas de póliza viven en el schema `md` (no en public/search_path).
      const exists = (await src.query(`SELECT to_regclass('md.${t.tbl}') AS r`)).rows[0].r;
      if (!exists) continue; // el mes no existe en esa sucursal
      let rows;
      try {
        rows = (await src.query(
          `SELECT c14 AS suc, c2 AS fecha, c3 AS cuenta, c4 AS ca, c5 AS importe, c10 AS linea,
                  c6 AS concepto, (c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0')) AS doc_tipo,
                  NULLIF(btrim(c19::text),'') AS folio
             FROM md.${t.tbl}
            WHERE c5 > 0 AND c4 IN ('C','A')`)).rows;
      } catch (e) { console.warn(`  ⚠ ${b.code}/${t.tbl}: ${e.message}`); continue; }
      for (const r of rows) {
        const suc = String(r.suc || b.code).trim() || b.code;
        const folio = r.folio || 'S/F';
        const docTipo = (r.doc_tipo || '0000').trim();
        const cuenta = String(r.cuenta || '').trim();
        const am = `${t.y}-${String(t.m).padStart(2, '0')}`;
        const key = `${suc}|${docTipo}|${folio}|${t.y}|${t.m}`;
        const imp = round2(r.importe);
        if (!heads.has(key)) {
          heads.set(key, [M, 'kepler', suc, t.y, t.m, docTipo, folio, am, iso(r.fecha), (r.concepto || '').trim() || null, 0, 0, 0, 0, null, null]);
        }
        const h = heads.get(key);
        if (r.ca === 'C') h[10] = round2(h[10] + imp); else h[11] = round2(h[11] + imp);
        h[13]++;
        lineOut.push([
          M, 'kepler', suc, t.y, t.m, docTipo, folio, h[13],
          cuenta, nameByAcct.get(cuenta) || null, null,
          cuenta.split('-')[0], cuenta.slice(0, 1), r.ca, imp,
          (r.concepto || '').trim() || null, null, null, am,
        ]);
      }
      bLines += rows.length;
    }
    await src.end();
    console.log(`  suc ${b.code}: ${bLines} patas`);
  }

  const headOut = [...heads.values()].map((h) => { h[12] = round2(h[10] - h[11]); return h; });
  const descuadradas = headOut.filter((h) => Math.abs(h[12]) >= 0.01 && h[6] !== 'S/F').length;
  console.log(`  ${headOut.length} pólizas · ${lineOut.length} patas · con folio que no cuadran: ${descuadradas}`);

  if (!APPLY) { console.log('DRY-RUN — nada escrito. Corre con --apply.'); return; }

  const pg = new Client({ connectionString: DST });
  await pg.connect();
  await upsert(pg, 'analytics.gl_polizas',
    ['tenant_id', 'source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'fecha', 'concepto', 'cargos', 'abonos', 'neto', 'num_lines', 'guid', 'tiene_doc_bancario'],
    ['tenant_id', 'source', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'sucursal'], headOut);
  await upsert(pg, 'analytics.gl_poliza_lines',
    ['tenant_id', 'source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'num_movto', 'cuenta', 'cuenta_nombre', 'cuenta_afectable', 'cuenta_mayor', 'familia', 'cargo_abono', 'importe', 'referencia', 'cfdi_uuid', 'sat_agrupador', 'anio_mes'],
    ['tenant_id', 'source', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'sucursal', 'num_movto', 'cuenta', 'cargo_abono'], lineOut);
  await pg.end();
  console.log(`✅ UPSERT ${headOut.length} pólizas + ${lineOut.length} patas (source=kepler)`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

async function upsert(pg, table, cols, pk, rows) {
  const n = cols.length;
  const upd = cols.filter((c) => !pk.includes(c)).map((c) => `${c}=EXCLUDED.${c}`).join(',');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: n }, (_, k) => `$${j * n + k + 1}`).join(',')})`).join(',');
    await pg.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph}
       ON CONFLICT (${pk.join(',')}) DO UPDATE SET ${upd}, computed_at=now()`,
      chunk.flat());
  }
}
