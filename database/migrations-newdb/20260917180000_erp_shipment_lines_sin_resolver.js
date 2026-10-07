/**
 * EMB.7.1 — CORRECCIÓN de rendimiento: el resolvedor de unidad sale de la vista.
 *
 * ── LO QUE MEDÍ DESPUÉS DE PUBLICARLA ────────────────────────────────────────────────────
 * `erp_shipment_lines` unía `analytics.v_unit_truth` para traer la equivalencia en cajas.
 * Pedir **un solo documento** (14 renglones — literalmente lo que hace un clic en la pantalla)
 * costaba **1,189 ms**, y el `EXPLAIN` señala al culpable: el resolvedor no se filtra, se
 * **materializa entero** (11,246 filas) en cada llamada. Medido por separado:
 *
 *     v_unit_truth            un SKU, un almacén →  1,580 ms
 *     v_warehouse_box_factor  un SKU            →    785 ms
 *
 * O sea que el costo **no es de Kepler**: `kdm2` tiene su índice (`ix_kdm2_venta_doc`) y
 * responde. Es el resolvedor, y no mejora por filtrarlo.
 *
 * ── LA DECISIÓN ─────────────────────────────────────────────────────────────────────────
 * La vista se queda con lo barato (los renglones crudos del ERP) y **el servicio resuelve la
 * unidad aparte**, en una segunda consulta que sólo corre cuando alguien expande una parada.
 * El contrato de la API no cambia: sigue devolviendo `cajas`/`caja_label`. Lo que cambia es
 * quién paga el costo y cuándo.
 *
 * ⛔ Lo que NO se hizo, y por qué: usar `catalog.products.factor_sale` habría sido instantáneo,
 * y es justo el atajo que ADR-055 declara refutado — el catálogo discrepa con el ERP en el
 * 73.6% de los casos. Un número rápido y equivocado es peor que uno lento y verificado.
 *
 * ── ⚠️ HALLAZGO ABIERTO: los renglones NO suman el total del documento ───────────────────
 * Medido en 5 embarques de la suc 06:
 *
 *     folio     total cabecera   IEPS     descuento   suma de renglones
 *     0000709      10,315.99      0.00      181.49        10,526.20
 *     0000712       3,245.00      0.00        0.00         3,245.00   ← cuadra, y no tiene descuento
 *     0000713      12,006.29    520.34      230.70        12,250.83
 *
 * `total − suma` no se explica ni con el descuento ni con el IEPS (las diferencias residuales
 * van de 0.11% a 0.28%, no son constantes). Y la captura de Kepler de ese mismo documento
 * declara un **Subtotal de 11,303.32**, que tampoco es ninguno de los dos.
 * **No se inventa una fórmula:** la pantalla muestra el importe POR RENGLÓN (que es el dato
 * del ERP) y el total del DOCUMENTO desde la cabecera, sin presentar la suma como si fuera el
 * total. Decodificar la relación es trabajo aparte — ver [EMB.10] en el tracker.
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
    COALESCE(p.nombre, l.descripcion)              AS descripcion,
    l.cantidad,
    l.unidad,
    l.precio_unitario,
    l.importe,
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
`;

exports.up = async function up(knex) {
  // CREATE OR REPLACE no puede QUITAR columnas → se recrea.
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_lines');
  await knex.raw(VIEW);
  await knex.raw(`GRANT SELECT ON analytics.erp_shipment_lines TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.erp_shipment_lines IS
    'EMB.7 — Renglones del embarque Kepler U-D-41 EN VIVO (derive-no-copy sobre kepler_ods.kdm2): qué va arriba del camión. EMB.7.1: la equivalencia en cajas NO se une acá — v_unit_truth se materializa entero (11,246 filas) y hacía que pedir UN documento costara 1,189 ms; la resuelve el servicio en una segunda consulta, sólo al expandir. ⚠️ La suma de importes NO reproduce el total de la cabecera y la diferencia no se explica con descuento ni IEPS (ver EMB.10): mostrar la suma como total sería inventar.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_lines');
  await require('./20260917170000_analytics_erp_shipment_lines.js').up(knex);
};
