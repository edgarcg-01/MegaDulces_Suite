/**
 * Fase PV.2 — Dimensión "entidad de venta" (`analytics.v_sales_entity`).
 *
 * El diccionario entidad-Excel ↔ dato: normaliza las entidades del workbook (sucursal,
 * canal, ruta directa RD, vecinal, POS) a la identidad canónica de la BD. Es el eje
 * "columnas" del molde 13×4 (el eje "filas" es PV.1, el calendario).
 *
 * Grano-hoja MEDIDO en el sell-out real (`mv_sellout_monthly`, 23 entidades a hoy):
 *   · mostrador × 6 sucursales   (POS / Punto de Venta)
 *   · credito   × 6 sucursales   (Mayoreo + Telemarketing, mismo canal canónico)
 *   · preventa  × 5 sucursales   (Vecinal)
 *   · ruta      × RUTA-21..28     (RD, ruta directa — grano de ruta)
 * Los rollups del Excel (TOTAL VEC = Σ preventa, RD = Σ ruta, por sucursal, Total Venta)
 * son AGREGACIONES sobre estas hojas (se calculan en PV.4), no se materializan.
 *
 * ⚠️ DECLARADO (medido):
 *   · Las sucursales de HOY (01=P.Hidalgo, 02=La Piedad, 03=8ESQ, 04=Yurécuaro,
 *     05=Zamora, 06=Canindo) NO son las del Excel 2018 (Morelia Abastos/Madero) — por eso
 *     el molde es FORWARD: la estructura del Excel, las entidades vivas de la BD.
 *   · El vecinal (preventa) se presupuesta a grano sucursal×preventa, no por ruta vecinal
 *     individual (el Excel las lista 10.1/30.1/…): el sell-out de hoy no separa la preventa
 *     por ruta vecinal a ese grano. Refinamiento a vendor-level queda declarado, no forzado.
 *
 * Vista derive-no-copy sobre `mv_sellout_monthly` + catálogos (`warehouses`,
 * `commission_route_config`). Sin tenant/RLS propios (dimensión; se filtra por tenant_id
 * en el consumidor, patrón de los MV de analytics). Cero importer.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sales_entity AS
      WITH ent AS (
        SELECT DISTINCT tenant_id, channel, warehouse_code, branch_name
          FROM analytics.mv_sellout_monthly
      )
      SELECT
        e.tenant_id,
        e.channel || ':' || e.warehouse_code            AS entity_key,
        e.channel,
        CASE e.channel
          WHEN 'mostrador' THEN 'Mostrador'
          WHEN 'credito'   THEN 'Mayoreo / Crédito'
          WHEN 'ruta'      THEN 'Ruta directa (RD)'
          WHEN 'preventa'  THEN 'Vecinal / Preventa'
          ELSE initcap(e.channel)
        END                                             AS channel_label,
        CASE WHEN e.channel = 'ruta' THEN 'ruta' ELSE 'sucursal_canal' END AS entity_type,
        e.warehouse_code,
        e.branch_name,
        CASE WHEN e.warehouse_code LIKE 'RUTA-%' THEN substring(e.warehouse_code FROM 6) END AS route_code,
        crc.zona                                        AS route_zona,
        w.zone_id
      FROM ent e
      LEFT JOIN commercial.warehouses w
        ON w.tenant_id = e.tenant_id AND w.code = e.warehouse_code AND w.deleted_at IS NULL
      LEFT JOIN commercial.commission_route_config crc
        ON crc.tenant_id = e.tenant_id
       AND e.warehouse_code LIKE 'RUTA-%'
       AND crc.route_code = substring(e.warehouse_code FROM 6)
       AND crc.deleted_at IS NULL
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_sales_entity TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_sales_entity IS
    'PV.2 — Catálogo canónico de ENTIDADES de venta (sucursal×canal + ruta). entity_key = channel:warehouse_code. Deriva de mv_sellout_monthly (grano-hoja real) + warehouses + commission_route_config (zona de ruta). Eje columnas del molde 13×4; rollups (TOTAL VEC/RD/sucursal/Total) se agregan en PV.4. Cero importer.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sales_entity CASCADE`);
};
