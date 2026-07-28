/* eslint-disable no-console */
/**
 * RA-PRO.25 — CADENCIA DE SURTIDO del CEDIS a cada sucursal, desde Wincaja Irapuato.
 *
 * El CEDIS (branch '00') surte a las sucursales con movimientos `tipo='V' caja='99'`
 * (traspaso inter-almacén) en `wincaja.maestro_mov_almacen`; `tercero` = código de la
 * sucursal destino. De ahí sale el VALOR AGREGADO que pidió Edgar: con qué frecuencia
 * surte a cada sucursal, cuánto y cuándo fue el último envío.
 *
 *   cadencia_dias = span / (días_con_envío − 1)      (promedio de gap entre surtidos)
 *   → analytics.cedis_supply_cadence (por almacén destino, ventana del año en curso)
 *
 * Mapeo tercero→warehouse del reorden vía wincaja.branches: COALESCE(kepler_code,
 * warehouse_code) (10→'01', 40→'03', 42→'02', 44→'04', 54→'05', 30/32/50→MD-*).
 * Valor del envío desde detalles_mov_almacen (valor_costo).
 *
 *   node database/importers/wincaja/import-cedis-cadence-wincaja.js            # dry-run
 *   node database/importers/wincaja/import-cedis-cadence-wincaja.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

const M = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const SSL = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST) ? false : { rejectUnauthorized: false };
const CEDIS_BRANCH = process.env.WINCAJA_CEDIS_BRANCH || '00';
const CEDIS_CODE = process.env.CEDIS_WAREHOUSE_CODE || '00';

const NUM = (c) => `COALESCE(NULLIF(regexp_replace(${c}::text,'[^0-9.-]','','g'),'')::numeric,0)`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: SSL });
  await db.connect();
  try {
    console.log(`\n=== RA-PRO.25: cadencia de surtido CEDIS → sucursal (Wincaja, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    await db.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await db.query(`CREATE TABLE IF NOT EXISTS analytics.cedis_supply_cadence (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      warehouse_id uuid NOT NULL,             -- sucursal destino (del reorden)
      source_warehouse_id uuid,               -- CEDIS
      tercero text,                           -- código Wincaja destino (auditoría)
      shipments integer NOT NULL DEFAULT 0,
      days_active integer NOT NULL DEFAULT 0,
      first_shipment date, last_shipment date,
      cadence_days numeric,                   -- promedio de gap entre días de surtido
      avg_shipment_value numeric,             -- $ costo promedio por envío
      window_year integer,
      computed_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_cedis_cadence ON analytics.cedis_supply_cadence (tenant_id, warehouse_id, window_year)`);
    await db.query(`GRANT SELECT ON analytics.cedis_supply_cadence TO app_runtime`);

    const cedis = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [M, CEDIS_CODE])).rows[0];

    // Cadencia por tercero (destino) + valor de envío desde detalles.
    const { rows } = await db.query(`
      WITH ship AS (
        SELECT h.tercero, h.consecutivo, h.tipo, h.documento, h.fecha::date d
          FROM wincaja.maestro_mov_almacen h
         WHERE h.tenant_id=$1 AND h.source_branch=$2 AND h.tipo='V' AND h.caja='99'
           AND coalesce(h.cancelado::text,'0') NOT IN ('1','true','True')
           AND extract(year from h.fecha)=extract(year from current_date)
      ),
      val AS (
        SELECT s.tercero, s.d, sum(${NUM('dt.valor_costo')}) v
          FROM ship s
          JOIN wincaja.detalles_mov_almacen dt
            ON dt.tenant_id=$1 AND dt.source_branch=$2 AND dt.consecutivo=s.consecutivo AND dt.tipo=s.tipo AND dt.documento=s.documento
         GROUP BY s.tercero, s.d
      )
      SELECT s.tercero,
             count(*) shipments,
             count(DISTINCT s.d) days_active,
             min(s.d) first_ship, max(s.d) last_ship,
             round((max(s.d)-min(s.d))::numeric / NULLIF(count(DISTINCT s.d)-1,0), 1) cadence_days,
             round(avg(v.v), 2) avg_val
        FROM ship s LEFT JOIN val v ON v.tercero=s.tercero AND v.d=s.d
       GROUP BY s.tercero ORDER BY shipments DESC`, [M, CEDIS_BRANCH]);

    // Mapa tercero → warehouse del reorden.
    // PREFERIR el código Kepler ('01'-'05') — es el warehouse del reorden con stock/demanda.
    // Los MD-10/40/42/44/54 son duplicados vacíos del crosswalk. 30/32/50 (sin kepler_code) → MD-*.
    const map = new Map();
    const br = (await db.query(`SELECT source_branch, kepler_code, warehouse_code FROM wincaja.branches WHERE tenant_id=$1`, [M])).rows;
    const findWh = async (code) => code ? (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [M, code])).rows[0] : null;
    for (const b of br) {
      const wh = (await findWh(b.kepler_code)) || (await findWh(b.warehouse_code));
      if (wh) map.set(b.source_branch, wh);
    }

    const out = [];
    for (const r of rows) {
      const wh = map.get(r.tercero);
      const label = wh ? wh.code : '??';
      console.log(`  tercero=${String(r.tercero).padEnd(4)} → ${String(label).padEnd(6)} ${String(r.shipments).padStart(4)} envíos · ${String(r.days_active).padStart(3)}d · cadencia≈${String(r.cadence_days ?? '-').padStart(5)}d · $${Number(r.avg_val || 0).toLocaleString()}/envío`);
      if (wh) out.push({ wh, r });
    }
    console.log(`\n  ${out.length}/${rows.length} terceros mapeados a warehouse.`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id='${M}'`);
    await db.query(`DELETE FROM analytics.cedis_supply_cadence WHERE tenant_id=$1 AND window_year=extract(year from current_date)`, [M]);
    for (const { wh, r } of out) {
      await db.query(`INSERT INTO analytics.cedis_supply_cadence
        (tenant_id, warehouse_id, source_warehouse_id, tercero, shipments, days_active, first_shipment, last_shipment, cadence_days, avg_shipment_value, window_year)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, extract(year from current_date))`,
        [M, wh.id, cedis ? cedis.id : null, r.tercero, r.shipments, r.days_active, r.first_ship, r.last_ship, r.cadence_days, r.avg_val]);
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${out.length} filas en analytics.cedis_supply_cadence.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('ERROR:', e.message); process.exitCode = 1;
  } finally { await db.end(); }
})();
