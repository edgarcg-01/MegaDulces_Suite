#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[GX.68]` Corrige el IMPORTE de los vales de gasto (`finance.expense_proofs`) al que dice
 * Kepler (`analytics.expense_requests.importe` = `kdm1.c16`, el «Monto» de la solicitud XA1501).
 *
 * Por qué hay vales con otro total: `create()` releía la solicitud SÓLO por folio, y con 373
 * folios repetidos entre plazas `.first()` grababa el importe de la solicitud de OTRA tienda.
 * El defecto se cerró en el mismo commit que este guion; esto repara lo que ya quedó grabado.
 *
 * Reglas:
 *  · Llave = (tenant, sucursal, folio). Un vale sin sucursal sólo se casa si su folio es ÚNICO
 *    en Kepler; si vive en varias plazas, se LISTA y no se toca (adivinar es el defecto mismo).
 *  · Sólo se corrige cuando Kepler trae importe > 0 y difiere en ≥ $0.01.
 *  · NO se pierde el valor viejo: queda en `capture_meta.importe_anterior` con quién/cuándo/por qué.
 *  · No toca el `status` ni ninguna otra columna.
 *  · Sin `--apply` es SÓLO LECTURA (la sesión entera en read-only). Con `--apply`, todo en
 *    UNA transacción y con candado optimista (`WHERE importe = <el que se leyó>`).
 *
 * Uso:
 *   PROD_DB_URL=<url> node database/scripts/fix-expense-proof-importe.js [--csv=salida.csv]
 *   PROD_DB_URL=<url> node database/scripts/fix-expense-proof-importe.js --apply --actor=<usuario>
 *   (o --url=<otra base> para desarrollo)
 */
const fs = require('fs');
const { Client } = require('pg');

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const APPLY = process.argv.includes('--apply');
const URL = arg('url') || process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
const ACTOR = arg('actor') || process.env.USERNAME || 'script';
const CSV = arg('csv');
if (!URL) { console.error('Falta PROD_DB_URL (o --url=).'); process.exit(2); }

/** Nombre de cada plaza (tabla de sucursales Kepler md_00..md_08). */
const SUCURSALES = {
  '00': 'CEDIS', '01': 'Padre Hidalgo', '02': 'La Piedad Abastos', '03': '8 Esquinas',
  '04': 'Yurécuaro', '05': 'Zamora Centro', '06': 'Canindo', '07': 'Morelia Madero', '08': 'Morelia Abastos',
};
const plaza = (c) => { const k = String(c ?? '').trim(); return k ? `${k} ${SUCURSALES[k] || '(sin nombre)'}` : '(sin sucursal)'; };
const money = (n) => (n == null ? '' : Number(n).toFixed(2));

(async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  const id = (await c.query(`SELECT current_database() db, inet_server_addr()::text host,
    (SELECT system_identifier::text FROM pg_control_system()) cluster`)).rows[0];
  console.log(`destino: ${id.host} · ${id.db} · clúster ${id.cluster} · ${APPLY ? 'APPLY' : 'sólo lectura'}`);
  if (!APPLY) await c.query('SET default_transaction_read_only = on');

  // Un solo SELECT: el vale, su solicitud por (sucursal, folio), y cuántas plazas comparten el folio.
  const { rows } = await c.query(`
    WITH k AS (
      SELECT tenant_id, sucursal, folio, importe::numeric AS importe,
             count(*) OVER (PARTITION BY tenant_id, folio) AS plazas
        FROM analytics.expense_requests)
    SELECT p.id, p.tenant_id, p.sucursal, p.folio_solicitud AS folio, p.status, p.origen,
           p.importe::numeric AS importe_vale, p.created_by,
           to_char(p.created_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS creado,
           k.sucursal AS sucursal_kepler, k.importe AS importe_kepler, k.plazas,
           (SELECT max(plazas) FROM k k2 WHERE k2.tenant_id = p.tenant_id AND k2.folio = p.folio_solicitud) AS plazas_folio
      FROM finance.expense_proofs p
      LEFT JOIN k ON k.tenant_id = p.tenant_id AND k.folio = p.folio_solicitud
                 AND (k.sucursal = p.sucursal OR (NULLIF(btrim(p.sucursal),'') IS NULL AND k.plazas = 1))
     WHERE p.folio_solicitud IS NOT NULL`);

  const corregir = []; const sinKepler = []; const ambiguos = []; let cuadran = 0;
  for (const r of rows) {
    if (r.importe_kepler == null) {
      (Number(r.plazas_folio) > 1 && !String(r.sucursal || '').trim() ? ambiguos : sinKepler).push(r);
      continue;
    }
    const dif = Math.round((Number(r.importe_kepler) - Number(r.importe_vale)) * 100) / 100;
    if (Math.abs(dif) < 0.01 || !(Number(r.importe_kepler) > 0)) { cuadran++; continue; }
    corregir.push({ ...r, diferencia: dif });
  }

  console.log(`vales con folio: ${rows.length} · cuadran con Kepler: ${cuadran} · a corregir: ${corregir.length}`
    + ` · sin su solicitud en Kepler: ${sinKepler.length} · folio ambiguo sin sucursal: ${ambiguos.length}`);
  console.log(`Δ neto a corregir: $${money(corregir.reduce((s, r) => s + r.diferencia, 0))}`);
  console.table(corregir.map((r) => ({
    sucursal: plaza(r.sucursal_kepler), folio: r.folio, creado: r.creado, status: r.status, origen: r.origen,
    vale: money(r.importe_vale), kepler: money(r.importe_kepler), dif: money(r.diferencia),
    folio_en_plazas: r.plazas_folio,
  })));
  if (sinKepler.length) console.table(sinKepler.map((r) => ({ sucursal: plaza(r.sucursal), folio: r.folio, importe: money(r.importe_vale), motivo: 'no está en Kepler' })));
  if (ambiguos.length) console.table(ambiguos.map((r) => ({ folio: r.folio, importe: money(r.importe_vale), motivo: `folio en ${r.plazas_folio} plazas y el vale no trae sucursal` })));

  if (CSV) {
    for (const r of corregir) r.sucursal_nombre = plaza(r.sucursal_kepler);
    const cols = ['id', 'sucursal_nombre', 'folio', 'creado', 'status', 'origen', 'importe_vale', 'importe_kepler', 'diferencia', 'plazas_folio'];
    const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    fs.writeFileSync(CSV, [cols.join(','), ...corregir.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n'));
    console.log(`CSV: ${CSV}`);
  }

  if (!APPLY) { console.log('\n(sólo lectura — para escribir: --apply --actor=<usuario>)'); await c.end(); return; }

  await c.query('BEGIN');
  try {
    let n = 0;
    for (const r of corregir) {
      const res = await c.query(`
        UPDATE finance.expense_proofs
           SET importe = $2::numeric,
               capture_meta = COALESCE(capture_meta, '{}'::jsonb) || jsonb_build_object(
                 'importe_anterior', $3::numeric, 'importe_corregido_por', $4::text,
                 'importe_corregido_at', now(), 'importe_corregido_motivo', 'GX.68: importe de Kepler (sucursal, folio)'),
               updated_at = now()
         WHERE id = $1 AND importe::numeric = $3::numeric`,
        [r.id, r.importe_kepler, r.importe_vale, ACTOR]);
      if (res.rowCount !== 1) throw new Error(`el vale ${r.id} (${r.folio}) cambió mientras corría — nada se escribió`);
      n++;
    }
    await c.query('COMMIT');
    console.log(`\n✔ corregidos ${n} vales (valor previo en capture_meta.importe_anterior).`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
