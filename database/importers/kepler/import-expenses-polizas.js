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
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-31`;
  return { tables, from, to };
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
      cuenta text, cuenta_nombre text, familia text, cargo_abono text,
      beneficiario text, importe numeric) ON COMMIT DROP`);

    const summary = [];
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url });
      try {
        await src.connect();
      } catch (e) {
        console.log(`  ⚠ sucursal ${b.code}: sin conexión (${e.message}) — skip`);
        summary.push({ code: b.code, movs: 0, monto: 0, nota: 'sin conexión' });
        continue;
      }
      try {
        // catálogo de cuentas de la sucursal: código → nombre
        const acc = new Map(
          (await src.query(`SELECT c3 AS code, c2 AS nombre FROM md.kdco WHERE c3 IS NOT NULL`)).rows
            .map((r) => [r.code, r.nombre]),
        );

        let movs = 0, monto = 0;
        for (const t of tables) {
          const exists = (await src.query(`SELECT to_regclass('md.${t.tbl}') AS r`)).rows[0].r;
          if (!exists) continue;
          const rows = (await src.query(
            `SELECT c14 AS sucursal,
                    (c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0')) AS doc_tipo,
                    c19 AS doc_folio, c10::int AS linea, c2::date AS fecha,
                    c3 AS cuenta, left(c3,1) AS familia, c4 AS cargo_abono,
                    NULLIF(btrim(c6),'') AS beneficiario, c5::numeric AS importe
               FROM md.${t.tbl}
              WHERE c4='C' AND (c3 LIKE '5%' OR c3 LIKE '6%') AND c19 IS NOT NULL`,
          )).rows;

          const staged = [];
          for (const r of rows) {
            staged.push([
              r.sucursal || b.code, r.doc_tipo, r.doc_folio, r.linea, r.fecha,
              r.cuenta, acc.get(r.cuenta) || null, r.familia, r.cargo_abono,
              r.beneficiario, Number(r.importe) || 0,
            ]);
            movs++; monto += Number(r.importe) || 0;
          }
          for (let i = 0; i < staged.length; i += BATCH) {
            const chunk = staged.slice(i, i + BATCH);
            const vals = [], params = [];
            chunk.forEach((row, ri) => {
              vals.push(`(${Array.from({ length: 11 }, (_, k) => `$${ri * 11 + k + 1}`).join(',')})`);
              params.push(...row);
            });
            await db.query(
              `INSERT INTO stg_exp (sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,familia,cargo_abono,beneficiario,importe)
               VALUES ${vals.join(',')}`, params);
          }
        }
        summary.push({ code: b.code, movs, monto: Math.round(monto) });
      } finally { await src.end(); }
    }
    console.table(summary);

    // Dedup defensivo por PK (misma póliza podría venir en 2 tablas por corrección).
    const staged = (await db.query(`SELECT count(*)::int n FROM stg_exp`)).rows[0].n;
    console.log(`Staging: ${staged} movimientos de egreso.`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    const sucursales = MAP.map((b) => b.code);
    const del = await db.query(
      `DELETE FROM analytics.expense_entries
        WHERE tenant_id=$1 AND sucursal = ANY($2) AND fecha >= $3::date AND fecha <= $4::date`,
      [M, sucursales, from, to]);
    const up = await db.query(
      `INSERT INTO analytics.expense_entries
         (tenant_id,sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,familia,cargo_abono,beneficiario,importe,computed_at)
       SELECT DISTINCT ON (sucursal,doc_tipo,doc_folio,linea)
              $1,sucursal,doc_tipo,doc_folio,linea,fecha,cuenta,cuenta_nombre,familia,cargo_abono,beneficiario,importe,now()
         FROM stg_exp
       ON CONFLICT (tenant_id,sucursal,doc_tipo,doc_folio,linea) DO UPDATE SET
         fecha=EXCLUDED.fecha, cuenta=EXCLUDED.cuenta, cuenta_nombre=EXCLUDED.cuenta_nombre,
         familia=EXCLUDED.familia, cargo_abono=EXCLUDED.cargo_abono,
         beneficiario=EXCLUDED.beneficiario, importe=EXCLUDED.importe, computed_at=now()`,
      [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${del.rowCount} borrados (ventana) + ${up.rowCount} upserted.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
