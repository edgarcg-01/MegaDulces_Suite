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
 *   node database/importers/kepler/import-ledger-chain.js               # dry-run (12 meses)
 *   node database/importers/kepler/import-ledger-chain.js --apply       # commit
 *   ... --months 19                                                     # ventana balanza
 *   EXPENSES_BRANCH_MAP='[{"code":"03","url":"..."}]' node ...          # override sucursales
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
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 12))));

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

(async () => {
  const tables = monthWindow(MONTHS);
  const yms = tables.map((t) => t.ym);
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== MAAT.1 balanza + cadena (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`Balanza: ${MONTHS} meses (${yms[yms.length - 1]} … ${yms[0]})\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_ledger (
      sucursal text, cuenta text, cuenta_nombre text, cuenta_mayor text, cuenta_mayor_nombre text,
      familia text, anio_mes text, cargos numeric, abonos numeric, movs int) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_chain (
      sucursal text, factura_folio text, factura_fecha date, orden_folio text, orden_fecha date,
      recepcion_folio text, recepcion_fecha date, pago_folio text, pago_fecha date,
      beneficiario text, total numeric, lead_days int, pago_days int, match_confidence text) ON COMMIT DROP`);

    const summary = [];
    const okCodes = [];
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url });
      try {
        await src.connect();
      } catch (e) {
        console.log(`  ⚠ sucursal ${b.code}: sin conexión (${e.message}) — skip`);
        summary.push({ code: b.code, cuentas_mes: 0, facturas: 0, exact: 0, nota: 'sin conexión' });
        continue;
      }
      okCodes.push(b.code);
      try {
        // catálogo (kdco es sucio: min(c2) por código — un JOIN plano duplica en familia 6)
        const acc = new Map(
          (await src.query(`SELECT c3 AS code, min(c2) AS nombre FROM md.kdco WHERE c3 IS NOT NULL GROUP BY c3`)).rows
            .map((r) => [r.code, r.nombre]),
        );

        // ── Feed 1: balanza por mes ──
        let cuentasMes = 0;
        for (const t of tables) {
          const exists = (await src.query(`SELECT to_regclass('md.${t.tbl}') AS r`)).rows[0].r;
          if (!exists) continue;
          // Solo la sucursal PROPIA: las DBs arrastran réplicas de otras sucursales
          // (verificado: DB03 tiene las filas '02' de dic/ene 100% duplicadas en DB02).
          // La DB de cada sucursal es la fuente de verdad de su código.
          const rows = (await src.query(
            `SELECT $1::text AS sucursal, c3 AS cuenta,
                    SUM(CASE WHEN c4='C' THEN c5 ELSE 0 END)::numeric AS cargos,
                    SUM(CASE WHEN c4='A' THEN c5 ELSE 0 END)::numeric AS abonos,
                    COUNT(*)::int AS movs
               FROM md.${t.tbl}
              WHERE c3 IS NOT NULL AND COALESCE(c5,0) <> 0
                AND (c14 IS NULL OR btrim(c14) = '' OR btrim(c14) = $1)
              GROUP BY 2`, [b.code],
          )).rows;
          const staged = rows.map((r) => {
            const mayor = String(r.cuenta).split('-')[0];
            return [r.sucursal, r.cuenta, acc.get(r.cuenta) || null, mayor, acc.get(mayor) || null,
              String(r.cuenta).slice(0, 1), t.ym, Number(r.cargos) || 0, Number(r.abonos) || 0, Number(r.movs) || 0];
          });
          await bulkInsert(db, 'stg_ledger',
            ['sucursal', 'cuenta', 'cuenta_nombre', 'cuenta_mayor', 'cuenta_mayor_nombre', 'familia', 'anio_mes', 'cargos', 'abonos', 'movs'],
            staged);
          cuentasMes += staged.length;
        }

        // ── Feed 2: cadena de aprovisionamiento (kdm1, snapshot completo) ──
        // c1 = sucursal del documento — filtrar a la propia (DB03 arrastra ~2k docs de la 02).
        const docs = (await src.query(
          `SELECT (c2||c3||lpad(c4::text,2,'0')||lpad(c5::text,2,'0')) AS tipo, c6 AS folio,
                  c9::date AS fecha, NULLIF(btrim(c32),'') AS benef, c16::numeric AS total,
                  NULLIF(btrim(c39::text),'') AS next_folio
             FROM md.kdm1
            WHERE c63 ~ '^X' AND c6 IS NOT NULL
              AND (c1 IS NULL OR btrim(c1) = '' OR btrim(c1) = $1)
              AND (c2||c3||lpad(c4::text,2,'0')||lpad(c5::text,2,'0')) IN ('XA3501','XA3701','XA2001','XA4001')`,
          [b.code],
        )).rows;

        const byType = { XA3501: new Map(), XA3701: new Map(), XA2001: new Map(), XA4001: new Map() };
        const byBT = { XA3501: new Map(), XA3701: new Map(), XA4001: new Map() }; // (benef|total) → rows, para inferencia
        for (const d of docs) {
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

        const chainStg = [];
        let exactN = 0, inferredN = 0, partialN = 0;
        for (const f of byType.XA2001.values()) {
          const pago = hop(f, 'XA4001', f.benef, f.total, f.fecha);
          const recep = hop(pago?.row || f, 'XA3701', f.benef, f.total, f.fecha);
          const orden = hop(recep?.row || f, 'XA3501', f.benef, f.total, f.fecha);
          const allExact = pago?.exact && recep?.exact && orden?.exact;
          const complete = pago && recep && orden;
          const confidence = complete ? (allExact ? 'exact' : 'inferred') : 'partial';
          if (confidence === 'exact') exactN++; else if (confidence === 'inferred') inferredN++; else partialN++;
          chainStg.push([
            b.code, f.folio, f.fecha,
            orden?.row.folio || null, orden?.row.fecha || null,
            recep?.row.folio || null, recep?.row.fecha || null,
            pago?.row.folio || null, pago?.row.fecha || null,
            f.benef || null, Number(f.total) || 0,
            daysBetween(orden?.row.fecha, f.fecha), daysBetween(f.fecha, pago?.row.fecha),
            confidence,
          ]);
        }
        await bulkInsert(db, 'stg_chain',
          ['sucursal', 'factura_folio', 'factura_fecha', 'orden_folio', 'orden_fecha', 'recepcion_folio', 'recepcion_fecha',
            'pago_folio', 'pago_fecha', 'beneficiario', 'total', 'lead_days', 'pago_days', 'match_confidence'],
          chainStg);

        summary.push({ code: b.code, cuentas_mes: cuentasMes, facturas: chainStg.length, exact: exactN, inferred: inferredN, partial: partialN });
      } finally { await src.end(); }
    }
    console.table(summary);

    const nl = (await db.query(`SELECT count(*)::int n FROM stg_ledger`)).rows[0].n;
    const nc = (await db.query(`SELECT count(*)::int n FROM stg_chain`)).rows[0].n;
    console.log(`Staging: ${nl} filas de balanza · ${nc} cadenas.`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!okCodes.length) { await db.query('ROLLBACK'); console.log('\n[APPLY] Ninguna sucursal conectó — nada que aplicar.'); return; }

    // c14 puede diferir del code del MAP → borrar también los codes staged
    const stagedCodes = (await db.query(`SELECT DISTINCT sucursal FROM stg_ledger`)).rows.map((r) => r.sucursal);
    const sucLedger = [...new Set([...okCodes, ...stagedCodes])];
    const delL = await db.query(
      `DELETE FROM analytics.ledger_monthly WHERE tenant_id=$1 AND sucursal = ANY($2) AND anio_mes = ANY($3)`,
      [M, sucLedger, yms]);
    // GROUP BY solo la PK (nombres via MAX): dos fuentes con el mismo código no
    // deben chocar el INSERT aunque sus kdco difieran.
    const upL = await db.query(
      `INSERT INTO analytics.ledger_monthly
         (tenant_id,sucursal,cuenta,cuenta_nombre,cuenta_mayor,cuenta_mayor_nombre,familia,anio_mes,cargos,abonos,neto,movs,computed_at)
       SELECT $1,sucursal,cuenta,MAX(cuenta_nombre),MAX(cuenta_mayor),MAX(cuenta_mayor_nombre),MAX(familia),anio_mes,
              SUM(cargos),SUM(abonos),SUM(cargos)-SUM(abonos),SUM(movs),now()
         FROM stg_ledger
        GROUP BY sucursal,cuenta,anio_mes`,
      [M]);

    const delC = await db.query(
      `DELETE FROM analytics.expense_doc_chain WHERE tenant_id=$1 AND sucursal = ANY($2)`,
      [M, okCodes]);
    const upC = await db.query(
      `INSERT INTO analytics.expense_doc_chain
         (tenant_id,sucursal,factura_folio,factura_fecha,orden_folio,orden_fecha,recepcion_folio,recepcion_fecha,
          pago_folio,pago_fecha,beneficiario,total,lead_days,pago_days,match_confidence,computed_at)
       SELECT $1,sucursal,factura_folio,factura_fecha,orden_folio,orden_fecha,recepcion_folio,recepcion_fecha,
              pago_folio,pago_fecha,beneficiario,total,lead_days,pago_days,match_confidence,now()
         FROM stg_chain
       ON CONFLICT (tenant_id,sucursal,factura_folio) DO NOTHING`,
      [M]);

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — balanza: ${delL.rowCount} borrados + ${upL.rowCount} upserted · cadena: ${delC.rowCount} borrados + ${upC.rowCount} upserted.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
