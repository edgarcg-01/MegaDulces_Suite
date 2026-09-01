/* eslint-disable no-console */
/**
 * LC.3 (Fase LC, ADR-052) — Siembra `finance.gl_supplier_accounts` desde el catálogo de
 * proveedores del libro de compras, validando cada cuenta contra ContPAQi.
 *
 * Fuente: hoja `DATOS` del workbook "LIBRO DE COMPRAS" (clave, nombre, RFC, cuenta).
 * Verificado 2026-09-01: sus números de cuenta empatan con las 177 cuentas `212` que el
 * asiento realmente usa, 177 de 177, y el nombre coincide en 175 (las otras dos difieren
 * solo en puntuación). NO se usa `analytics.contpaqi_suppliers`: su `codigo` da un empate
 * numérico espurio contra otro proveedor (ver el comentario de la migración).
 *
 * Qué hace cada corrida:
 *   1. lee el catálogo del workbook
 *   2. pregunta a ContPAQi cuáles de las cuentas 212/501/502 existen de verdad — el TXT no
 *      puede citar una cuenta inexistente porque la importación falla
 *   3. marca cuáles ya aparecen en pólizas reales (`analytics.gl_poliza_lines`)
 *   4. UPSERT por `(tenant_id, account_suffix)`
 *
 * Es el sembrado INICIAL. De aquí en adelante el mapa se edita desde la UI: un proveedor
 * nuevo se da de alta ahí, no volviendo a correr esto.
 *
 * Flags: --apply · --file <ruta del xlsx>
 * READ-ONLY sobre ContPAQi. Env: CONTPAQI_SQL_* · DATABASE_URL_NEW.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const ExcelJS = require('exceljs');
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; };
const XLSX = arg('--file', process.env.LIBRO_COMPRAS_XLSX || 'C:/Users/Sistemas/Desktop/LIBRO DE COMPRAS 2026-.xlsx');

const SRC = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 300000,
};

const cel = (c) => {
  let v = c.type === 6 ? (c.result ?? '') : c.value;
  if (v && typeof v === 'object') v = v.text ?? v.result ?? '';
  return String(v ?? '').trim();
};

(async () => {
  console.log(`Catálogo de proveedores → finance.gl_supplier_accounts · ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  workbook: ${XLSX}`);

  // ── 1) Catálogo del workbook ─────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ds = wb.getWorksheet('DATOS');
  if (!ds) throw new Error('el workbook no tiene hoja DATOS');

  const provs = [];
  const vistos = new Set();
  for (let r = 3; r <= ds.rowCount; r++) {
    const row = ds.getRow(r);
    const nombre = cel(row.getCell(2));
    const cuenta = cel(row.getCell(4));
    if (!nombre || !cuenta) continue;
    const suffix = String(cuenta).replace(/\D/g, '').padStart(7, '0');
    if (suffix === '0000000' || vistos.has(suffix)) continue;   // la llave es el sufijo
    vistos.add(suffix);
    provs.push({
      suffix,
      code: cel(row.getCell(1)) || null,
      name: nombre,
      rfc: cel(row.getCell(3)).toUpperCase() || null,
    });
  }
  console.log(`  ${provs.length} proveedores con cuenta · ${provs.filter((p) => !p.rfc).length} sin RFC`);

  // ── 2) ¿Qué cuentas existen de verdad en ContPAQi? ───────────────────────────────────
  const mss = await sql.connect(SRC);
  const existentes = new Set(
    (await mss.request().query(`
      SELECT Codigo FROM Cuentas
       WHERE Codigo LIKE '212%' OR Codigo LIKE '501%' OR Codigo LIKE '502%'`)).recordset
      .map((x) => String(x.Codigo).trim()),
  );
  await mss.close();
  console.log(`  ${existentes.size} cuentas 212/501/502 en el catálogo de ContPAQi`);

  // ── 3) ¿Cuáles ya se usaron en pólizas reales? ───────────────────────────────────────
  const pg = new Client({ connectionString: DST, ssl: DST.includes('rlwy.net') ? { rejectUnauthorized: false } : false });
  await pg.connect();
  const usados = new Set(
    (await pg.query(`
      SELECT DISTINCT right(cuenta, 7) AS sufijo
        FROM analytics.gl_poliza_lines
       WHERE source = 'contpaqi' AND cuenta LIKE '212%'`)).rows.map((r) => r.sufijo),
  );
  console.log(`  ${usados.size} sufijos ya vistos en pólizas reales`);

  const rows = provs.map((p) => {
    const c212 = `212${p.suffix}`;
    const c501 = `501${p.suffix}`;
    const c502 = `502${p.suffix}`;
    return [
      TENANT, p.code, p.name, p.rfc, p.suffix, c212, c501, c502,
      existentes.has(c212), existentes.has(c501), existentes.has(c502),
      usados.has(p.suffix), 'libro_compras_xlsx',
    ];
  });

  const resumen = {
    proveedores: rows.length,
    'cuenta de pasivo existe': rows.filter((r) => r[8]).length,
    'compra exenta existe': rows.filter((r) => r[9]).length,
    'compra c/IVA existe': rows.filter((r) => r[10]).length,
    'ya usados en pólizas': rows.filter((r) => r[11]).length,
    'sin RFC': rows.filter((r) => !r[3]).length,
  };
  console.table([resumen]);

  const huerfanos = rows.filter((r) => !r[8]);
  if (huerfanos.length) {
    console.log(`\n  ⚠️ ${huerfanos.length} proveedores cuya cuenta de pasivo NO existe en ContPAQi:`);
    huerfanos.slice(0, 10).forEach((r) => console.log(`     ${r[5]} · ${r[2]}`));
  }

  if (!APPLY) { console.log('\n  DRY-RUN — corre con --apply para escribir.'); await pg.end(); return; }

  const COLS = ['tenant_id', 'supplier_code', 'supplier_name', 'rfc', 'account_suffix', 'cuenta_proveedor',
    'cuenta_compra_exenta', 'cuenta_compra_iva', 'proveedor_existe', 'compra_exenta_existe',
    'compra_iva_existe', 'usado_en_asiento', 'source'];
  // El sembrado no pisa lo que un humano haya editado en la UI: `source` distinto de
  // 'libro_compras_xlsx' significa que alguien lo corrigió a mano y esa versión manda.
  const upd = COLS.filter((c) => !['tenant_id', 'account_suffix'].includes(c)).map((c) => `${c}=EXCLUDED.${c}`).join(',');
  let n = 0;
  try {
    await pg.query('BEGIN');
    for (let i = 0; i < rows.length; i += 300) {
      const chunk = rows.slice(i, i + 300);
      const ph = chunk.map((_, j) => `(${COLS.map((_, k) => `$${j * COLS.length + k + 1}`).join(',')})`).join(',');
      await pg.query(`INSERT INTO finance.gl_supplier_accounts (${COLS.join(',')}) VALUES ${ph}
         ON CONFLICT (tenant_id, account_suffix) DO UPDATE SET ${upd}, verificado_at=now(), updated_at=now()
         WHERE finance.gl_supplier_accounts.source = 'libro_compras_xlsx'`, chunk.flat());
      n += chunk.length;
    }
    await pg.query(`UPDATE finance.gl_supplier_accounts SET verificado_at = now()
                     WHERE tenant_id = $1 AND source = 'libro_compras_xlsx'`, [TENANT]);
    await pg.query('COMMIT');
  } catch (e) { await pg.query('ROLLBACK').catch(() => {}); await pg.end(); throw e; }
  await pg.end();
  console.log(`\n  ✅ ${n} proveedores sembrados en finance.gl_supplier_accounts.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
