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

(async () => {
  console.log(`ContPAQi bank movements → ${APPLY ? 'APPLY' : 'DRY-RUN'} · desde ${FROM_YEAR} · tenant ${TENANT}`);
  const mss = await sql.connect(SRC);
  const rs = (await mss.request().query(`
    SELECT m.Id AS IdMov, c.Codigo AS Cuenta, c.Nombre AS CuentaNombre,
           m.Fecha, m.TipoMovto, m.Importe, m.Ejercicio, m.Periodo,
           m.TipoPol, m.Folio, m.Guid, m.Referencia, m.EsConciliado,
           p.Concepto AS PolConcepto
      FROM MovimientosPoliza m
      JOIN Cuentas c ON c.Id = m.IdCuenta AND c.Codigo LIKE '102%' AND c.Afectable = 1
      LEFT JOIN Polizas p ON p.Ejercicio = m.Ejercicio AND p.Periodo = m.Periodo AND p.TipoPol = m.TipoPol AND p.Folio = m.Folio
     WHERE m.Ejercicio >= ${FROM_YEAR}`)).recordset;
  await mss.close();
  console.log(`  origen: ${rs.length} movimientos de banco (≥ ${FROM_YEAR})`);

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
    ];
  });

  const dep = out.filter((r) => r[5] === 'deposito').reduce((s, r) => s + r[6], 0);
  const ret = out.filter((r) => r[5] === 'retiro').reduce((s, r) => s + r[6], 0);
  console.log(`  depósitos $${round2(dep).toLocaleString()}  ·  retiros $${round2(ret).toLocaleString()}`);
  console.log(`  muestra:`, out.slice(0, 3).map((r) => `${r[2]} ${r[9]} ${r[5]} $${r[6]}`).join(' | '));

  if (!APPLY) { console.log('DRY-RUN — nada escrito. Corre con --apply.'); return; }

  const pg = new Client({ connectionString: DST });
  await pg.connect();
  const COLS = 16;
  let done = 0;
  for (let i = 0; i < out.length; i += BATCH) {
    const chunk = out.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`).join(',');
    await pg.query(
      `INSERT INTO analytics.contpaqi_bank_movements
         (tenant_id, id_movimiento, cuenta, cuenta_nombre, fecha, flujo, importe,
          ejercicio, periodo, anio_mes, poliza_tipo, poliza_folio, poliza_guid, concepto, referencia, es_conciliado)
       VALUES ${ph}
       ON CONFLICT (tenant_id, id_movimiento) DO UPDATE SET
         cuenta=EXCLUDED.cuenta, cuenta_nombre=EXCLUDED.cuenta_nombre, fecha=EXCLUDED.fecha,
         flujo=EXCLUDED.flujo, importe=EXCLUDED.importe, ejercicio=EXCLUDED.ejercicio, periodo=EXCLUDED.periodo,
         anio_mes=EXCLUDED.anio_mes, poliza_tipo=EXCLUDED.poliza_tipo, poliza_folio=EXCLUDED.poliza_folio,
         poliza_guid=EXCLUDED.poliza_guid, concepto=EXCLUDED.concepto, referencia=EXCLUDED.referencia,
         es_conciliado=EXCLUDED.es_conciliado, computed_at=now()`,
      chunk.flat());
    done += chunk.length;
  }
  await pg.end();
  console.log(`✅ UPSERT ${done} movimientos en analytics.contpaqi_bank_movements`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
