/**
 * EMB.7 — QUÉ LLEVA el embarque: los renglones del U-D-41, en vivo.
 *
 * `erp_shipment_headers` dice quién, cuándo, con qué unidad y a dónde. No dice **qué va
 * arriba del camión**. Eso vive en `kdm2` (36,356 renglones para 1,570 embarques en 30 días)
 * y es lo que contesta "qué pedido lleva" en la pantalla de Embarques.
 *
 * Decode de `kdm2` reusado de la Fase AX (mismo documento, misma tabla de renglones):
 *   c7 = nº de línea · c8 = SKU · c9 = cantidad · c10 = descripción · c11 = unidad
 *   c12 = precio unitario · c13 = importe de línea (c13 = c9 × c12)
 *
 * ── ⚠️ LA TRAMPA DE UNIDAD, y por qué esta vista publica DOS cantidades ───────────────────
 * La pantalla de Kepler y `kdm2` **no dicen lo mismo, y los dos tienen razón**. En el embarque
 * de la captura (06 UD4101-0000713, renglón 1, SKU 70168):
 *
 *     pantalla Kepler :  1 CJA   ×  $1,350.94  =  $1,350.96
 *     kdm2            : 24 PAQ   ×  $   56.29  =  $1,350.96   ← el importe CUADRA
 *
 * Son dos peldaños de la misma escalera: `v_unit_truth` resuelve SKU 70168 con
 * `box_factor 24`, `base_label PAQ`, `box_label CJA` y **veredicto `verificado`** por el
 * método `dinero`. Publicar sólo el crudo haría que un almacenista que compara contra Kepler
 * lea "24" donde su pantalla dice "1" — el error de unidad que ADR-055/057 existe para evitar.
 *
 * Por eso van las dos: `cantidad`/`unidad` como las guarda el ERP, y `cajas`/`caja_label`
 * derivadas del resolvedor canónico, **con su veredicto al lado**. ⛔ `cajas` llega **NULL**
 * cuando el resolvedor no cubre ese SKU en ese almacén: NULL es "no se pudo resolver", que no
 * es lo mismo que cero, y la pantalla tiene que poder decirlo.
 *
 * El importe NO se recalcula: se toma `c13` tal cual. Es el único número que las dos unidades
 * comparten y es el que cuadra contra el total de la cabecera.
 *
 * Vista derive-no-copy sobre `kepler_ods` (sin tabla, sin importer). Dedupe por réplica con
 * `btrim(c1)=btrim(sucursal)`, igual que la cabecera.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const txt = (col) => `NULLIF(btrim(${col}::text),'')`;

const VIEW = `
  CREATE OR REPLACE VIEW analytics.erp_shipment_lines AS
  SELECT
    '${M}'::uuid                                   AS tenant_id,
    l.sucursal,
    l.serie,
    l.folio,
    l.sucursal||'UD41'||lpad(l.serie::text,2,'0')||'-'||l.folio AS folio_digital,
    l.nro_linea,
    l.sku,
    p.id                                           AS product_id,
    COALESCE(p.nombre, l.descripcion)                AS descripcion,
    l.cantidad,
    l.unidad,
    l.precio_unitario,
    l.importe,
    -- Equivalencia en la unidad que el almacén maneja y que Kepler muestra en pantalla.
    CASE WHEN u.box_factor IS NOT NULL AND u.box_factor > 0
         THEN round(l.cantidad / u.box_factor, 2) END          AS cajas,
    u.box_label                                    AS caja_label,
    u.box_factor                                   AS factor_caja,
    -- Procedencia del factor: sin esto, "1 CJA" es una afirmación sin respaldo.
    u.veredicto                                    AS unidad_veredicto,
    u.factor_source                                AS unidad_fuente,
    now()                                          AS computed_at
  FROM (
    SELECT
      btrim(k.c1)            AS sucursal,
      (k.c5)::int            AS serie,
      btrim(k.c6::text)      AS folio,
      (k.c7)::int            AS nro_linea,
      ${txt('k.c8')}         AS sku,
      ${txt('k.c10')}        AS descripcion,
      coalesce(k.c9::numeric, 0) AS cantidad,
      ${txt('k.c11')}        AS unidad,
      ${money('k.c12')}      AS precio_unitario,
      ${money('k.c13')}      AS importe
    FROM kepler_ods.kdm2 k
    WHERE k.c2='U' AND k.c3='D' AND (k.c4)::int=41 AND btrim(k.c1)=btrim(k.sucursal)
      AND ${txt('k.c8')} IS NOT NULL
  ) l
  LEFT JOIN catalog.products p
    ON p.tenant_id='${M}'::uuid AND p.deleted_at IS NULL AND btrim(p.sku)=l.sku
  LEFT JOIN analytics.v_unit_truth u
    ON u.tenant_id='${M}'::uuid AND u.sku = l.sku AND u.warehouse_code = l.sucursal
`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw(`GRANT SELECT ON analytics.erp_shipment_lines TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.erp_shipment_lines IS
    'EMB.7 — Renglones del embarque Kepler U-D-41 EN VIVO (derive-no-copy sobre kepler_ods.kdm2): qué va arriba del camión. Publica DOS cantidades a propósito: la nativa del ERP (ej. 24 PAQ) y su equivalencia en cajas vía analytics.v_unit_truth (1 CJA), que es la que muestra la pantalla de Kepler — el importe c13 cuadra con las dos. cajas NULL = el resolvedor no cubre ese SKU en ese almacén, que no es cero.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_lines');
};
