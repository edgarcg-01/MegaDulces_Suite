/* eslint-disable no-console */
/**
 * PV.1 (Fase PV, ADR-041) — Detalle de pólizas de ContPAQi → analytics.gl_polizas + gl_poliza_lines.
 *
 * Trae la PARTIDA DOBLE COMPLETA por póliza (ambas patas) desde los libros fiscales
 * (SQL Server ContPAQi COMPAC, empresa ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ). Es la fuente
 * primaria del motor de cuadre: `Polizas` ya trae Cargos/Abonos totalizados, y
 * `MovimientosPoliza` las patas. Enriquece con el UUID del CFDI (AsocCFDIs) cuando existe
 * → habilita el cruce exacto póliza↔CFDI que Kepler no permite.
 *
 *   node database/importers/contpaqi/import-contpaqi-polizas.js                 # dry-run (desde 2025)
 *   node database/importers/contpaqi/import-contpaqi-polizas.js --apply
 *   node database/importers/contpaqi/import-contpaqi-polizas.js --from 2024 --apply
 *
 * READ-ONLY sobre ContPAQi. UPSERT idempotente sobre newdb. Env: CONTPAQI_SQL_* · DATABASE_URL_NEW.
 *
 * NOTA (verificar en la máquina de feeds): el join de AsocCFDIs se hace en un paso
 * SEPARADO envuelto en try/catch — si el nombre de columna del link difiere en la
 * instancia real, el import CORE (header+patas) igual entra; el UUID queda null y se
 * cablea el join después (mismo patrón de decode que usó el importer de bancos).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const fromArg = process.argv.indexOf('--from');
const FROM_YEAR = fromArg !== -1 ? Number(process.argv[fromArg + 1]) : Number(process.env.CONTPAQI_POLIZAS_FROM_YEAR || 2025);
const BATCH = 800;

const SRC = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 600000,
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => (d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null);
const anioMes = (y, p) => `${y}-${Number(p) <= 12 ? String(Number(p)).padStart(2, '0') : Number(p)}`;

(async () => {
  console.log(`ContPAQi pólizas → ${APPLY ? 'APPLY' : 'DRY-RUN'} · desde ${FROM_YEAR} · tenant ${TENANT}`);
  const mss = await sql.connect(SRC);

  // ── Header de pólizas (Cargos/Abonos ya totalizados por ContPAQi) ──
  const heads = (await mss.request().query(`
    SELECT p.Ejercicio, p.Periodo, p.TipoPol, p.Folio, p.Fecha, p.Concepto,
           p.Cargos, p.Abonos, p.Guid, p.tieneDoctoBancario
      FROM Polizas p
     WHERE p.Ejercicio >= ${FROM_YEAR}`)).recordset;
  console.log(`  ${heads.length} pólizas (header)`);

  // ── Patas (MovimientosPoliza ⋈ Cuentas) ──
  const lines = (await mss.request().query(`
    SELECT m.Ejercicio, m.Periodo, m.TipoPol, m.Folio, m.NumMovto,
           c.Codigo AS Cuenta, c.Nombre AS CuentaNombre, c.Afectable,
           a.Codigo AS SatCod, m.TipoMovto, m.Importe, m.Referencia, m.Id AS IdMov
      FROM MovimientosPoliza m
      JOIN Cuentas c ON c.Id = m.IdCuenta
      LEFT JOIN AgrupadoresSAT a ON a.Id = c.IdAgrupadorSAT
     WHERE m.Ejercicio >= ${FROM_YEAR}`)).recordset;
  console.log(`  ${lines.length} movimientos (patas)`);

  // ── CFDI por movimiento (AsocCFDIs) — opcional, tolerante a diferencias de esquema ──
  const cfdiByMov = new Map();
  try {
    const asoc = (await mss.request().query(`
      SELECT ac.IdMovimientoPoliza AS IdMov, da.Uuid AS Uuid
        FROM AsocCFDIs ac
        JOIN DocumentosAdministrativos da ON da.Id = ac.IdDocumentoAdministrativo`)).recordset;
    for (const r of asoc) if (r.IdMov != null && r.Uuid) cfdiByMov.set(Number(r.IdMov), String(r.Uuid).trim());
    console.log(`  ${cfdiByMov.size} movimientos con CFDI (AsocCFDIs)`);
  } catch (e) {
    console.warn(`  ⚠ AsocCFDIs no resuelto (${e.message}) — cfdi_uuid quedará null; cablear el join en feeds.`);
  }
  await mss.close();

  // ── Ensamblar ──
  const headOut = heads.map((h) => {
    const cargos = round2(h.Cargos), abonos = round2(h.Abonos);
    return [
      TENANT, 'contpaqi', '00', Number(h.Ejercicio), Number(h.Periodo),
      String(h.TipoPol), String(h.Folio), anioMes(h.Ejercicio, h.Periodo), iso(h.Fecha),
      (h.Concepto || '').trim() || null, cargos, abonos, round2(cargos - abonos), 0,
      h.Guid || null, h.tieneDoctoBancario == null ? null : !!h.tieneDoctoBancario,
    ];
  });

  const lineOut = lines.filter((l) => round2(l.Importe) !== 0).map((l) => {
    const cuenta = String(l.Cuenta).trim();
    const ca = l.TipoMovto ? 'A' : 'C'; // TipoMovto 0=cargo, 1=abono (mismo criterio que el importer de bancos)
    return [
      TENANT, 'contpaqi', '00', Number(l.Ejercicio), Number(l.Periodo),
      String(l.TipoPol), String(l.Folio), Number(l.NumMovto) || 0,
      cuenta, (l.CuentaNombre || '').trim() || null, l.Afectable == null ? null : !!l.Afectable,
      cuenta.split('-')[0], cuenta.slice(0, 1), ca, round2(l.Importe),
      (l.Referencia || '').trim() || null, cfdiByMov.get(Number(l.IdMov)) || null,
      (l.SatCod || '').trim() || null, anioMes(l.Ejercicio, l.Periodo),
    ];
  });

  // num_lines por póliza (para el header)
  const cnt = new Map();
  for (const r of lineOut) { const k = `${r[3]}|${r[4]}|${r[5]}|${r[6]}`; cnt.set(k, (cnt.get(k) || 0) + 1); }
  for (const h of headOut) { const k = `${h[3]}|${h[4]}|${h[5]}|${h[6]}`; h[13] = cnt.get(k) || 0; }

  const descuadradas = headOut.filter((h) => Math.abs(h[12]) >= 0.01).length;
  console.log(`  pólizas que NO cuadran (|cargos−abonos|≥$0.01): ${descuadradas}`);
  console.log(`  muestra:`, headOut.slice(0, 3).map((h) => `${h[7]} ${h[5]}/${h[6]} neto $${h[12]}`).join(' | '));

  if (!APPLY) { console.log('DRY-RUN — nada escrito. Corre con --apply.'); return; }

  const pg = new Client({ connectionString: DST });
  await pg.connect();
  await upsert(pg, 'analytics.gl_polizas',
    ['tenant_id', 'source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'fecha', 'concepto', 'cargos', 'abonos', 'neto', 'num_lines', 'guid', 'tiene_doc_bancario'],
    ['tenant_id', 'source', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'sucursal'], headOut);
  await upsert(pg, 'analytics.gl_poliza_lines',
    ['tenant_id', 'source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'num_movto', 'cuenta', 'cuenta_nombre', 'cuenta_afectable', 'cuenta_mayor', 'familia', 'cargo_abono', 'importe', 'referencia', 'cfdi_uuid', 'sat_agrupador', 'anio_mes'],
    ['tenant_id', 'source', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'sucursal', 'num_movto', 'cuenta', 'cargo_abono'], lineOut);
  await pg.end();
  console.log(`✅ UPSERT ${headOut.length} pólizas + ${lineOut.length} patas en analytics.gl_*`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

async function upsert(pg, table, cols, pk, rows) {
  const n = cols.length;
  const upd = cols.filter((c) => !pk.includes(c)).map((c) => `${c}=EXCLUDED.${c}`).join(',');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: n }, (_, k) => `$${j * n + k + 1}`).join(',')})`).join(',');
    await pg.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph}
       ON CONFLICT (${pk.join(',')}) DO UPDATE SET ${upd}, computed_at=now()`,
      chunk.flat());
  }
}
