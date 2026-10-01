/* eslint-disable */
/**
 * `[IC.CEDIS.9]` — **Se RETIRA el CEDIS de la existencia publicada, porque Kepler lo contradice.**
 * Revierte `20261001130000` (batch 647) el mismo día.
 *
 * ── LA EVIDENCIA QUE LO TUMBA, y la trajo un humano ────────────────────────────────────────────
 * Edgar sacó del propio ERP el *"Reporte de existencia por productos"* (01/10/2026 09:38) con
 * filtros `Sucursal = CEDIS`, `Almacén = ALMACÉN Cedis`, `Línea 036`. **Las ~140 filas dan 0.00 en
 * las tres unidades.** Contra lo que esta plataforma publicaba, SKU por SKU:
 *
 *     SKU    descripción                      publicado   Kepler
 *     65000  PELON PELONAZO 4P                    3,288     0.00
 *     65001  PELON PELO RICO TAM EXH 10P         24,192     0.00
 *     65002  PELON PELO RICO TAM BLS 12+2        21,600     0.00
 *     95757  HERSHEYS CHISPAS SEMI-AMARGO 2.5KG      36     0.00
 *
 * ⛔ **Y no se puede culpar al entorno.** Se verificó una por una: la rama `00` replica
 * **192.168.9.95 / md_00**, que es la máquina que el CEDIS usa hoy; la sucursal tiene **un solo
 * almacén** (`c1='00'`, 126,475 documentos); y la réplica está **fresca** (8 documentos de hoy).
 * Misma máquina, mismo almacén, dato al día — y dos fuentes del MISMO Kepler no coinciden.
 *
 * ── POR QUÉ NO ES "UN BUG DEL CEDIS" ───────────────────────────────────────────────────────────
 * La reconstrucción desde documentos DA LA RAZÓN a nuestra fórmula: para el `65000`, `X-A-20`
 * (aplica orden de entrada) suma **3,384** y `U-D-40` (embarque) **96** → 3,288, que es exactamente
 * `c4+c8-c9`. O sea que `c8`/`c9` son los acumulados que la doc describe y la aritmética está bien.
 * **Lo que no sabemos es qué publica el reporte de Kepler**, y hasta saberlo la cifra está en
 * disputa. ⚠️ `v_erp_stock_on_hand` usa esta MISMA fórmula para las nueve sucursales: si está mal,
 * está mal en todas, y esto deja de ser un tema del CEDIS.
 *
 * ── POR QUÉ RETIRAR Y NO DEJARLO ───────────────────────────────────────────────────────────────
 * Ayer el argumento para publicarlo fue que el volumen está repartido entre miles de SKUs y por eso
 * «es un almacén, no un artefacto». **Ese argumento queda refutado**: estar repartido no lo hace
 * real, y el ERP dice cero. Publicar 12,180,456 u / $298M que el propio Kepler desmiente —y que
 * esta noche el nocturno hornearía en `inventory_health` → ABC → `reorder_policy` → el **sugerido
 * de compras**— es dibujar un número que sabemos contestado. ADR-056: lo que no se puede medir se
 * DECLARA, no se dibuja.
 *
 * ⚠️ **Esto reabre el reporte original** (*"/compras/existencia no muestra el CEDIS"*), y se asume
 * a conciencia: **ausente y declarado le gana a presente y falso**, sobre todo cuando alimenta
 * decisiones de compra. Lo que lo destraba es una sola evidencia que sólo se saca del ERP: el mismo
 * reporte **sin el filtro de línea** y con *omitir productos en cero = Sí*. Eso contesta "qué tiene
 * de verdad el CEDIS" y, corrido por sucursal, se vuelve el árbitro independiente de existencia que
 * a este proyecto le falta para las NUEVE ramas (ver `VERDAD_ABSOLUTA.md` §17.7).
 *
 * ⚠️ `security_invoker` y los GRANT se re-aplican: `CREATE OR REPLACE VIEW` no los hereda.
 */
const SQL = `
CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand AS
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(k.c4 + k.c8 - k.c9), 0::double precision)::numeric AS qty_stock_units,
    GREATEST(COALESCE(max(bfx.box_factor), 1::numeric), 1::numeric) AS display_box_factor,
    'kepler'::text AS unit_source,
    'kepler_ods'::text AS source
   FROM kepler_ods.kdil k
     JOIN commercial.warehouses w
       ON w.kepler_code = k.sucursal
      -- ⛔ EN DISPUTA (IC.CEDIS.9, 2026-10-01): el reporte de existencia del propio Kepler da 0.00
      -- donde esta vista publicaba miles. NO es la exclusión vieja «la 00 es OFICINAS» —esa premisa
      -- se midió y es falsa, la 00 mueve mercancía todos los meses—; es que la cifra está
      -- contestada por el ERP y alimenta el sugerido de compras. Se retira hasta arbitrarla.
      AND w.kepler_code <> '00'::text
      AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE k.sucursal = k.c1
    AND (btrim(k.c3) <> ALL (ARRAY['00001'::text, '00002'::text, '00022'::text]))
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
UNION ALL
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(v.existencia), 0::numeric) AS qty_stock_units,
    GREATEST(COALESCE(max(CASE WHEN a.factor_venta > 1::numeric THEN a.factor_venta
                               ELSE NULL::numeric END), max(bfx.box_factor), 1::numeric),
             1::numeric) AS display_box_factor,
    CASE WHEN max(CASE WHEN a.factor_venta > 1::numeric THEN 1 ELSE 0 END) = 1
         THEN 'wincaja_multipack'::text ELSE 'wincaja'::text END AS unit_source,
    'wincaja'::text AS source
   FROM wincaja.v_stock v
     JOIN commercial.warehouses w
       ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch
      AND w.kepler_code IS NULL AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = v.tenant_id AND pr.sku::text = v.sku AND pr.deleted_at IS NULL
     LEFT JOIN wincaja.articulos a
       ON a.tenant_id = v.tenant_id AND a.articulo = v.sku
      AND a.source_branch = v.source_branch AND a.source_dataset = 'actual'::text
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE v.existencia IS NOT NULL AND v.warehouse_code NOT LIKE 'RUTA-%'
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_on_hand SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO dev_ro`);
};

exports.down = async function down(knex) {
  await knex.raw(SQL.replace(`      AND w.kepler_code <> '00'::text\n`, ''));
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_on_hand SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO dev_ro`);
};
