/* eslint-disable no-console */
/**
 * GX v3 — Tanda 2: auxiliar de proveedores (201) + hallazgos contables → analytics.
 *
 * Lee de las pólizas `kdc2YYMM` de cada sucursal Kepler (READ-ONLY):
 *   - cuenta 201 (proveedores): facturas (abono vía XA2001) y pagos (cargo vía
 *     XD2601/XD2501) → `analytics.ap_provider` (compra, pagos, saldo, #fact, DPO).
 *   - hallazgos → `analytics.expense_findings`:
 *       iva_bug      = pólizas XD5501 descuadradas (abono huérfano a 122-001)
 *       prov_203     = provisiones a 203 (abonos, nunca descargadas)
 *       anticipo_107 = anticipos a proveedor (cargos a 107, sin aplicar)
 *
 *   node database/importers/kepler/import-ap-findings.js            # dry-run (12 meses)
 *   node database/importers/kepler/import-ap-findings.js --apply    # commit
 *   ... --months 12 · EXPENSES_BRANCH_MAP='[...]'                   # overrides
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

function monthWindow(n) {
  const now = new Date();
  const tables = [];
  let y = now.getFullYear(), m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    tables.push(`kdc2${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`);
    m--; if (m === 0) { m = 12; y--; }
  }
  const first = tables[tables.length - 1];
  const fy = 2000 + Number(first.slice(4, 6)), fm = Number(first.slice(6, 8));
  const from = `${fy}-${String(fm).padStart(2, '0')}-01`;
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-31`;
  return { tables, from, to };
}

// Normaliza razón social (c6): mayúsculas, sin acentos, '?'→espacio, sin puntuación.
// El '?' es un char no-ASCII perdido en el encoding, determinista (CANEL?S=Canel's).
function normProv(s) {
  if (!s) return null;
  return String(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\?/g, ' ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

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

(async () => {
  const { tables, from, to } = monthWindow(MONTHS);
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== AP + Hallazgos → analytics (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`Ventana: ${MONTHS} meses (${from} … ${to})\n`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    const apRows = [];       // ap_provider
    const findingRows = [];  // expense_findings
    const okCodes = [];
    const summary = [];

    for (const b of MAP) {
      const src = new Client({ connectionString: b.url });
      try { await src.connect(); }
      catch (e) { console.log(`  ⚠ sucursal ${b.code}: sin conexión (${e.message}) — skip`); summary.push({ code: b.code, nota: 'sin conexión' }); continue; }
      okCodes.push(b.code);
      try {
        // proveedores (201) + provisiones 203 + anticipos 107
        const prov = new Map();   // norm → {compra,pagos,fact,ultima, names:Map(raw→$)}
        const getP = (k) => { let p = prov.get(k); if (!p) { p = { compra: 0, pagos: 0, fact: 0, ultima: null, names: new Map() }; prov.set(k, p); } return p; };

        for (const t of tables) {
          if (!(await src.query(`SELECT to_regclass('md.${t}') r`)).rows[0].r) continue;
          const rows = (await src.query(
            `SELECT c14 AS suc, c2::date AS fecha, c3 AS cuenta, c4 AS ca, c5::numeric AS imp,
                    NULLIF(btrim(c6),'') AS benef,
                    (c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0')) AS doc_tipo, c19 AS folio
               FROM md.${t}
              WHERE COALESCE(c5,0) <> 0
                AND (c3='201' OR c3='203' OR c3='107'
                     OR (c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0'))='XD5501')`,
          )).rows;

          const xd = new Map(); // XD5501 folio → {cargos,abonos,iva001,fecha,benef,suc}
          for (const r of rows) {
            const suc = r.suc || b.code;
            // 201 — auxiliar de proveedores
            if (r.cuenta === '201') {
              const k = normProv(r.benef);
              if (k) {
                const p = getP(k);
                if (r.ca === 'A' && r.doc_tipo === 'XA2001') {
                  p.compra += Number(r.imp); p.fact++;
                  if (!p.ultima || r.fecha > p.ultima) p.ultima = r.fecha;
                  p.names.set(r.benef, (p.names.get(r.benef) || 0) + Number(r.imp));
                } else if (r.ca === 'C' && (r.doc_tipo === 'XD2601' || r.doc_tipo === 'XD2501')) {
                  p.pagos += Number(r.imp);
                }
              }
            }
            // 203 — provisión no descargada (abono)
            if (r.cuenta === '203' && r.ca === 'A') {
              findingRows.push(['prov_203', suc, r.fecha, r.doc_tipo, r.folio, r.benef, '203', Number(r.imp), null]);
            }
            // 107 — anticipo a proveedor (cargo)
            if (r.cuenta === '107' && r.ca === 'C') {
              findingRows.push(['anticipo_107', suc, r.fecha, r.doc_tipo, r.folio, r.benef, '107', Number(r.imp), null]);
            }
            // XD5501 — acumula por póliza para detectar descuadre
            if (r.doc_tipo === 'XD5501') {
              const fk = `${suc}|${r.folio}`;
              let g = xd.get(fk);
              if (!g) { g = { suc, folio: r.folio, cargos: 0, abonos: 0, iva001: 0, fecha: r.fecha, benef: null }; xd.set(fk, g); }
              if (r.ca === 'C') g.cargos += Number(r.imp); else g.abonos += Number(r.imp);
              if (r.cuenta && r.cuenta.startsWith('122-001') && r.ca === 'A') g.iva001 += Number(r.imp);
              if (!g.benef && r.benef) g.benef = r.benef;
              if (r.fecha && (!g.fecha || r.fecha < g.fecha)) g.fecha = r.fecha;
            }
          }
          // cierra XD5501 del mes: los descuadrados son iva_bug
          for (const g of xd.values()) {
            const desc = Math.round((g.cargos - g.abonos) * 100) / 100;
            if (Math.abs(desc) >= 0.01) {
              findingRows.push(['iva_bug', g.suc, g.fecha, 'XD5501', g.folio, g.benef, '122-001',
                Math.round(g.iva001 * 100) / 100, `descuadre ${desc.toFixed(2)}`]);
            }
          }
        }

        // consolida ap_provider de la sucursal
        for (const [k, p] of prov) {
          if (p.compra <= 0 && p.pagos <= 0) continue;
          const saldo = Math.round((p.compra - p.pagos) * 100) / 100;
          const dpo = p.compra > 0 && saldo > 0 ? Math.round(saldo / (p.compra / 365)) : null;
          let display = k, best = -1;
          for (const [raw, amt] of p.names) if (amt > best) { best = amt; display = raw; }
          apRows.push([b.code, k, display, Math.round(p.compra * 100) / 100, Math.round(p.pagos * 100) / 100,
            saldo, p.fact, p.ultima, dpo]);
        }
        summary.push({ code: b.code, proveedores: prov.size, hallazgos_acum: findingRows.length });
      } finally { await src.end(); }
    }
    console.table(summary);
    console.log(`ap_provider filas: ${apRows.length} · findings filas: ${findingRows.length}`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    if (!okCodes.length) { await db.query('ROLLBACK'); console.log('\n[APPLY] Ninguna sucursal conectó — nada que aplicar.'); return; }

    // ap_provider: snapshot completo por sucursal (DELETE branch + INSERT)
    await db.query(`DELETE FROM analytics.ap_provider WHERE tenant_id=$1 AND sucursal = ANY($2)`, [M, okCodes]);
    await bulkInsert(db, 'analytics.ap_provider',
      ['tenant_id', 'sucursal', 'proveedor_norm', 'proveedor', 'compra_12m', 'pagos_12m', 'saldo', 'num_facturas', 'ultima_compra', 'dpo_dias'],
      apRows.map((r) => [M, ...r]));

    // findings: DELETE por sucursal+ventana + INSERT
    await db.query(`DELETE FROM analytics.expense_findings WHERE tenant_id=$1 AND sucursal = ANY($2) AND fecha >= $3::date AND fecha <= $4::date`, [M, okCodes, from, to]);
    await bulkInsert(db, 'analytics.expense_findings',
      ['tenant_id', 'tipo', 'sucursal', 'fecha', 'doc_tipo', 'doc_folio', 'beneficiario', 'cuenta', 'importe', 'nota'],
      findingRows.map((r) => [M, ...r]));

    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ap_provider ${apRows.length} · findings ${findingRows.length}.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
