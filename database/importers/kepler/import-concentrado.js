/* eslint-disable no-console */
/**
 * CB.11 — Importer de la hoja CONCENTRADO → finance.bank_concentrado_ref (ADR-033).
 *
 * El CONCENTRADO es la verdad reconciliada a mano: por cuenta × tipo (I/ID/LEM/CI/C/
 * CF/PF/P/PLEM/G/TI/TE + SALDO_INICIAL) declara el monto correcto. Se guarda como
 * referencia para VALIDAR el parseo (reconcileVsConcentrado en el backend): cualquier
 * Δ≠0 entre bank_movements y esta tabla = error de captura nuestro.
 *
 *   node database/importers/kepler/import-concentrado.js --file "01 ENERO 2026.xlsx"          # dry-run
 *   node database/importers/kepler/import-concentrado.js --file "01 ENERO 2026.xlsx" --apply
 */
const ExcelJS = require('exceljs');
const { Client } = require('pg');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; };
const FILE = arg('file', '01 ENERO 2026.xlsx');
const MONTHS = { ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06', JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12' };
const derive = (f) => { const m = f.toUpperCase().match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/); return m ? `${m[2]}-${MONTHS[m[1]]}` : null; };
const PERIOD = arg('period', derive(FILE));

const TYPES = ['I', 'ID', 'LEM', 'CI', 'C', 'CF', 'PF', 'P', 'PLEM', 'G', 'TI', 'TE'];
const num = (cell) => { let v = cell.value; if (v && typeof v === 'object') { if ('result' in v) v = v.result; else if ('text' in v) v = v.text; } const n = Number(v); return isNaN(n) ? 0 : n; };
const txt = (cell) => { let v = cell.value; if (v && typeof v === 'object') { if ('richText' in v) return v.richText.map((t) => t.text).join(''); if ('result' in v) v = v.result; if (v && 'text' in v) v = v.text; } return v == null ? '' : String(v).trim(); };
const digits = (s) => String(s).replace(/\D/g, '');
const accountKey = (banco, cuenta) => digits(cuenta) || String(cuenta).toUpperCase().replace(/[^A-Z0-9]/g, '') || String(banco).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

async function main() {
  if (!PERIOD) throw new Error('No pude derivar el periodo del nombre del archivo; pasa --period YYYY-MM');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const conc = wb.worksheets.find((w) => /concentr/i.test(w.name));
  if (!conc) throw new Error('No encontré la hoja CONCENTRADO en el workbook');

  const hdr = conc.getRow(4); const colOf = {};
  hdr.eachCell({ includeEmpty: true }, (c, i) => { const t = txt(c).toUpperCase(); if (TYPES.includes(t)) colOf[t] = i; });
  const missing = TYPES.filter((t) => !colOf[t]);
  if (missing.length) console.warn(`⚠ tipos sin columna en el CONCENTRADO: ${missing.join(', ')} (se guardan en 0)`);

  const rows = [];
  for (let rn = 5; rn <= 24; rn++) { // bloque de cuentas (fila 25 = TOTAL; 27+ = notas)
    const row = conc.getRow(rn);
    const banco = txt(row.getCell(2)), cuenta = txt(row.getCell(3));
    if (!banco || /TOTAL|DIFERENCIA|SALDO\s*FINAL/i.test(banco) || /TOTAL|DIFERENCIA/i.test(cuenta)) continue;
    const key = accountKey(banco, cuenta);
    const saldoIni = num(row.getCell(4)); // col D = SALDO INICIAL
    rows.push({ key, banco, cuenta, tipo: 'SALDO_INICIAL', monto: saldoIni });
    for (const ty of TYPES) rows.push({ key, banco, cuenta, tipo: ty, monto: colOf[ty] ? num(row.getCell(colOf[ty])) : 0 });
  }
  const accounts = [...new Set(rows.map((r) => r.key))];
  console.log(`Periodo ${PERIOD}: ${accounts.length} cuentas, ${rows.length} filas de referencia (${rows.filter((r) => r.monto !== 0).length} != 0).`);
  console.log('Cuentas:', accounts.join(', '));

  if (!APPLY) { console.log('\n(dry-run; usa --apply para escribir)'); return; }

  const c = new Client({ connectionString: DST, ssl: /localhost|127\.0\.0\.1/.test(DST) ? false : { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query('BEGIN');
    let n = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO finance.bank_concentrado_ref (tenant_id, period, bank, cuenta, account_key, tipo, monto, source_file, imported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (tenant_id, period, account_key, tipo)
         DO UPDATE SET monto=EXCLUDED.monto, bank=EXCLUDED.bank, cuenta=EXCLUDED.cuenta, source_file=EXCLUDED.source_file, imported_at=now()`,
        [MEGA, PERIOD, r.banco, r.cuenta, r.key, r.tipo, r.monto, FILE],
      );
      n++;
    }
    await c.query('COMMIT');
    console.log(`✅ ${n} filas de referencia upsert (${PERIOD}).`);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
