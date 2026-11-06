/* eslint-disable no-console */
/**
 * GX.1 — Pólizas contables de EGRESOS (gastos + compras) → analytics.expense_entries.
 *
 * Lee las tablas mensuales `kdc2YYMM` de cada sucursal Kepler (READ-ONLY) + el
 * catálogo de cuentas `kdco`, y puebla analytics.expense_entries en prod.
 *
 * Modelo (verificado contra Kepler):
 *   egreso  = cargo (kdc.c4='C') a cuenta de compras/costo (511), gasto (6xx),
 *             activo no circulante (150) o financiero/impuesto (702-764)
 *             → familias del contrato `expense-family.contract.ts`. 701
 *             PRODUCTOS FINANCIEROS queda FUERA: es ingreso, no egreso.
 *   cuenta  = kdc.c3  ·  nombre = kdco.c2 (join por kdco.c3)
 *   importe = kdc.c5  (c9 llega 0 a veces → NO usar)
 *   benef   = kdc.c6  ·  fecha = kdc.c2  ·  sucursal = kdc.c14  ·  linea = kdc.c10
 *   doc     = c15||c16||lpad(c17,2)||lpad(c18,2) (ej. XA2001) + folio c19
 * Se arma desde las PÓLIZAS, no desde los documentos → 1 postura por transacción
 * (evita el 4× de las etapas XA20/35/37/40).
 *
 * Tabla mensual: `kdc2` + YY + MM  (2026-06 → kdc22606, 2025-01 → kdc22501).
 *
 * `[CANON.5.14]` (2026-11-06) — por default lee `kepler_ods` (catálogos, kdm1, kdm2 y pólizas de las 9
 * bases en una consulta cada uno; la columna `sucursal` es la base de origen). `--source=branch`
 * conserva la conexión a cada POS. Los Fix #B, #1 y #2 no cambian.
 *
 *   node database/importers/kepler/import-expenses-polizas.js               # dry-run (6 meses)
 *   node database/importers/kepler/import-expenses-polizas.js --apply       # commit
 *   ... --months 12 · --source=branch                                       # ventana de meses · POS
 *   EXPENSES_BRANCH_MAP='[{"code":"03","url":"..."}]' node ... --apply      # override sucursales
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

// Inserta filas (array de arrays) en una tabla por lotes de BATCH con placeholders.
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

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 6))));
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
if (!['ods', 'branch'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (ods | branch)`);

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { stockMap } = require('../lib/kepler-branches');
const MAP = process.env.EXPENSES_BRANCH_MAP ? JSON.parse(process.env.EXPENSES_BRANCH_MAP) : stockMap({ cedis: true });

// Meses a barrer (tabla kdc2YYMM) + rango de fechas de la ventana.
function monthWindow(n) {
  const now = new Date();
  const tables = [];
  let y = now.getFullYear(), m = now.getMonth() + 1; // 1..12
  for (let i = 0; i < n; i++) {
    const yy = String(y % 100).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    tables.push({ tbl: `kdc2${yy}${mm}`, y, m });
    m--; if (m === 0) { m = 12; y--; }
  }
  const last = tables[tables.length - 1];
  const from = `${last.y}-${String(last.m).padStart(2, '0')}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { tables, from, to };
}

// Normaliza el área/depto (kdm1.c48): mayúsculas, colapsa espacios, mapea typos.
const AREA_ALIASES = {
  '8ESQUINAS': '8 ESQUINAS',
  '8 ESQUIANS': '8 ESQUINAS',
  '8 EQUINAS': '8 ESQUINAS',
  'SUC 8 ESQUINAS': '8 ESQUINAS',
  '40 8 ESQUINAS SUCURSAL': '8 ESQUINAS',
  'ABASTOS LA PIEDAD': 'LA PIEDAD ABASTOS',
  'SUC LA PIEDAD ABASTOS': 'LA PIEDAD ABASTOS',
  'SUC LA PIEDAD': 'LA PIEDAD ABASTOS',
  'RECURSOS HUMANOS': 'RRHH',
  'FINANZA': 'FINANZAS',
};
function normArea(raw) {
  if (!raw) return null;
  const s = String(raw).toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return AREA_ALIASES[s] || s;
}

const DOC_POLIZA = `(c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0'))`;
const POLIZA_COLS = `c14 AS sucursal, ${DOC_POLIZA} AS doc_tipo,
        c19 AS doc_folio, c10::int AS linea, c2::date AS fecha,
        c3 AS cuenta, left(c3,1) AS familia, c4 AS cargo_abono,
        NULLIF(btrim(c6),'') AS beneficiario, c5::numeric AS importe,
        NULLIF(btrim(c13),'') AS dpto, NULLIF(btrim(c20),'') AS concepto_cod`;
/* dropea las ~609 líneas $0 'BAJA -'/canceladas (ruido). c19 folio-vacío = '' (no NULL) → se conserva la capa de diario/presupuesto; la distingue Fix#1. */
const POLIZA_WHERE = `c4='C' AND (c3='511' OR c3 LIKE '6%'
                        OR split_part(btrim(c3),'-',1) = '150'
                        OR split_part(btrim(c3),'-',1) BETWEEN '702' AND '764')
        AND COALESCE(c5,0) <> 0`;
const DOC_COLS = `(c2||c3||lpad(c4::text,2,'0')||lpad(c5::text,2,'0')) AS tipo, c6 AS folio, c48 AS area,
        c18::date AS fecha_doc, c14::numeric AS iva, c16::numeric AS importe,
        NULLIF(btrim(c22),'') AS rfc, NULLIF(btrim(c24),'') AS concepto,
        NULLIF(btrim(c32),'') AS beneficiario, NULLIF(btrim(c67),'') AS usuario, NULLIF(btrim(c31),'') AS clase`;
const LINEA_COLS = `c6 AS folio, c8 AS sku, NULLIF(btrim(c10),'') AS producto, c9::numeric AS cantidad,
        NULLIF(btrim(c11),'') AS presentacion, c12::numeric AS costo_unitario, c13::numeric AS importe`;
// Las líneas se numeran en el orden en que llegan: con sólo ORDER BY c6 el orden DENTRO del folio era el
// físico, y la numeración cambiaba de una noche a otra (29,173 de 36,296 líneas). c7 es el renglón de Kepler.
const LINEA_WHERE = `c2='X' AND c3='A' AND c4::int=20 AND c5::int=1 AND c6 IS NOT NULL`;

/** Lo crudo de cada base: catálogos, cabeceras (kdm1), pólizas por mes y líneas de compra (kdm2).
 *  Map(code → { kdco, kdc3, plan: [kdc125 rows, kdc126 rows], docs, polizas: Map(tbl → rows), lineas }).
 *  Una base sin conexión (branch) o sin un solo renglón de póliza ni documento (ods) queda fuera. */
async function readSource(db, tables) {
  const porBase = new Map();
  const skipped = [];
  const nueva = () => ({ kdco: [], kdc3: [], plan: [[], []], docs: [], polizas: new Map(), lineas: [] });
  if (SOURCE === 'ods') {
    const codes = MAP.map((b) => b.code);
    for (const c of codes) porBase.set(c, nueva());
    const reparte = (rows, put) => { for (const r of rows) put(porBase.get(r.base), r); };
    const existe = async (t) => (await db.query(`SELECT to_regclass('kepler_ods.${t}') AS r`)).rows[0].r;
    reparte((await db.query(`SELECT sucursal AS base, c3, c1, c2 FROM kepler_ods.kdco WHERE sucursal = ANY($1) AND c3 IS NOT NULL`, [codes])).rows, (x, r) => x.kdco.push(r));
    if (await existe('kdc3')) reparte((await db.query(`SELECT sucursal AS base, c1 AS code, c2 AS nombre FROM kepler_ods.kdc3 WHERE sucursal = ANY($1) AND c1 IS NOT NULL`, [codes])).rows, (x, r) => x.kdc3.push(r));
    for (const [i, tbl] of ['kdc125', 'kdc126'].entries()) {
      if (await existe(tbl)) reparte((await db.query(`SELECT sucursal AS base, c1 AS code, c2 AS nombre FROM kepler_ods.${tbl} WHERE sucursal = ANY($1) AND c1 IS NOT NULL`, [codes])).rows, (x, r) => x.plan[i].push(r));
    }
    reparte((await db.query(`SELECT sucursal AS base, ${DOC_COLS} FROM kepler_ods.kdm1 WHERE sucursal = ANY($1) AND c63 ~ '^X' AND c6 IS NOT NULL`, [codes])).rows, (x, r) => x.docs.push(r));
    for (const t of tables) {
      if (!(await existe(t.tbl))) continue;
      reparte((await db.query(`SELECT sucursal AS base, ${POLIZA_COLS} FROM kepler_ods.${t.tbl} WHERE sucursal = ANY($1) AND ${POLIZA_WHERE}`, [codes])).rows,
        (x, r) => { if (!x.polizas.has(t.tbl)) x.polizas.set(t.tbl, []); x.polizas.get(t.tbl).push(r); });
    }
    // Un fallo en las líneas (sólo el drill) NO debe abortar el feed de pólizas.
    try {
      await db.query('SAVEPOINT lineas');
      reparte((await db.query(`SELECT sucursal AS base, ${LINEA_COLS} FROM kepler_ods.kdm2 WHERE sucursal = ANY($1) AND ${LINEA_WHERE} ORDER BY c6, c7`, [codes])).rows, (x, r) => x.lineas.push(r));
      await db.query('RELEASE SAVEPOINT lineas');
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT lineas').catch(() => {});
      for (const x of porBase.values()) { x.lineas = []; x.lineasError = e.message; }
    }
    for (const [code, x] of porBase) if (!x.polizas.size && !x.docs.length) { porBase.delete(code); skipped.push({ code, nota: 'sin renglones en el ODS' }); }
    return { porBase, skipped };
  }
  for (const b of MAP) {
    const src = new Client({ connectionString: b.url });
    try { await src.connect(); }
    catch (e) { console.log(`  ⚠ sucursal ${b.code}: sin conexión (${e.message}) — skip`); skipped.push({ code: b.code, nota: 'sin conexión' }); continue; }
    try {
      const x = nueva();
      x.kdco = (await src.query(`SELECT c3, c1, c2 FROM md.kdco WHERE c3 IS NOT NULL`)).rows;
      // Puede no existir en algunas sucursales.
      try { x.kdc3 = (await src.query(`SELECT c1 AS code, c2 AS nombre FROM md.kdc3 WHERE c1 IS NOT NULL`)).rows; } catch { /* sucursal sin catálogo kdc3 */ }
      for (const [i, tbl] of ['kdc125', 'kdc126'].entries()) {
        try { x.plan[i] = (await src.query(`SELECT c1 AS code, c2 AS nombre FROM md.${tbl} WHERE c1 IS NOT NULL`)).rows; } catch { /* sucursal sin ese catálogo */ }
      }
      x.docs = (await src.query(`SELECT ${DOC_COLS} FROM md.kdm1 WHERE c63 ~ '^X' AND c6 IS NOT NULL`)).rows;
      for (const t of tables) {
        if (!(await src.query(`SELECT to_regclass('md.${t.tbl}') AS r`)).rows[0].r) continue;
        x.polizas.set(t.tbl, (await src.query(`SELECT ${POLIZA_COLS} FROM md.${t.tbl} WHERE ${POLIZA_WHERE}`)).rows);
      }
      try { x.lineas = (await src.query(`SELECT ${LINEA_COLS} FROM md.kdm2 WHERE ${LINEA_WHERE} ORDER BY c6, c7`)).rows; }
      catch (e) { x.lineasError = e.message; }
      porBase.set(b.code, x);
    } finally { await src.end(); }
  }
  return { porBase, skipped };
}

/** Lo que el importer pone en el staging ANTES de los Fix (#B, #1, #2), con el orden de columnas de
 *  stg_exp / stg_doc / stg_docline. */
async function collect(db, tables) {
  const { porBase, skipped } = await readSource(db, tables);
  const expRows = [], docRows = [], lineRows = [];
  const summary = skipped.map((s) => ({ code: s.code, movs: 0, monto: 0, nota: s.nota }));
  const docNotes = [];
  for (const b of MAP) {
    const x = porBase.get(b.code);
    if (!x) continue;
    // catálogo de cuentas de la sucursal: código → nombre
    const acc = new Map(x.kdco.map((r) => [r.c3, r.c2]));
    // catálogo de departamentos / centros de costo (kdc3): código c1 → nombre c2
    // (ej. '1-01-10-00' → 'PADRE HIDALGO PISO').
    const dep = new Map();
    for (const r of x.kdc3) {
      const code = String(r.code).trim();
      if (code) dep.set(code, r.nombre ? String(r.nombre).trim() : null);
    }
    // Plan de cuentas (kdc126, fallback kdc125): código → nombre de mayor/subcuenta.
    // kdco es catálogo de CONCEPTOS (N nombres por subcuenta) → no sirve para el
    // nombre de la cuenta; kdc126 sí trae '601'=SUELDOS Y SALARIOS y '601-001'=SUELDOS.
    const accName = new Map();
    for (const rows of x.plan) { // kdc126 último → pisa a kdc125 (más reciente)
      for (const r of rows) {
        const code = String(r.code).trim();
        if (code && r.nombre) accName.set(code, String(r.nombre).trim());
      }
    }
    // Conceptos (kdco): llave (subcuenta c3, concepto c1) → nombre. Distinto de `acc`
    // (por c3) porque una subcuenta tiene N conceptos.
    const conceptoMap = new Map();
    for (const r of x.kdco) {
      if (r.c1 != null && r.c2) conceptoMap.set(`${String(r.c3).trim()}|${String(r.c1).trim()}`, String(r.c2).trim());
    }
    // Cabeceras de documento (kdm1): área para las pólizas (docArea) + campos ricos
    // para el drill al documento (docHdr, solo XA2001 compras / XA1001 gastos).
    const docArea = new Map();
    const docHdr = new Map();
    for (const r of x.docs) {
      const k = `${r.tipo}-${r.folio}`;
      docArea.set(k, normArea(r.area));
      if (r.tipo === 'XA2001' || r.tipo === 'XA1001') docHdr.set(k, r);
    }

    const docMeta = new Map();      // clave tipo-folio → {doc_tipo,folio,fecha} de la póliza (fecha confiable)
    const compraFolios = new Set(); // folios 511 → tienen líneas de producto en kdm2
    let movs = 0, monto = 0;
    for (const t of tables) {
      const rows = x.polizas.get(t.tbl);
      if (!rows) continue;
      for (const r of rows) {
        const mayor = String(r.cuenta).split('-')[0];
        const dpto = r.dpto || null;
        const dk = `${r.doc_tipo}-${r.doc_folio}`;
        const hdr = docHdr.get(dk);
        const conceptoCod = r.concepto_cod || null;
        // Nombre de concepto: canónico por (subcuenta, código) desde kdco; si no,
        // para gastos (fam 6/7) cae al texto de la línea (c6, que YA es el concepto).
        const conceptoNombre = (conceptoCod && conceptoMap.get(`${r.cuenta}|${conceptoCod}`))
          || ((r.familia === '6' || r.familia === '7') ? r.beneficiario : null);
        expRows.push([
          r.sucursal || b.code, r.doc_tipo, r.doc_folio, r.linea, r.fecha,
          r.cuenta, accName.get(r.cuenta) || acc.get(r.cuenta) || null, mayor, accName.get(mayor) || acc.get(mayor) || null,
          r.familia, r.cargo_abono, r.beneficiario,
          docArea.get(dk) || null, Number(r.importe) || 0,
          dpto, dpto ? (dep.get(dpto) || null) : null,
          conceptoCod, conceptoNombre, hdr?.concepto || null, hdr?.beneficiario || null,
        ]);
        movs++; monto += Number(r.importe) || 0;
        // acumula el documento fuente (solo pólizas con folio real)
        const fol = r.doc_folio == null ? '' : String(r.doc_folio).trim();
        if (fol) {
          if (!docMeta.has(dk)) docMeta.set(dk, { doc_tipo: r.doc_tipo, folio: r.doc_folio, fecha: r.fecha });
          if (mayor === '511') compraFolios.add(fol);
        }
      }
    }

    // ── GX v3: documentos (kdm1) + líneas de compra (kdm2) para el drill ──
    let nDocs = 0;
    for (const [k, meta] of docMeta) {
      const h = docHdr.get(k);
      if (!h) continue; // póliza sin cabecera de documento (diario, etc.)
      docRows.push([
        b.code, meta.doc_tipo, meta.folio, meta.fecha, h.fecha_doc || null,
        h.beneficiario || null, h.rfc || null, h.concepto || null, normArea(h.area),
        Number(h.importe) || 0, Number(h.iva) || 0, h.usuario || null, h.clase || null,
      ]);
      nDocs++;
    }
    let lineCount = 0;
    if (x.lineasError) docNotes.push(`  ⚠ docs sucursal ${b.code}: ${x.lineasError} — líneas de compra omitidas (pólizas OK)`);
    else if (compraFolios.size) {
      const seq = new Map();
      for (const l of x.lineas) {
        const fol = String(l.folio).trim();
        if (!compraFolios.has(fol)) continue;
        const meta = docMeta.get(`XA2001-${l.folio}`);
        const n = (seq.get(fol) || 0) + 1; seq.set(fol, n);
        lineRows.push([
          b.code, 'XA2001', l.folio, n, meta?.fecha || null,
          l.sku || null, l.producto || null, l.cantidad != null ? Number(l.cantidad) : null,
          l.presentacion || null, l.costo_unitario != null ? Number(l.costo_unitario) : null, Number(l.importe) || 0,
        ]);
        lineCount++;
      }
    }
    docNotes.push(`  · docs sucursal ${b.code}: ${nDocs} documentos + ${lineCount} líneas de compra`);
    summary.push({ code: b.code, movs, monto: Math.round(monto) });
  }
  return { expRows, docRows, lineRows, okCodes: [...porBase.keys()], summary, docNotes };
}

const EXP_COLS = ['sucursal', 'doc_tipo', 'doc_folio', 'linea', 'fecha', 'cuenta', 'cuenta_nombre', 'cuenta_mayor', 'cuenta_mayor_nombre',
  'familia', 'cargo_abono', 'beneficiario', 'area', 'importe', 'dpto', 'dpto_nombre', 'concepto', 'concepto_nombre', 'comentario', 'beneficiario_doc'];

async function run() {
  const { tables, from, to } = monthWindow(MONTHS);
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Egresos (pólizas) → analytics.expense_entries (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) · fuente ${SOURCE} ===`);
    console.log(`Ventana: ${MONTHS} meses (${from} … ${to}) · tablas: ${tables.map((t) => t.tbl).join(', ')}\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // okCodes: solo estas entran al DELETE — una sucursal caída NO debe perder su historial
    const { expRows, docRows, lineRows, okCodes, summary, docNotes } = await collect(db, tables);
    for (const n of docNotes) console.log(n);
    console.table(summary);

    await db.query(`CREATE TEMP TABLE stg_exp (
      sucursal text, doc_tipo text, doc_folio text, linea int, fecha date,
      cuenta text, cuenta_nombre text, cuenta_mayor text, cuenta_mayor_nombre text,
      familia text, cargo_abono text, beneficiario text, area text, importe numeric,
      dpto text, dpto_nombre text, concepto text, concepto_nombre text, comentario text, beneficiario_doc text) ON COMMIT DROP`);
    // GX v3 — documentos fuente (kdm1) + líneas de detalle (kdm2, solo compras) para el drill.
    await db.query(`CREATE TEMP TABLE stg_doc (
      sucursal text, doc_tipo text, doc_folio text, fecha date, fecha_doc date,
      beneficiario text, rfc text, concepto text, area text, importe numeric, iva numeric,
      usuario text, clase text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_docline (
      sucursal text, doc_tipo text, doc_folio text, linea int, fecha date,
      sku text, producto text, cantidad numeric, presentacion text, costo_unitario numeric, importe numeric) ON COMMIT DROP`);
    await bulkInsert(db, 'stg_exp', EXP_COLS, expRows);
    // SAVEPOINT: un fallo en el drill NO debe abortar el feed crítico de pólizas.
    try {
      await db.query('SAVEPOINT docs');
      await bulkInsert(db, 'stg_doc',
        ['sucursal', 'doc_tipo', 'doc_folio', 'fecha', 'fecha_doc', 'beneficiario', 'rfc', 'concepto', 'area', 'importe', 'iva', 'usuario', 'clase'],
        docRows);
      await bulkInsert(db, 'stg_docline',
        ['sucursal', 'doc_tipo', 'doc_folio', 'linea', 'fecha', 'sku', 'producto', 'cantidad', 'presentacion', 'costo_unitario', 'importe'],
        lineRows);
      await db.query('RELEASE SAVEPOINT docs');
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT docs').catch(() => {});
      console.log(`  ⚠ docs: ${e.message} — drill omitido (pólizas OK)`);
    }

    // FIX #B (doble conteo CEDIS↔sucursal) — las sucursales 01-05 registran como
    // "compra" (511) la mercancía RECIBIDA de CEDIS, que CEDIS ya contó en su propia
    // 511. Se reconoce por beneficiario interno (SUCURSAL/CEDIS/CENTRO DE DIST/
    // TRASPASO): es traspaso interno, no compra externa. Se excluye SOLO en sucursales
    // (md_00 sí es la compra central real). Evita ~$28.6M de doble conteo de red.
    const dropTransfer = await db.query(`
      DELETE FROM stg_exp
       WHERE sucursal <> '00' AND cuenta_mayor = '511'
         AND ( upper(COALESCE(beneficiario,'')) LIKE 'SUCURSAL%'
            OR upper(COALESCE(beneficiario,'')) LIKE '%CEDIS%'
            OR upper(COALESCE(beneficiario,'')) LIKE '%CENTRO DE DIST%'
            OR upper(COALESCE(beneficiario,'')) LIKE '%TRASPASO%' )`);
    console.log(`Fix#B traspasos internos: ${dropTransfer.rowCount} filas 511 de sucursal (beneficiario interno) descartadas.`);

    // FIX #1 (presupuesto vs factura) — Kepler 2025 registró compras (511) como
    // PRESUPUESTO mensual (folio vacío, contrapartida cuenta 999 PRESUPUESTOS); la
    // captura factura-a-factura (folio real, contra 201 proveedores) arrancó ~dic-2025.
    // Regla: preferir FACTURAS reales cuando ya son el método operativo del mes
    // (det >= 50% del presupuesto); caer al PRESUPUESTO solo en meses sin captura real
    // (ago-nov 2025), donde queda como ESTIMADO (esas filas conservan folio vacío =
    // marcador de estimado). Arregla dic-2025 (usa factura $63.1M, no presupuesto
    // $75.3M) sin sub-contar ago-nov. Solo toca grupos con AMBAS capas presentes.
    // EFECTO COLATERAL (verificado, deseado): en ene-mar 2026 la única capa
    // folio-vacío de 511 son las pólizas de diario "IMPUESTO EN COMPRAS" (IVA
    // acreditable mal capitalizado al costo, $16.45M contra 122). Como la factura
    // domina esos meses, esta regla también las borra → el IVA NO infla compras.
    // Si se sube THRESH, revalidar que el IVA siga quedando fuera.
    //
    // [GX.9] ACOTADO a 511/6xx — las familias que este fix modela. NO aplica a las
    // cuentas nuevas (150 activo no circulante, 702-764 financieros e impuestos):
    // ahí la capa folio-vacío NO es un presupuesto paralelo sino pólizas de diario
    // (D-11/D-14, contrapartida 999/116/515), y el fix genérico las confundía.
    // MEDIDO en el ODS (12 meses, 2025-09…2026-08) antes de acotarlo: en 150 habría
    // borrado $240,034 (2026-03) + $5,000 (2025-12) de adquisiciones con factura
    // real, y $182,633 de diario (2026-07). Con el acote, 511/6xx quedan idénticos.
    const THRESH = 0.5;
    const FIX1_MAYORES = `(c.cuenta_mayor = '511' OR c.cuenta_mayor LIKE '6%')`;
    const dropLayer = await db.query(`
      WITH capas AS (
        SELECT sucursal, cuenta_mayor, to_char(fecha,'YYYY-MM') AS mes,
               COALESCE(SUM(importe) FILTER (WHERE NULLIF(btrim(COALESCE(doc_folio,'')),'') IS NOT NULL),0) AS det,
               COALESCE(SUM(importe) FILTER (WHERE NULLIF(btrim(COALESCE(doc_folio,'')),'') IS NULL),0)     AS res
          FROM stg_exp
         GROUP BY sucursal, cuenta_mayor, to_char(fecha,'YYYY-MM')
        HAVING COALESCE(SUM(importe) FILTER (WHERE NULLIF(btrim(COALESCE(doc_folio,'')),'') IS NOT NULL),0) > 0
           AND COALESCE(SUM(importe) FILTER (WHERE NULLIF(btrim(COALESCE(doc_folio,'')),'') IS NULL),0)     > 0
      )
      DELETE FROM stg_exp s USING capas c
       WHERE s.sucursal = c.sucursal AND s.cuenta_mayor = c.cuenta_mayor
         AND to_char(s.fecha,'YYYY-MM') = c.mes
         AND ${FIX1_MAYORES}
         AND (
              (c.det >= ${THRESH} * c.res AND NULLIF(btrim(COALESCE(s.doc_folio,'')),'') IS NULL)      -- facturas ya operan → borrar presupuesto
           OR (c.det <  ${THRESH} * c.res AND NULLIF(btrim(COALESCE(s.doc_folio,'')),'') IS NOT NULL)  -- captura incompleta → borrar facturas parciales, dejar presupuesto (estimado)
         )`);
    console.log(`Fix#1 factura>presupuesto (umbral ${THRESH}): ${dropLayer.rowCount} filas de la capa no-operativa descartadas.`);

    // FIX #2 (doble-carga) — deduplicar por clave natural ANCHA
    // (sucursal,doc_tipo,doc_folio,linea,cuenta,importe,fecha). Mata filas
    // repetidas por overlap de tablas mensuales de Kepler / cargas dobles.
    const dedup = await db.query(`
      DELETE FROM stg_exp a USING stg_exp b
       WHERE a.ctid < b.ctid
         AND a.sucursal = b.sucursal
         AND COALESCE(a.doc_tipo,'') = COALESCE(b.doc_tipo,'')
         AND COALESCE(a.doc_folio,'') = COALESCE(b.doc_folio,'')
         AND a.linea IS NOT DISTINCT FROM b.linea
         AND a.cuenta = b.cuenta
         AND a.importe = b.importe
         AND a.fecha IS NOT DISTINCT FROM b.fecha`);
    console.log(`Fix#2 dedup clave-ancha: ${dedup.rowCount} filas duplicadas eliminadas.`);

    const staged = (await db.query(`SELECT count(*)::int n FROM stg_exp`)).rows[0].n;
    console.log(`Staging final: ${staged} movimientos de egreso.`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    if (!okCodes.length) { await db.query('ROLLBACK'); console.log('\n[APPLY] Ninguna sucursal conectó — nada que aplicar.'); return; }
    // okCodes ∪ codes staged (c14 puede diferir del code del MAP; si no se borran, se duplican en re-runs)
    const stagedCodes = (await db.query(`SELECT DISTINCT sucursal FROM stg_exp`)).rows.map((r) => r.sucursal);
    const sucursales = [...new Set([...okCodes, ...stagedCodes])];
    // Merge SIN churn (antes: DELETE-año+INSERT reescribía TODO el año contable cada noche).
    // expense_entries no tiene clave natural (id surrogate) → block-diff por (sucursal, mes):
    // un mes contable cerrado es inmutable → solo se reprocesan los meses que cambiaron.
    const FP_E = `concat_ws('|', sucursal, coalesce(doc_tipo,''), coalesce(doc_folio,''), coalesce(linea::text,''),
      fecha::text, cuenta, coalesce(cuenta_nombre,''), coalesce(cuenta_mayor,''), coalesce(cuenta_mayor_nombre,''),
      coalesce(familia,''), coalesce(cargo_abono,''), coalesce(beneficiario,''), coalesce(area,''), importe::text,
      coalesce(dpto,''), coalesce(dpto_nombre,''), coalesce(concepto,''), coalesce(concepto_nombre,''),
      coalesce(comentario,''), coalesce(beneficiario_doc,''))`;
    await db.query(
      `CREATE TEMP TABLE exp_changed ON COMMIT DROP AS
       WITH s AS (SELECT sucursal, date_trunc('month',fecha)::date mes, md5(string_agg(${FP_E}, E'\\n' ORDER BY ${FP_E})) fp
                    FROM stg_exp GROUP BY sucursal, date_trunc('month',fecha)::date),
            t AS (SELECT sucursal, date_trunc('month',fecha)::date mes, md5(string_agg(${FP_E}, E'\\n' ORDER BY ${FP_E})) fp
                    FROM analytics.expense_entries
                   WHERE tenant_id=$1 AND sucursal = ANY($2) AND fecha >= $3::date AND fecha <= $4::date
                   GROUP BY sucursal, date_trunc('month',fecha)::date)
       SELECT sucursal, mes FROM s FULL OUTER JOIN t USING (sucursal, mes) WHERE s.fp IS DISTINCT FROM t.fp`,
      [M, sucursales, from, to]);
    const del = await db.query(
      `DELETE FROM analytics.expense_entries e USING exp_changed c
        WHERE e.tenant_id=$1 AND e.sucursal=c.sucursal AND date_trunc('month',e.fecha)::date=c.mes`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.expense_entries
         (id,tenant_id,sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,cuenta_mayor,cuenta_mayor_nombre,familia,cargo_abono,beneficiario,area,importe,dpto,dpto_nombre,concepto,concepto_nombre,comentario,beneficiario_doc,computed_at)
       SELECT gen_random_uuid(),$1,s.sucursal,s.doc_tipo,s.doc_folio,s.linea,s.fecha,s.cuenta,s.cuenta_nombre,s.cuenta_mayor,s.cuenta_mayor_nombre,s.familia,s.cargo_abono,s.beneficiario,s.area,s.importe,s.dpto,s.dpto_nombre,s.concepto,s.concepto_nombre,s.comentario,s.beneficiario_doc,now()
         FROM stg_exp s JOIN exp_changed c ON c.sucursal=s.sucursal AND date_trunc('month',s.fecha)::date=c.mes`,
      [M]);

    // GX v3 — documentos: `analytics.expense_documents` es VISTA derive-no-copy sobre kepler_ods.kdm1
    // (mig 20260819210000) → NO se escribe desde acá. Su importe/iva salen del AGREGADO CONTABLE
    // `analytics.expense_doc_accounting` (mig 20260819250000): total por documento = costo (511/6xx/150/
    // 702-764, mismo alcance que las pólizas — [GX.9]) + IVA (122x), lado cargo, desde las pólizas
    // `kepler_ods.kdc2YYMM`. MEDIDO: 343 documentos de 12 meses subdeclaraban su total porque su cargo
    // a activo fijo / financiero era invisible acá (~$9.4M). Se refresca acá (month-agnostic:
    // enumera las kdc2 del ODS en runtime; el ODS ya viene fresco vía CDC). Corrige el c16 roto del
    // movimiento (ej. recepción 02/0000482: c16=$207k vs contable $414,629.68). Si no hay ODS en este
    // entorno (dev local sin kepler_ods) se omite sin romper el feed de pólizas.
    let upDoc = { rowCount: 0 }, delDoc = { rowCount: 0 };
    try {
      const kdcTabs = (await db.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='kepler_ods' AND table_name ~ '^kdc2[0-9]{4}$' ORDER BY 1`)).rows.map((r) => r.table_name);
      if (kdcTabs.length) {
        const union = kdcTabs.map((t) =>
          `SELECT c14::text suc,(c15||c16||lpad(btrim(c17::text),2,'0')||lpad(btrim(c18::text),2,'0')) tipo,` +
          `btrim(c19::text) folio,btrim(c3::text) cuenta,c4 ca,` +
          `coalesce(nullif(regexp_replace(c5::text,'[^0-9.-]','','g'),'')::numeric,0) imp FROM kepler_ods.${t}`).join(' UNION ALL ');
        upDoc = await db.query(
          `INSERT INTO analytics.expense_doc_accounting AS t (tenant_id,sucursal,doc_tipo,doc_folio,importe_contable,iva_contable,computed_at)
           SELECT $1, suc, tipo, folio,
                  round(sum(imp) FILTER (WHERE ca='C' AND (cuenta='511' OR cuenta LIKE '6%' OR cuenta LIKE '122%'
                       OR split_part(cuenta,'-',1)='150' OR split_part(cuenta,'-',1) BETWEEN '702' AND '764')),2),
                  round(sum(imp) FILTER (WHERE ca='C' AND cuenta LIKE '122%'),2),
                  now()
             FROM (${union}) p
            WHERE tipo IN ('XA1001','XA2001') AND folio <> ''
            GROUP BY suc,tipo,folio
           ON CONFLICT (tenant_id,sucursal,doc_tipo,doc_folio) DO UPDATE
             SET importe_contable=EXCLUDED.importe_contable, iva_contable=EXCLUDED.iva_contable, computed_at=now()
            WHERE t.importe_contable IS DISTINCT FROM EXCLUDED.importe_contable
               OR t.iva_contable IS DISTINCT FROM EXCLUDED.iva_contable`,
          [M]);
      } else {
        console.log('  ⚠ sin kepler_ods.kdc2* en este entorno — agregado contable omitido (importe cae a c16).');
      }
    } catch (e) {
      console.log(`  ⚠ refresh expense_doc_accounting: ${e.message.slice(0, 100)} — omitido (pólizas OK).`);
    }
    const upLine = await db.query(
      `INSERT INTO analytics.expense_document_lines AS t
         (tenant_id,sucursal,doc_tipo,doc_folio,linea,fecha,sku,producto,cantidad,presentacion,costo_unitario,importe,computed_at)
       SELECT $1,sucursal,doc_tipo,doc_folio,linea,fecha,sku,producto,cantidad,presentacion,costo_unitario,importe,now()
         FROM stg_docline
       ON CONFLICT (tenant_id,sucursal,doc_tipo,doc_folio,linea) DO UPDATE SET
         fecha=EXCLUDED.fecha, sku=EXCLUDED.sku, producto=EXCLUDED.producto, cantidad=EXCLUDED.cantidad,
         presentacion=EXCLUDED.presentacion, costo_unitario=EXCLUDED.costo_unitario, importe=EXCLUDED.importe, computed_at=now()
       WHERE (t.fecha,t.sku,t.producto,t.cantidad,t.presentacion,t.costo_unitario,t.importe)
             IS DISTINCT FROM
             (EXCLUDED.fecha,EXCLUDED.sku,EXCLUDED.producto,EXCLUDED.cantidad,EXCLUDED.presentacion,EXCLUDED.costo_unitario,EXCLUDED.importe)`,
      [M]);
    // El kdm2 del ODS tiene huecos de cuando su carril estaba ciego (00/01/06/08, antes del 26-oct-2026,
    // [OBS.15]): renglones que la red de seguridad de 3 días nunca alcanzó. Con el ODS, un folio que no
    // trae ni una línea NO borra las que la tabla ya tiene (medido: 2 folios, 3 líneas en 6 meses).
    const ODS_SOLO_FOLIOS_VISTOS = 'AND EXISTS (SELECT 1 FROM stg_docline s WHERE s.sucursal=t.sucursal AND s.doc_tipo=t.doc_tipo AND s.doc_folio=t.doc_folio)';
    const delLine = await db.query(
      `DELETE FROM analytics.expense_document_lines t
        WHERE t.tenant_id=$1 AND t.sucursal = ANY($2) AND t.fecha >= $3::date AND t.fecha <= $4::date
          AND NOT EXISTS (SELECT 1 FROM stg_docline s WHERE s.sucursal=t.sucursal AND s.doc_tipo=t.doc_tipo AND s.doc_folio=t.doc_folio AND s.linea IS NOT DISTINCT FROM t.linea)
          ${SOURCE === 'ods' ? ODS_SOLO_FOLIOS_VISTOS : ''}`,
      [M, sucursales, from, to]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — pólizas (block-diff mes): ${del.rowCount} borrados + ${up.rowCount} reinsertados.`);
    console.log(`[APPLY] agregado contable (expense_doc_accounting): ${upDoc.rowCount} docs upserted · líneas: ${upLine.rowCount} upserted + ${delLine.rowCount} borrados.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
}

module.exports = { collect, monthWindow };
if (require.main === module) run();
