/* eslint-disable no-console */
/**
 * CP.2 (Fase CP, ADR-040) — Ledger bancario ContPAQi → analytics.contpaqi_bank_movements.
 *
 * Origen (READ-ONLY): MovimientosPoliza sobre cuentas de banco `102xxxxxxx` (afectable)
 *   ⋈ Cuentas (nombre con número de cuenta) ⋈ Polizas (concepto header).
 * Cargo (TipoMovto=0) = depósito · Abono (TipoMovto=1) = retiro (cuenta de activo).
 *
 *   node database/importers/contpaqi/import-contpaqi-bank-movements.js                 # dry-run (desde 2024)
 *   node database/importers/contpaqi/import-contpaqi-bank-movements.js --apply
 *   node database/importers/contpaqi/import-contpaqi-bank-movements.js --from 2018 --apply
 *
 * Env: CONTPAQI_SQL_* (default decode) · DATABASE_URL_NEW · CONTPAQI_TENANT_ID (default mega_dulces).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const fromArg = process.argv.indexOf('--from');
const FROM_YEAR = fromArg !== -1 ? Number(process.argv[fromArg + 1]) : Number(process.env.CONTPAQI_BANK_FROM_YEAR || 2024);
const BATCH = 1000;

const SRC = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 300000,
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const FULL = process.argv.includes('--full');

(async () => {
  console.log(`ContPAQi bank movements (INCREMENTAL) → ${APPLY ? 'APPLY' : 'DRY-RUN'}${FULL ? ' FULL' : ''} · desde ${FROM_YEAR}`);
  const mss = await sql.connect(SRC);

  // ── 1) Escaneo LIGERO: (Id, RowVersion) de los movimientos de banco 102x ──
  const sigs = (await mss.request().query(`
    SELECT m.Id, m.RowVersion FROM MovimientosPoliza m
      JOIN Cuentas c ON c.Id = m.IdCuenta AND c.Codigo LIKE '102%' AND c.Afectable = 1
     WHERE m.Ejercicio >= ${FROM_YEAR}`)).recordset;
  const srcRv = new Map(sigs.map((r) => [Number(r.Id), Number(r.RowVersion)]));
  console.log(`  fuente: ${srcRv.size} movimientos de banco (≥ ${FROM_YEAR})`);

  // ── 2) Diff vs prod (id_movimiento → src_row_version) ──
  const pgd = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await pgd.connect();
  await pgd.query(`ALTER TABLE analytics.contpaqi_bank_movements ADD COLUMN IF NOT EXISTS src_row_version bigint`);
  const prodRv = new Map();
  if (!FULL) for (const r of (await pgd.query(`SELECT id_movimiento, src_row_version FROM analytics.contpaqi_bank_movements WHERE tenant_id=$1`, [TENANT])).rows) prodRv.set(Number(r.id_movimiento), r.src_row_version == null ? null : Number(r.src_row_version));
  const deltaIds = [];
  for (const [id, rv] of srcRv) { if (FULL || prodRv.get(id) !== rv) deltaIds.push(id); }
  // borrados: en prod pero ya no en la fuente (dentro del alcance) → eliminar
  const goneIds = [];
  for (const id of prodRv.keys()) if (!srcRv.has(id)) goneIds.push(id);
  console.log(`  delta: ${deltaIds.length} nuevos/cambiados · ${goneIds.length} borrados`);

  if (!deltaIds.length && !goneIds.length) { console.log('  ✓ sin cambios.'); await mss.close(); await pgd.end(); return; }
  if (!APPLY) { console.log('  DRY-RUN — no escribe.'); await mss.close(); await pgd.end(); return; }

  // ── 3) Fetch COMPLETO solo del delta ──
  const big = deltaIds.length > 5000;
  const rs = [];
  const append = (t, s) => { for (const r of s) t.push(r); };
  const FQ = (where) => `SELECT m.Id AS IdMov, c.Codigo AS Cuenta, c.Nombre AS CuentaNombre, m.Fecha, m.TipoMovto, m.Importe, m.Ejercicio, m.Periodo, m.TipoPol, m.Folio, m.Guid, m.Referencia, m.EsConciliado, p.Concepto AS PolConcepto FROM MovimientosPoliza m JOIN Cuentas c ON c.Id=m.IdCuenta AND c.Codigo LIKE '102%' AND c.Afectable=1 LEFT JOIN Polizas p ON p.Ejercicio=m.Ejercicio AND p.Periodo=m.Periodo AND p.TipoPol=m.TipoPol AND p.Folio=m.Folio WHERE ${where}`;
  if (big) { append(rs, (await mss.request().query(FQ(`m.Ejercicio >= ${FROM_YEAR}`))).recordset); }
  else for (let i = 0; i < deltaIds.length; i += 2000) append(rs, (await mss.request().query(FQ(`m.Id IN (${deltaIds.slice(i, i + 2000).join(',')})`))).recordset);
  await mss.close();

  const out = rs.map((r) => {
    const per = Number(r.Periodo) || 0;
    const anioMes = `${r.Ejercicio}-${per <= 12 ? String(per).padStart(2, '0') : per}`;
    return [
      TENANT, Number(r.IdMov), String(r.Cuenta).trim(), (r.CuentaNombre || '').trim(),
      iso(r.Fecha), r.TipoMovto ? 'retiro' : 'deposito', round2(r.Importe),
      Number(r.Ejercicio), per, anioMes,
      r.TipoPol ?? null, r.Folio ?? null, r.Guid || null,
      (r.PolConcepto || '').trim() || null, (r.Referencia || '').trim() || null,
      r.EsConciliado === null || r.EsConciliado === undefined ? null : !!r.EsConciliado,
      srcRv.get(Number(r.IdMov)) ?? null, // src_row_version (token de cambio)
    ];
  });

  // ── 4) Escribir delta + borrar los que ya no existen ──
  await pgd.query('BEGIN');
  try {
    const COLS = 17;
    for (let i = 0; i < out.length; i += BATCH) {
      const chunk = out.slice(i, i + BATCH);
      const ph = chunk.map((_, j) => `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`).join(',');
      await pgd.query(
        `INSERT INTO analytics.contpaqi_bank_movements
           (tenant_id, id_movimiento, cuenta, cuenta_nombre, fecha, flujo, importe,
            ejercicio, periodo, anio_mes, poliza_tipo, poliza_folio, poliza_guid, concepto, referencia, es_conciliado, src_row_version)
         VALUES ${ph}
         ON CONFLICT (tenant_id, id_movimiento) DO UPDATE SET
           cuenta=EXCLUDED.cuenta, cuenta_nombre=EXCLUDED.cuenta_nombre, fecha=EXCLUDED.fecha,
           flujo=EXCLUDED.flujo, importe=EXCLUDED.importe, ejercicio=EXCLUDED.ejercicio, periodo=EXCLUDED.periodo,
           anio_mes=EXCLUDED.anio_mes, poliza_tipo=EXCLUDED.poliza_tipo, poliza_folio=EXCLUDED.poliza_folio,
           poliza_guid=EXCLUDED.poliza_guid, concepto=EXCLUDED.concepto, referencia=EXCLUDED.referencia,
           es_conciliado=EXCLUDED.es_conciliado, src_row_version=EXCLUDED.src_row_version, computed_at=now()`,
        chunk.flat());
    }
    for (let i = 0; i < goneIds.length; i += 1000) {
      await pgd.query(`DELETE FROM analytics.contpaqi_bank_movements WHERE tenant_id=$1 AND id_movimiento = ANY($2::bigint[])`, [TENANT, goneIds.slice(i, i + 1000)]);
    }
    await pgd.query('COMMIT');
  } catch (e) { await pgd.query('ROLLBACK').catch(() => {}); throw e; }
  await pgd.end();
  console.log(`  ✅ ${out.length} movimientos actualizados · ${goneIds.length} borrados.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
