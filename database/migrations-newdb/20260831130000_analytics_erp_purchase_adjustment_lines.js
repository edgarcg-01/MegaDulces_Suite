/**
 * `[RE.22.0]` — **Renglones de los ajustes de compra**, vista viva sobre el ODS.
 *
 * En la revisión de una entrada, la lista de ajustes (devoluciones y notas de crédito) sólo dice
 * doctype, folio, motivo y monto. La pregunta que sigue —*¿qué se devolvió?*— vivía un nivel más
 * abajo, en `kepler_ods.kdm2`, sin nadie que la sirviera.
 *
 * Vista y no tabla, por dos razones: (1) la regla del repo (derive-no-copy: lo derivable del ODS
 * sale del ODS, con frescura de segundos y sin importer que se atore); y (2) el decode de las
 * columnas `cN` se escribe UNA vez acá, en vez de re-decodificarse en cada service — que es
 * justo el anti-patrón que `RA-PRO.45.1` acaba de quitar de las órdenes de compra.
 *
 * **Cobertura medida (no supuesta), 2026-08-31 en la DB local:**
 *   - `X-D-40` devolución de compra: 327 encabezados, y 272 de ellos con 1,271 renglones acá.
 *   - `X-D-55` nota de crédito: 1,256 encabezados / $21.4M y **CERO renglones** en `kdm2`.
 *
 * Esa asimetría no es un hueco de datos: una nota de crédito **no se desglosa por producto**
 * porque no es mercancía, es dinero — sus motivos (`c24`) son "3% PP a 48 hrs", "DESCUENTO DEL
 * 5%", "Complemento de Factura 1111". La vista las incluye igual (devuelve 0 filas para ellas) y
 * quien consuma tiene que **decirlo**, no pintar una lista vacía que se lee como falla.
 *
 * Decode (mismo que `analytics.erp_goods_receipt_lines`): `c7`=nº de línea, `c8`=SKU, `c10`=nombre,
 * `c9`=cantidad, `c11`=unidad, `c12`=costo unitario, `c13`=importe. Enlaza al encabezado por
 * `(sucursal, c1, c2, c3, c4, c6)`.
 *
 * Anti-réplica `btrim(c1) = sucursal`: cada DB de sucursal arrastra réplicas de las otras, así que
 * sin ese filtro el mismo renglón aparece N veces (misma trampa que la vista de recepciones).
 *
 * Costo medido del patrón real (un documento por `sucursal`+`folio`, no `count(*)`): **9–10 ms**.
 * Por eso vista simple y no matview.
 *
 * `analytics.*` no tiene RLS → `tenant_id` se estampa como literal (single-tenant beta, igual que
 * las vistas hermanas) y quien consulte filtra explícito.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // Sin el ODS (entornos que no replican Kepler) no hay de dónde derivar: se omite en silencio,
  // igual que el resto de las vistas derivadas, para no romper el arranque.
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm2') AS t`);
  if (!ods.rows[0]?.t) return;

  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_purchase_adjustment_lines`);
  await knex.raw(`
    CREATE VIEW analytics.erp_purchase_adjustment_lines AS
    SELECT
      '${M}'::uuid                     AS tenant_id,
      aj.sucursal::text                AS sucursal,
      'XD' || btrim(aj.c4::text)       AS doctype,
      btrim(aj.c6::text)               AS folio,
      btrim(l.c7::text)                AS linea,
      NULLIF(btrim(l.c8::text),'')     AS sku,
      NULLIF(btrim(l.c10::text),'')    AS nombre,
      round(coalesce(nullif(regexp_replace(l.c9::text,'[^0-9.-]','','g'),'')::numeric,0),4)  AS cantidad,
      NULLIF(btrim(l.c11::text),'')    AS unidad,
      round(coalesce(nullif(regexp_replace(l.c12::text,'[^0-9.-]','','g'),'')::numeric,0),4) AS costo_unitario,
      round(coalesce(nullif(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS importe,
      now()                            AS computed_at
    FROM kepler_ods.kdm1 aj
    JOIN kepler_ods.kdm2 l
      ON l.sucursal=aj.sucursal AND l.c1=aj.c1 AND l.c2=aj.c2
     AND l.c3=aj.c3 AND l.c4=aj.c4 AND l.c6=aj.c6
    WHERE aj.c2='X' AND aj.c3='D' AND btrim(aj.c4::text) IN ('40','55')
      AND btrim(aj.c1::text)=aj.sucursal::text
  `);

  await knex.raw(`GRANT SELECT ON analytics.erp_purchase_adjustment_lines TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW analytics.erp_purchase_adjustment_lines IS
    'RE.22 — renglones EN VIVO de los ajustes de compra desde kepler_ods.kdm2 (X-D-40 devolucion, '
    'X-D-55 nota de credito), anti-replica c1=sucursal. OJO: las X-D-55 NO tienen renglones en '
    'Kepler (1,256 docs / $21.4M con cero lineas) porque una nota de credito es dinero, no '
    'mercancia — su explicacion vive en el motivo c24. Quien consuma debe declararlo, no pintar '
    'una lista vacia. Costo medido del patron real (1 doc): 9-10 ms.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_purchase_adjustment_lines`);
};
