/* eslint-disable no-console */
/**
 * GX.1 — Pólizas contables de EGRESOS (gastos + compras) → analytics.expense_entries.
 *
 * Lee las tablas mensuales `kdc2YYMM` de cada sucursal Kepler (READ-ONLY) + el
 * catálogo de cuentas `kdco`, y puebla analytics.expense_entries en prod.
 *
 * Modelo (verificado contra Kepler):
 *   egreso  = cargo (kdc.c4='C') a cuenta de compras/costo (5xx) o gasto (6xx)
 *   cuenta  = kdc.c3  ·  nombre = kdco.c2 (join por kdco.c3)
 *   importe = kdc.c5  (c9 llega 0 a veces → NO usar)
 *   benef   = kdc.c6  ·  fecha = kdc.c2  ·  sucursal = kdc.c14  ·  linea = kdc.c10
 *   doc     = c15||c16||lpad(c17,2)||lpad(c18,2) (ej. XA2001) + folio c19
 * Se arma desde las PÓLIZAS, no desde los documentos → 1 postura por transacción
 * (evita el 4× de las etapas XA20/35/37/40).
 *
 * Tabla mensual: `kdc2` + YY + MM  (2026-06 → kdc22606, 2025-01 → kdc22501).
 *
 *   node database/importers/kepler/import-expenses-polizas.js               # dry-run (6 meses)
 *   node database/importers/kepler/import-expenses-polizas.js --apply       # commit
 *   ... --months 12                                                         # ventana de meses
 *   EXPENSES_BRANCH_MAP='[{"code":"03","url":"..."}]' node ... --apply      # override sucursales
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
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

const MAP = process.env.EXPENSES_BRANCH_MAP
  ? JSON.parse(process.env.EXPENSES_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

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

(async () => {
  const { tables, from, to } = monthWindow(MONTHS);
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Egresos (pólizas) → analytics.expense_entries (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`Ventana: ${MONTHS} meses (${from} … ${to}) · tablas: ${tables.map((t) => t.tbl).join(', ')}\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
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

    const summary = [];
    const okCodes = []; // solo estas entran al DELETE: una sucursal caída NO debe perder su historial
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url });
      try {
        await src.connect();
      } catch (e) {
        console.log(`  ⚠ sucursal ${b.code}: sin conexión (${e.message}) — skip`);
        summary.push({ code: b.code, movs: 0, monto: 0, nota: 'sin conexión' });
        continue;
      }
      okCodes.push(b.code);
      try {
        // catálogo de cuentas de la sucursal: código → nombre
        const acc = new Map(
          (await src.query(`SELECT c3 AS code, c2 AS nombre FROM md.kdco WHERE c3 IS NOT NULL`)).rows
            .map((r) => [r.code, r.nombre]),
        );
        // catálogo de departamentos / centros de costo (kdc3): código c1 → nombre c2
        // (ej. '1-01-10-00' → 'PADRE HIDALGO PISO'). Puede no existir en algunas sucursales.
        const dep = new Map();
        try {
          for (const r of (await src.query(`SELECT c1 AS code, c2 AS nombre FROM md.kdc3 WHERE c1 IS NOT NULL`)).rows) {
            const code = String(r.code).trim();
            if (code) dep.set(code, r.nombre ? String(r.nombre).trim() : null);
          }
        } catch { /* sucursal sin catálogo kdc3 */ }
        // Plan de cuentas (kdc126, fallback kdc125): código → nombre de mayor/subcuenta.
        // kdco es catálogo de CONCEPTOS (N nombres por subcuenta) → no sirve para el
        // nombre de la cuenta; kdc126 sí trae '601'=SUELDOS Y SALARIOS y '601-001'=SUELDOS.
        const accName = new Map();
        for (const tbl of ['kdc125', 'kdc126']) { // kdc126 último → pisa a kdc125 (más reciente)
          try {
            for (const r of (await src.query(`SELECT c1 AS code, c2 AS nombre FROM md.${tbl} WHERE c1 IS NOT NULL`)).rows) {
              const code = String(r.code).trim();
              if (code && r.nombre) accName.set(code, String(r.nombre).trim());
            }
          } catch { /* sucursal sin ese catálogo */ }
        }
        // Conceptos (kdco): llave (subcuenta c3, concepto c1) → nombre. Distinto de `acc`
        // (por c3) porque una subcuenta tiene N conceptos.
        const conceptoMap = new Map();
        for (const r of (await src.query(`SELECT c3, c1, c2 FROM md.kdco WHERE c3 IS NOT NULL AND c1 IS NOT NULL`)).rows) {
          if (r.c2) conceptoMap.set(`${String(r.c3).trim()}|${String(r.c1).trim()}`, String(r.c2).trim());
        }
        // Cabeceras de documento (kdm1): área para las pólizas (docArea) + campos ricos
        // para el drill al documento (docHdr, solo XA2001 compras / XA1001 gastos).
        const docArea = new Map();
        const docHdr = new Map();
        for (const r of (await src.query(
          `SELECT (c2||c3||lpad(c4::text,2,'0')||lpad(c5::text,2,'0')) AS tipo, c6 AS folio, c48 AS area,
                  c18::date AS fecha_doc, c14::numeric AS iva, c16::numeric AS importe,
                  NULLIF(btrim(c22),'') AS rfc, NULLIF(btrim(c24),'') AS concepto,
                  NULLIF(btrim(c32),'') AS beneficiario, NULLIF(btrim(c67),'') AS usuario, NULLIF(btrim(c31),'') AS clase
             FROM md.kdm1 WHERE c63 ~ '^X' AND c6 IS NOT NULL`,
        )).rows) {
          const k = `${r.tipo}-${r.folio}`;
          docArea.set(k, normArea(r.area));
          if (r.tipo === 'XA2001' || r.tipo === 'XA1001') docHdr.set(k, r);
        }

        const docMeta = new Map();      // clave tipo-folio → {doc_tipo,folio,fecha} de la póliza (fecha confiable)
        const compraFolios = new Set(); // folios 511 → tienen líneas de producto en kdm2
        let movs = 0, monto = 0;
        for (const t of tables) {
          const exists = (await src.query(`SELECT to_regclass('md.${t.tbl}') AS r`)).rows[0].r;
          if (!exists) continue;
          const rows = (await src.query(
            `SELECT c14 AS sucursal,
                    (c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0')) AS doc_tipo,
                    c19 AS doc_folio, c10::int AS linea, c2::date AS fecha,
                    c3 AS cuenta, left(c3,1) AS familia, c4 AS cargo_abono,
                    NULLIF(btrim(c6),'') AS beneficiario, c5::numeric AS importe,
                    NULLIF(btrim(c13),'') AS dpto, NULLIF(btrim(c20),'') AS concepto_cod
               FROM md.${t.tbl}
              WHERE c4='C' AND (c3='511' OR c3 LIKE '6%')
                AND COALESCE(c5,0) <> 0`,   /* dropea las ~609 líneas $0 'BAJA -'/canceladas (ruido). c19 folio-vacío = '' (no NULL) → se conserva la capa de diario/presupuesto; la distingue Fix#1. */
          )).rows;

          const staged = [];
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
            staged.push([
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
              const dk = `${r.doc_tipo}-${r.doc_folio}`;
              if (!docMeta.has(dk)) docMeta.set(dk, { doc_tipo: r.doc_tipo, folio: r.doc_folio, fecha: r.fecha });
              if (mayor === '511') compraFolios.add(fol);
            }
          }
          const NCOL = 20;
          for (let i = 0; i < staged.length; i += BATCH) {
            const chunk = staged.slice(i, i + BATCH);
            const vals = [], params = [];
            chunk.forEach((row, ri) => {
              vals.push(`(${Array.from({ length: NCOL }, (_, k) => `$${ri * NCOL + k + 1}`).join(',')})`);
              params.push(...row);
            });
            await db.query(
              `INSERT INTO stg_exp (sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,cuenta_mayor,cuenta_mayor_nombre,familia,cargo_abono,beneficiario,area,importe,dpto,dpto_nombre,concepto,concepto_nombre,comentario,beneficiario_doc)
               VALUES ${vals.join(',')}`, params);
          }
        }

        // ── GX v3: stage documentos (kdm1) + líneas de compra (kdm2) para el drill ──
        // SAVEPOINT: un fallo aquí NO debe abortar el feed crítico de pólizas.
        try {
          await db.query('SAVEPOINT docs');
          const docStg = [];
          for (const [k, meta] of docMeta) {
            const h = docHdr.get(k);
            if (!h) continue; // póliza sin cabecera de documento (diario, etc.)
            docStg.push([
              b.code, meta.doc_tipo, meta.folio, meta.fecha, h.fecha_doc || null,
              h.beneficiario || null, h.rfc || null, h.concepto || null, normArea(h.area),
              Number(h.importe) || 0, Number(h.iva) || 0, h.usuario || null, h.clase || null,
            ]);
          }
          await bulkInsert(db, 'stg_doc',
            ['sucursal', 'doc_tipo', 'doc_folio', 'fecha', 'fecha_doc', 'beneficiario', 'rfc', 'concepto', 'area', 'importe', 'iva', 'usuario', 'clase'],
            docStg);

          let lineCount = 0;
          if (compraFolios.size) {
            const lrows = (await src.query(
              `SELECT c6 AS folio, c8 AS sku, NULLIF(btrim(c10),'') AS producto, c9::numeric AS cantidad,
                      NULLIF(btrim(c11),'') AS presentacion, c12::numeric AS costo_unitario, c13::numeric AS importe
                 FROM md.kdm2
                WHERE c2='X' AND c3='A' AND c4::int=20 AND c5::int=1 AND c6 IS NOT NULL
                ORDER BY c6`,
            )).rows;
            const lineStg = [], seq = new Map();
            for (const l of lrows) {
              const fol = String(l.folio).trim();
              if (!compraFolios.has(fol)) continue;
              const meta = docMeta.get(`XA2001-${l.folio}`);
              const n = (seq.get(fol) || 0) + 1; seq.set(fol, n);
              lineStg.push([
                b.code, 'XA2001', l.folio, n, meta?.fecha || null,
                l.sku || null, l.producto || null, l.cantidad != null ? Number(l.cantidad) : null,
                l.presentacion || null, l.costo_unitario != null ? Number(l.costo_unitario) : null, Number(l.importe) || 0,
              ]);
            }
            await bulkInsert(db, 'stg_docline',
              ['sucursal', 'doc_tipo', 'doc_folio', 'linea', 'fecha', 'sku', 'producto', 'cantidad', 'presentacion', 'costo_unitario', 'importe'],
              lineStg);
            lineCount = lineStg.length;
          }
          await db.query('RELEASE SAVEPOINT docs');
          console.log(`  · docs sucursal ${b.code}: ${docStg.length} documentos + ${lineCount} líneas de compra`);
        } catch (e) {
          await db.query('ROLLBACK TO SAVEPOINT docs').catch(() => {});
          console.log(`  ⚠ docs sucursal ${b.code}: ${e.message} — drill omitido (pólizas OK)`);
        }

        summary.push({ code: b.code, movs, monto: Math.round(monto) });
      } finally { await src.end(); }
    }
    console.table(summary);

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
    const THRESH = 0.5;
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
    const del = await db.query(
      `DELETE FROM analytics.expense_entries
        WHERE tenant_id=$1 AND sucursal = ANY($2) AND fecha >= $3::date AND fecha <= $4::date`,
      [M, sucursales, from, to]);
    const up = await db.query(
      `INSERT INTO analytics.expense_entries
         (id,tenant_id,sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,cuenta_mayor,cuenta_mayor_nombre,familia,cargo_abono,beneficiario,area,importe,dpto,dpto_nombre,concepto,concepto_nombre,comentario,beneficiario_doc,computed_at)
       SELECT gen_random_uuid(),$1,sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,cuenta_mayor,cuenta_mayor_nombre,familia,cargo_abono,beneficiario,area,importe,dpto,dpto_nombre,concepto,concepto_nombre,comentario,beneficiario_doc,now()
         FROM stg_exp`,
      [M]);

    // GX v3 — documentos + líneas del drill (misma ventana/sucursales que las pólizas)
    const delDoc = await db.query(
      `DELETE FROM analytics.expense_documents WHERE tenant_id=$1 AND sucursal = ANY($2) AND fecha >= $3::date AND fecha <= $4::date`,
      [M, sucursales, from, to]);
    const upDoc = await db.query(
      `INSERT INTO analytics.expense_documents
         (tenant_id,sucursal,doc_tipo,doc_folio,fecha,fecha_doc,beneficiario,rfc,concepto,area,importe,iva,usuario,clase,computed_at)
       SELECT $1,sucursal,doc_tipo,doc_folio,fecha,fecha_doc,beneficiario,rfc,concepto,area,importe,iva,usuario,clase,now()
         FROM stg_doc
       ON CONFLICT (tenant_id,sucursal,doc_tipo,doc_folio) DO NOTHING`,
      [M]);
    const delLine = await db.query(
      `DELETE FROM analytics.expense_document_lines WHERE tenant_id=$1 AND sucursal = ANY($2) AND fecha >= $3::date AND fecha <= $4::date`,
      [M, sucursales, from, to]);
    const upLine = await db.query(
      `INSERT INTO analytics.expense_document_lines
         (tenant_id,sucursal,doc_tipo,doc_folio,linea,fecha,sku,producto,cantidad,presentacion,costo_unitario,importe,computed_at)
       SELECT $1,sucursal,doc_tipo,doc_folio,linea,fecha,sku,producto,cantidad,presentacion,costo_unitario,importe,now()
         FROM stg_docline
       ON CONFLICT (tenant_id,sucursal,doc_tipo,doc_folio,linea) DO NOTHING`,
      [M]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — pólizas: ${del.rowCount} borrados + ${up.rowCount} upserted.`);
    console.log(`[APPLY] documentos: ${delDoc.rowCount} borrados + ${upDoc.rowCount} upserted · líneas: ${delLine.rowCount} borrados + ${upLine.rowCount} upserted.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
