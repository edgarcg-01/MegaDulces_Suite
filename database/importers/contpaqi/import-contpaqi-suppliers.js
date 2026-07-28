/* eslint-disable no-console */
/**
 * CP.3 (Fase CP, ADR-040) — Proveedores de ContPAQi → analytics.contpaqi_suppliers.
 * Origen (READ-ONLY): ContPAQi `Proveedores` (RFC + retenciones). UPSERT idempotente por codigo.
 * Sirve para el cruce contra la lista negra del SAT (fiscal.sat_list_rfcs).
 *
 *   node database/importers/contpaqi/import-contpaqi-suppliers.js            # dry-run
 *   node database/importers/contpaqi/import-contpaqi-suppliers.js --apply
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
const BATCH = 1000;

const SRC = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 120000,
};

const clean = (s) => (s == null ? null : String(s).trim() || null);
const num = (n) => (n == null || Number.isNaN(Number(n)) ? null : Number(n));

(async () => {
  console.log(`ContPAQi suppliers → ${APPLY ? 'APPLY' : 'DRY-RUN'} · tenant ${TENANT}`);
  const mss = await sql.connect(SRC);
  const rs = (await mss.request().query(`
    SELECT Codigo, Nombre, RFC, TipoTercero, RetencionIVA, RetencionISR FROM Proveedores`)).recordset;
  await mss.close();

  const out = rs.map((r) => [TENANT, clean(r.Codigo), clean(r.Nombre), (clean(r.RFC) || '').toUpperCase() || null, num(r.TipoTercero), num(r.RetencionIVA), num(r.RetencionISR)])
    .filter((r) => r[1]); // requiere codigo
  const withRfc = out.filter((r) => r[3]).length;
  console.log(`  origen: ${rs.length} proveedores → ${out.length} con código · ${withRfc} con RFC`);
  console.log(`  muestra:`, out.slice(0, 3).map((r) => `${r[1]} ${r[2]} [${r[3] || 'sin RFC'}]`).join(' | '));

  if (!APPLY) { console.log('DRY-RUN — nada escrito. Corre con --apply.'); return; }

  const pg = new Client({ connectionString: DST });
  await pg.connect();
  const COLS = 7;
  let done = 0;
  for (let i = 0; i < out.length; i += BATCH) {
    const chunk = out.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`).join(',');
    await pg.query(
      `INSERT INTO analytics.contpaqi_suppliers (tenant_id, codigo, nombre, rfc, tipo_tercero, retencion_iva, retencion_isr)
       VALUES ${ph}
       ON CONFLICT (tenant_id, codigo) DO UPDATE SET
         nombre=EXCLUDED.nombre, rfc=EXCLUDED.rfc, tipo_tercero=EXCLUDED.tipo_tercero,
         retencion_iva=EXCLUDED.retencion_iva, retencion_isr=EXCLUDED.retencion_isr, computed_at=now()`,
      chunk.flat());
    done += chunk.length;
  }
  await pg.end();
  console.log(`✅ UPSERT ${done} proveedores en analytics.contpaqi_suppliers`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
