/* eslint-disable no-console */
/**
 * PV.1 (Fase PV, ADR-041) — Detalle de pólizas ContPAQi → analytics.gl_polizas + gl_poliza_lines.
 * INCREMENTAL por firma de cambio (RowVersion) — apto para correr al minuto sin machacar el SoR.
 *
 * Cómo detecta insert Y update sin re-leer todo:
 *   - ContPAQi trae `RowVersion` (int) por fila en `Polizas` y `MovimientosPoliza`; cambia en
 *     cada insert/update de ESA fila. NO es monotónico global → no sirve de watermark simple,
 *     PERO sí de token de cambio. Firma por póliza = Poliza.RowVersion + SUM(sus movimientos.RowVersion).
 *   - Cada corrida: lee SOLO las firmas (2 agregados ligeros, ~17k filas c/u), las compara contra
 *     `gl_polizas.src_sig` en prod, y trae/UPSERTea la DATA COMPLETA solo del delta (nuevas o
 *     cambiadas). En estado estable el delta es 0-20 pólizas → instantáneo.
 *   - Captura line-edits y line-deletes (la SUMA de RowVersion cambia) → re-fetch header+líneas
 *     del delta y delete+insert de sus líneas (por si se borró/renumeró un movimiento).
 *
 * Flags: --apply · --from <año> (default 2025) · --full (ignora firmas, re-procesa todo).
 * READ-ONLY sobre ContPAQi. UPSERT idempotente. Env: CONTPAQI_SQL_* · DATABASE_URL_NEW.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const fromArg = process.argv.indexOf('--from');
const FROM_YEAR = fromArg !== -1 ? Number(process.argv[fromArg + 1]) : Number(process.env.CONTPAQI_POLIZAS_FROM_YEAR || 2025);
const BATCH = 800;
const FULL_FETCH_THRESHOLD = 3000; // si el delta supera esto (1ª corrida), trae todo sin IN-list

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
const keyOf = (ej, pe, tp, fo) => `${Number(ej)}|${Number(pe)}|${String(tp)}|${String(fo)}`;

(async () => {
  console.log(`ContPAQi pólizas (INCREMENTAL) → ${APPLY ? 'APPLY' : 'DRY-RUN'}${FULL ? ' FULL' : ''} · desde ${FROM_YEAR}`);
  const mss = await sql.connect(SRC);

  // ── 1) Firmas de cambio (ligero): por póliza = Poliza.RowVersion + Σ(movimientos.RowVersion) ──
  const phead = (await mss.request().query(`
    SELECT Id, Ejercicio, Periodo, TipoPol, Folio, RowVersion
      FROM Polizas WHERE Ejercicio >= ${FROM_YEAR}`)).recordset;
  const pmov = (await mss.request().query(`
    SELECT IdPoliza, SUM(CAST(RowVersion AS bigint)) AS msig
      FROM MovimientosPoliza WHERE Ejercicio >= ${FROM_YEAR} GROUP BY IdPoliza`)).recordset;
  const movSig = new Map(pmov.map((r) => [Number(r.IdPoliza), BigInt(r.msig || 0)]));
  // firma y llave por póliza
  const srcSig = new Map();   // key → sig(bigint como string)
  const keyToId = new Map();  // key → Polizas.Id
  for (const h of phead) {
    const k = keyOf(h.Ejercicio, h.Periodo, h.TipoPol, h.Folio);
    const sig = BigInt(h.RowVersion || 0) + (movSig.get(Number(h.Id)) || 0n);
    srcSig.set(k, sig.toString());
    keyToId.set(k, Number(h.Id));
  }
  console.log(`  fuente: ${phead.length} pólizas · ${pmov.length} con movimientos`);

  // ── 2) Firmas en prod ──
  const pg = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();
  await pg.query(`ALTER TABLE analytics.gl_polizas ADD COLUMN IF NOT EXISTS src_sig bigint`);
  const prodSig = new Map();
  if (!FULL) {
    const pr = (await pg.query(
      `SELECT ejercicio, periodo, tipo_pol, folio, src_sig FROM analytics.gl_polizas
        WHERE tenant_id=$1 AND source='contpaqi' AND ejercicio>=$2`, [TENANT, FROM_YEAR])).rows;
    for (const r of pr) prodSig.set(keyOf(r.ejercicio, r.periodo, r.tipo_pol, r.folio), r.src_sig == null ? null : String(r.src_sig));
  }

  // ── 3) Delta = nuevas o firma distinta · borrados = en prod pero ya no en la fuente ──
  const deltaKeys = [];
  for (const [k, sig] of srcSig) { if (FULL || prodSig.get(k) !== sig) deltaKeys.push(k); }
  const deltaIds = deltaKeys.map((k) => keyToId.get(k)).filter(Boolean);
  const goneKeys = FULL ? [] : [...prodSig.keys()].filter((k) => !srcSig.has(k));
  console.log(`  delta: ${deltaKeys.length} pólizas (nuevas/cambiadas) · ${goneKeys.length} borradas`);

  if (!deltaKeys.length && !goneKeys.length) {
    console.log('  ✓ sin cambios — nada que traer.');
    await mss.close(); await pg.end(); return;
  }
  if (!APPLY) { console.log('  DRY-RUN — no escribe. Corre con --apply.'); await mss.close(); await pg.end(); return; }

  // ── 4) Trae la DATA COMPLETA solo del delta ──
  const bigDelta = deltaIds.length > FULL_FETCH_THRESHOLD;
  const heads = [], lines = [];
  const appendAll = (t, s) => { for (const r of s) t.push(r); }; // NO spread (17k+ args revienta el stack)
  const HEAD_Q = (where) => `SELECT p.Id, p.Ejercicio, p.Periodo, p.TipoPol, p.Folio, p.Fecha, p.Concepto, p.Cargos, p.Abonos, p.Guid, p.tieneDoctoBancario FROM Polizas p WHERE ${where}`;
  const LINE_Q = (where) => `SELECT m.IdPoliza, m.Ejercicio, m.Periodo, m.TipoPol, m.Folio, m.NumMovto, c.Codigo AS Cuenta, c.Nombre AS CuentaNombre, c.Afectable, a.Codigo AS SatCod, m.TipoMovto, m.Importe, m.Referencia, m.Guid AS Guid FROM MovimientosPoliza m JOIN Cuentas c ON c.Id=m.IdCuenta LEFT JOIN AgrupadoresSAT a ON a.Id=c.IdAgrupadorSAT WHERE ${where}`;

  if (bigDelta) {
    appendAll(heads, (await mss.request().query(HEAD_Q(`p.Ejercicio >= ${FROM_YEAR}`))).recordset);
    appendAll(lines, (await mss.request().query(LINE_Q(`m.Ejercicio >= ${FROM_YEAR}`))).recordset);
  } else {
    for (let i = 0; i < deltaIds.length; i += 2000) {
      const inList = deltaIds.slice(i, i + 2000).join(',');
      appendAll(heads, (await mss.request().query(HEAD_Q(`p.Id IN (${inList})`))).recordset);
      appendAll(lines, (await mss.request().query(LINE_Q(`m.IdPoliza IN (${inList})`))).recordset);
    }
  }

  // CFDI por GUID (solo del delta si es chico; todo si es full)
  const cfdiByGuid = new Map();
  try {
    const asoc = (await mss.request().query(`SELECT GuidRef, UUID FROM AsocCFDIs WHERE UUID IS NOT NULL AND GuidRef IS NOT NULL`)).recordset;
    for (const r of asoc) { const g = String(r.GuidRef).trim().toUpperCase(); if (g && !cfdiByGuid.has(g)) cfdiByGuid.set(g, String(r.UUID).trim()); }
  } catch (e) { console.warn(`  ⚠ AsocCFDIs: ${e.message.slice(0, 60)}`); }
  await mss.close();

  // ── 5) Ensamblar (mismo shape que la versión full) ──
  const headOut = heads.map((h) => {
    const cargos = round2(h.Cargos), abonos = round2(h.Abonos);
    const k = keyOf(h.Ejercicio, h.Periodo, h.TipoPol, h.Folio);
    return [TENANT, 'contpaqi', '00', Number(h.Ejercicio), Number(h.Periodo), String(h.TipoPol), String(h.Folio),
      anioMes(h.Ejercicio, h.Periodo), iso(h.Fecha), (h.Concepto || '').trim() || null, cargos, abonos, round2(cargos - abonos), 0,
      h.Guid || null, h.tieneDoctoBancario == null ? null : !!h.tieneDoctoBancario, srcSig.get(k) || null];
  });
  const lineOut = lines.filter((l) => round2(l.Importe) !== 0).map((l) => {
    const cuenta = String(l.Cuenta).trim();
    const ca = l.TipoMovto ? 'A' : 'C';
    return [TENANT, 'contpaqi', '00', Number(l.Ejercicio), Number(l.Periodo), String(l.TipoPol), String(l.Folio), Number(l.NumMovto) || 0,
      cuenta, (l.CuentaNombre || '').trim() || null, l.Afectable == null ? null : !!l.Afectable, cuenta.split('-')[0], cuenta.slice(0, 1), ca,
      round2(l.Importe), (l.Referencia || '').trim() || null, cfdiByGuid.get(String(l.Guid || '').trim().toUpperCase()) || null,
      (l.SatCod || '').trim() || null, anioMes(l.Ejercicio, l.Periodo)];
  });
  const cnt = new Map();
  for (const r of lineOut) { const k = `${r[3]}|${r[4]}|${r[5]}|${r[6]}`; cnt.set(k, (cnt.get(k) || 0) + 1); }
  for (const h of headOut) { const k = `${h[3]}|${h[4]}|${h[5]}|${h[6]}`; h[13] = cnt.get(k) || 0; }

  // ── 6) Escribir: UPSERT headers · delete+insert líneas del delta ──
  await pg.query('BEGIN');
  try {
    await upsert(pg, 'analytics.gl_polizas',
      ['tenant_id', 'source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'anio_mes', 'fecha', 'concepto', 'cargos', 'abonos', 'neto', 'num_lines', 'guid', 'tiene_doc_bancario', 'src_sig'],
      ['tenant_id', 'source', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'sucursal'], headOut);
    // borrar líneas de las pólizas del delta (por si se borró/renumeró un movimiento) y reinsertar
    for (let i = 0; i < headOut.length; i += 500) {
      const chunk = headOut.slice(i, i + 500);
      const vals = [], params = [];
      chunk.forEach((h, j) => { vals.push(`($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`); params.push(h[3], h[4], h[5], h[6]); });
      await pg.query(
        `DELETE FROM analytics.gl_poliza_lines WHERE tenant_id='${TENANT}' AND source='contpaqi'
           AND (ejercicio,periodo,tipo_pol,folio) IN (${vals.join(',')})`, params);
    }
    await insert(pg, 'analytics.gl_poliza_lines',
      ['tenant_id', 'source', 'sucursal', 'ejercicio', 'periodo', 'tipo_pol', 'folio', 'num_movto', 'cuenta', 'cuenta_nombre', 'cuenta_afectable', 'cuenta_mayor', 'familia', 'cargo_abono', 'importe', 'referencia', 'cfdi_uuid', 'sat_agrupador', 'anio_mes'], lineOut);
    // borradas: pólizas que ya no existen en la fuente → quitar header + líneas
    for (let i = 0; i < goneKeys.length; i += 500) {
      const chunk = goneKeys.slice(i, i + 500).map((k) => k.split('|'));
      const vals = [], params = [];
      chunk.forEach((p, j) => { vals.push(`($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`); params.push(Number(p[0]), Number(p[1]), p[2], p[3]); });
      const tup = `(ejercicio,periodo,tipo_pol,folio) IN (${vals.join(',')})`;
      await pg.query(`DELETE FROM analytics.gl_poliza_lines WHERE tenant_id='${TENANT}' AND source='contpaqi' AND ${tup}`, params);
      await pg.query(`DELETE FROM analytics.gl_polizas WHERE tenant_id='${TENANT}' AND source='contpaqi' AND ${tup}`, params);
    }
    await pg.query('COMMIT');
  } catch (e) { await pg.query('ROLLBACK').catch(() => {}); throw e; }
  await pg.end();
  console.log(`  ✅ ${headOut.length} pólizas + ${lineOut.length} patas actualizadas (delta).`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

async function upsert(pg, table, cols, pk, rows) {
  const n = cols.length;
  const upd = cols.filter((c) => !pk.includes(c)).map((c) => `${c}=EXCLUDED.${c}`).join(',');
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: n }, (_, k) => `$${j * n + k + 1}`).join(',')})`).join(',');
    await pg.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph}
       ON CONFLICT (${pk.join(',')}) DO UPDATE SET ${upd}, computed_at=now()`, chunk.flat());
  }
}
async function insert(pg, table, cols, rows) {
  const n = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: n }, (_, k) => `$${j * n + k + 1}`).join(',')})`).join(',');
    await pg.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph}
       ON CONFLICT (tenant_id, source, ejercicio, periodo, tipo_pol, folio, sucursal, num_movto, cuenta, cargo_abono) DO UPDATE SET computed_at=now()`, chunk.flat());
  }
}
