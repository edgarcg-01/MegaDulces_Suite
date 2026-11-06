/* eslint-disable no-console */
/**
 * MAAT.1 — Balanza de comprobación + cadena de aprovisionamiento → analytics.*
 *
 * Feed 1: `analytics.ledger_monthly` — TODAS las familias (1-9) agregadas por
 *   (sucursal, cuenta, mes) desde las tablas `kdc2YYMM`. Es la balanza cruda:
 *   cargos/abonos/neto sin elegir capas (la interpretación — presupuesto vs
 *   factura, traspasos, IVA en 511 — vive en finance.knowledge y en el LLM).
 *   El mes canónico es el de la TABLA (no c2, que llega retro-fechada).
 *
 * Feed 2: `analytics.expense_doc_chain` — por cada factura de compra XA2001,
 *   reconstruye orden (XA3501) → recepción (XA3701) → factura → pago programado
 *   (XA4001) usando el puntero kdm1.c39 (descifrado 2026-07-06):
 *     factura.c39 → pago.folio · pago.c39 → recepción.folio · recepción.c39 → orden.folio
 *   Cada salto se valida con beneficiario+total idénticos; si el puntero falla,
 *   se infiere por (beneficiario, total, fecha ±10d). confidence: exact|inferred|partial.
 *
 * `[CANON.5.13]` (2026-11-06) — por default lee `kepler_ods` (la columna `sucursal` es la base de
 * origen; el mismo filtro de la propia: c14 en la póliza, c1 en el documento). `--source=branch`
 * conserva la conexión a cada POS.
 *
 *   node database/importers/kepler/import-ledger-chain.js               # dry-run (12 meses)
 *   node database/importers/kepler/import-ledger-chain.js --apply       # commit
 *   ... --months 19 · --source=branch                                   # ventana balanza · POS
 *   EXPENSES_BRANCH_MAP='[{"code":"03","url":"..."}]' node ...          # override sucursales
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 12))));
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
if (!['ods', 'branch'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (ods | branch)`);

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { stockMap } = require('../lib/kepler-branches');
const MAP = process.env.EXPENSES_BRANCH_MAP ? JSON.parse(process.env.EXPENSES_BRANCH_MAP) : stockMap({ cedis: true });

async function bulkInsert(db, table, cols, rows) {
  const N = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((row, ri) => {
      vals.push(`(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`);
      params.push(...row);
    });
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
  }
}

function monthWindow(n) {
  const now = new Date();
  const tables = [];
  let y = now.getFullYear(), m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    tables.push({ tbl: `kdc2${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`, ym: `${y}-${String(m).padStart(2, '0')}` });
    m--; if (m === 0) { m = 12; y--; }
  }
  return tables;
}

const normBenef = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const sameTotal = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.5;
const DAY = 86400000;
const daysBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / DAY) : null);

const DOC_TIPO = `(c2||c3||lpad(c4::text,2,'0')||lpad(c5::text,2,'0'))`;
// La inferencia de la cadena consume candidatos en el orden en que llegan: sin ORDER BY, el orden físico
// de las filas decidía qué factura se quedaba con un candidato compartido (28 de 14,806 cambiaban al
// pasar de las bases al ODS). Ahora gana la factura más antigua.
const DOCS_ORDEN = 'tipo, fecha, folio';
const CADENA = `('XA3501','XA3701','XA2001','XA4001')`;
const balanzaSql = (from, suc) => `SELECT ${suc} AS sucursal, c3 AS cuenta,
        SUM(CASE WHEN c4='C' THEN c5 ELSE 0 END)::numeric AS cargos,
        SUM(CASE WHEN c4='A' THEN c5 ELSE 0 END)::numeric AS abonos,
        COUNT(*)::int AS movs
   FROM ${from}
  WHERE c3 IS NOT NULL AND COALESCE(c5,0) <> 0
    AND (c14 IS NULL OR btrim(c14) = '' OR btrim(c14) = ${suc})`;
const docsSql = (from, suc) => `SELECT ${suc} AS sucursal, ${DOC_TIPO} AS tipo, c6 AS folio,
        c9::date AS fecha, NULLIF(btrim(c32),'') AS benef, c16::numeric AS total,
        NULLIF(btrim(c39::text),'') AS next_folio
   FROM ${from}
  WHERE c63 ~ '^X' AND c6 IS NOT NULL
    AND (c1 IS NULL OR btrim(c1) = '' OR btrim(c1) = ${suc})
    AND ${DOC_TIPO} IN ${CADENA}`;

/** Por base: catálogo de cuentas, balanza por mes y documentos de la cadena.
 *  Map(code → { acc, balanza: Map(tbl → rows), docs }). Una base sin conexión (branch) o sin un
 *  solo renglón (ods) queda fuera: sus filas no se tocan. */
async function readSource(db, tables) {
  const porBase = new Map();
  const skipped = [];
  const nueva = () => ({ acc: new Map(), balanza: new Map(), docs: [] });
  if (SOURCE === 'ods') {
    const codes = MAP.map((b) => b.code);
    for (const c of codes) porBase.set(c, nueva());
    // catálogo (kdco es sucio: min(c2) por código — un JOIN plano duplica en familia 6)
    for (const r of (await db.query(`SELECT sucursal, c3 AS code, min(c2) AS nombre FROM kepler_ods.kdco
         WHERE sucursal = ANY($1) AND c3 IS NOT NULL GROUP BY 1, 2`, [codes])).rows) porBase.get(r.sucursal).acc.set(r.code, r.nombre);
    for (const t of tables) {
      if (!(await db.query(`SELECT to_regclass('kepler_ods.${t.tbl}') AS r`)).rows[0].r) continue;
      for (const r of (await db.query(`${balanzaSql(`kepler_ods.${t.tbl}`, 'sucursal')} AND sucursal = ANY($1) GROUP BY 1, 2`, [codes])).rows) {
        const m = porBase.get(r.sucursal).balanza; if (!m.has(t.tbl)) m.set(t.tbl, []); m.get(t.tbl).push(r);
      }
    }
    for (const r of (await db.query(`${docsSql('kepler_ods.kdm1', 'sucursal')} AND sucursal = ANY($1) ORDER BY ${DOCS_ORDEN}`, [codes])).rows) porBase.get(r.sucursal).docs.push(r);
    for (const [code, x] of porBase) if (!x.balanza.size && !x.docs.length) { porBase.delete(code); skipped.push({ code, nota: 'sin renglones en el ODS' }); }
    return { porBase, skipped };
  }
  for (const b of MAP) {
    const src = new Client({ connectionString: b.url });
    try { await src.connect(); }
    catch (e) { console.log(`  ⚠ sucursal ${b.code}: sin conexión (${e.message}) — skip`); skipped.push({ code: b.code, nota: 'sin conexión' }); continue; }
    try {
      const x = nueva();
      for (const r of (await src.query(`SELECT c3 AS code, min(c2) AS nombre FROM md.kdco WHERE c3 IS NOT NULL GROUP BY c3`)).rows) x.acc.set(r.code, r.nombre);
      for (const t of tables) {
        if (!(await src.query(`SELECT to_regclass('md.${t.tbl}') AS r`)).rows[0].r) continue;
        // Solo la sucursal PROPIA: las DBs arrastran réplicas de otras sucursales
        // (verificado: DB03 tiene las filas '02' de dic/ene 100% duplicadas en DB02).
        x.balanza.set(t.tbl, (await src.query(`${balanzaSql(`md.${t.tbl}`, '$1::text')} GROUP BY 2`, [b.code])).rows);
      }
      // c1 = sucursal del documento — filtrar a la propia (DB03 arrastra ~2k docs de la 02).
      x.docs = (await src.query(`${docsSql('md.kdm1', '$1::text')} ORDER BY ${DOCS_ORDEN}`, [b.code])).rows;
      porBase.set(b.code, x);
    } finally { await src.end(); }
  }
  return { porBase, skipped };
}

/** Lo que el importer escribiría: filas de balanza y de cadena (mismo orden de columnas que el staging). */
async function collect(db, tables) {
  const { porBase, skipped } = await readSource(db, tables);
  const ledgerRows = [], chainRows = [];
  const summary = skipped.map((s) => ({ code: s.code, cuentas_mes: 0, facturas: 0, exact: 0, nota: s.nota }));
  for (const b of MAP) {
    const x = porBase.get(b.code);
    if (!x) continue;
    const { acc } = x;

    // ── Feed 1: balanza por mes ──
    let cuentasMes = 0;
    for (const t of tables) {
      const rows = x.balanza.get(t.tbl);
      if (!rows) continue;
      for (const r of rows) {
        const mayor = String(r.cuenta).split('-')[0];
        ledgerRows.push([r.sucursal, r.cuenta, acc.get(r.cuenta) || null, mayor, acc.get(mayor) || null,
          String(r.cuenta).slice(0, 1), t.ym, Number(r.cargos) || 0, Number(r.abonos) || 0, Number(r.movs) || 0]);
        cuentasMes++;
      }
    }

    // ── Feed 2: cadena de aprovisionamiento (kdm1, snapshot completo) ──
    const byType = { XA3501: new Map(), XA3701: new Map(), XA2001: new Map(), XA4001: new Map() };
    const byBT = { XA3501: new Map(), XA3701: new Map(), XA4001: new Map() }; // (benef|total) → rows, para inferencia
    for (const d of x.docs) {
      byType[d.tipo].set(String(d.folio).trim(), d);
      if (byBT[d.tipo]) {
        const k = `${normBenef(d.benef)}|${Number(d.total || 0).toFixed(2)}`;
        if (!byBT[d.tipo].has(k)) byBT[d.tipo].set(k, []);
        byBT[d.tipo].get(k).push(d);
      }
    }

    const usedInferred = new Set(); // tipo|folio ya consumido por inferencia (evita reusar el mismo candidato)
    // Salto de la cadena: puntero c39 validado con benef+total; fallback inferencia por (benef, total, fecha ±10d).
    const hop = (fromRow, toType, benef, total, refFecha) => {
      const ptr = fromRow?.next_folio ? byType[toType].get(String(fromRow.next_folio).trim()) : null;
      if (ptr && normBenef(ptr.benef) === normBenef(benef) && sameTotal(ptr.total, total)) return { row: ptr, exact: true };
      const cands = byBT[toType]?.get(`${normBenef(benef)}|${Number(total || 0).toFixed(2)}`) || [];
      let best = null, bestDist = 11;
      for (const c of cands) {
        if (usedInferred.has(`${toType}|${c.folio}`)) continue;
        const dist = Math.abs(daysBetween(refFecha, c.fecha) ?? 99);
        if (dist < bestDist) { best = c; bestDist = dist; }
      }
      if (best) { usedInferred.add(`${toType}|${best.folio}`); return { row: best, exact: false }; }
      return null;
    };

    let exactN = 0, inferredN = 0, partialN = 0, facturas = 0;
    for (const f of byType.XA2001.values()) {
      const pago = hop(f, 'XA4001', f.benef, f.total, f.fecha);
      const recep = hop(pago?.row || f, 'XA3701', f.benef, f.total, f.fecha);
      const orden = hop(recep?.row || f, 'XA3501', f.benef, f.total, f.fecha);
      const allExact = pago?.exact && recep?.exact && orden?.exact;
      const complete = pago && recep && orden;
      const confidence = complete ? (allExact ? 'exact' : 'inferred') : 'partial';
      if (confidence === 'exact') exactN++; else if (confidence === 'inferred') inferredN++; else partialN++;
      facturas++;
      chainRows.push([
        b.code, f.folio, f.fecha,
        orden?.row.folio || null, orden?.row.fecha || null,
        recep?.row.folio || null, recep?.row.fecha || null,
        pago?.row.folio || null, pago?.row.fecha || null,
        f.benef || null, Number(f.total) || 0,
        daysBetween(orden?.row.fecha, f.fecha), daysBetween(f.fecha, pago?.row.fecha),
        confidence,
      ]);
    }
    summary.push({ code: b.code, cuentas_mes: cuentasMes, facturas, exact: exactN, inferred: inferredN, partial: partialN });
  }
  return { ledgerRows, chainRows, okCodes: [...porBase.keys()], summary };
}

async function run() {
  const tables = monthWindow(MONTHS);
  const yms = tables.map((t) => t.ym);
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== MAAT.1 balanza + cadena (${APPLY ? 'APPLY' : 'DRY-RUN'}) · fuente ${SOURCE} ===`);
    console.log(`Balanza: ${MONTHS} meses (${yms[yms.length - 1]} … ${yms[0]})\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const { ledgerRows, chainRows, okCodes, summary } = await collect(db, tables);
    console.table(summary);
    console.log(`Staging: ${ledgerRows.length} filas de balanza · ${chainRows.length} cadenas.`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!okCodes.length) { await db.query('ROLLBACK'); console.log('\n[APPLY] Ninguna sucursal conectó — nada que aplicar.'); return; }

    await db.query(`CREATE TEMP TABLE stg_ledger (
      sucursal text, cuenta text, cuenta_nombre text, cuenta_mayor text, cuenta_mayor_nombre text,
      familia text, anio_mes text, cargos numeric, abonos numeric, movs int) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_chain (
      sucursal text, factura_folio text, factura_fecha date, orden_folio text, orden_fecha date,
      recepcion_folio text, recepcion_fecha date, pago_folio text, pago_fecha date,
      beneficiario text, total numeric, lead_days int, pago_days int, match_confidence text) ON COMMIT DROP`);
    await bulkInsert(db, 'stg_ledger',
      ['sucursal', 'cuenta', 'cuenta_nombre', 'cuenta_mayor', 'cuenta_mayor_nombre', 'familia', 'anio_mes', 'cargos', 'abonos', 'movs'],
      ledgerRows);
    await bulkInsert(db, 'stg_chain',
      ['sucursal', 'factura_folio', 'factura_fecha', 'orden_folio', 'orden_fecha', 'recepcion_folio', 'recepcion_fecha',
        'pago_folio', 'pago_fecha', 'beneficiario', 'total', 'lead_days', 'pago_days', 'match_confidence'],
      chainRows);

    // UPSERT update-in-place (SIN DELETE): re-postear un mes actualiza los importes de las
    // cuentas presentes; no churn de filas en Railway (regla del proyecto: actualizar, no
    // borrar). Meses cerrados no pierden cuentas → no quedan filas huérfanas.
    // GROUP BY solo la PK (nombres via MAX): dos fuentes con el mismo código no chocan el
    // INSERT aunque sus kdco difieran.
    const upL = await db.query(
      `INSERT INTO analytics.ledger_monthly
         (tenant_id,sucursal,cuenta,cuenta_nombre,cuenta_mayor,cuenta_mayor_nombre,familia,anio_mes,cargos,abonos,neto,movs,computed_at)
       SELECT $1,sucursal,cuenta,MAX(cuenta_nombre),MAX(cuenta_mayor),MAX(cuenta_mayor_nombre),MAX(familia),anio_mes,
              SUM(cargos),SUM(abonos),SUM(cargos)-SUM(abonos),SUM(movs),now()
         FROM stg_ledger
        GROUP BY sucursal,cuenta,anio_mes
       ON CONFLICT (tenant_id,sucursal,cuenta,anio_mes) DO UPDATE SET
         cuenta_nombre=EXCLUDED.cuenta_nombre, cuenta_mayor=EXCLUDED.cuenta_mayor,
         cuenta_mayor_nombre=EXCLUDED.cuenta_mayor_nombre, familia=EXCLUDED.familia,
         cargos=EXCLUDED.cargos, abonos=EXCLUDED.abonos, neto=EXCLUDED.neto,
         movs=EXCLUDED.movs, computed_at=now()`,
      [M]);

    // Cadena: UPSERT DO UPDATE (antes DELETE+DO NOTHING) → refresca la cadena cuando el
    // pago/recepción se agrega después, sin borrar y re-insertar toda la sucursal.
    const upC = await db.query(
      `INSERT INTO analytics.expense_doc_chain
         (tenant_id,sucursal,factura_folio,factura_fecha,orden_folio,orden_fecha,recepcion_folio,recepcion_fecha,
          pago_folio,pago_fecha,beneficiario,total,lead_days,pago_days,match_confidence,computed_at)
       SELECT $1,sucursal,factura_folio,factura_fecha,orden_folio,orden_fecha,recepcion_folio,recepcion_fecha,
              pago_folio,pago_fecha,beneficiario,total,lead_days,pago_days,match_confidence,now()
         FROM stg_chain
       ON CONFLICT (tenant_id,sucursal,factura_folio) DO UPDATE SET
         factura_fecha=EXCLUDED.factura_fecha, orden_folio=EXCLUDED.orden_folio, orden_fecha=EXCLUDED.orden_fecha,
         recepcion_folio=EXCLUDED.recepcion_folio, recepcion_fecha=EXCLUDED.recepcion_fecha,
         pago_folio=EXCLUDED.pago_folio, pago_fecha=EXCLUDED.pago_fecha, beneficiario=EXCLUDED.beneficiario,
         total=EXCLUDED.total, lead_days=EXCLUDED.lead_days, pago_days=EXCLUDED.pago_days,
         match_confidence=EXCLUDED.match_confidence, computed_at=now()`,
      [M]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — balanza: ${upL.rowCount} upserted · cadena: ${upC.rowCount} upserted (update-in-place, sin DELETE).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
}

module.exports = { collect, monthWindow };
if (require.main === module) run();
