/**
 * `[PGP.12]` **La REFERENCIA del proveedor viaja con la deuda.**
 *
 * Pedido de Edgar el 2026-10-26, mirando `/finanzas/calendario-pagos`: *«agreguemos al buscador o
 * a la columna el folio interno o referencia»*. La pantalla hermana `/compras/obligaciones` ya
 * publica tres columnas —**Referencia** (`0-F-2525`), **Folio Kepler** (`0010064`) y **OC**— y la
 * de Pagos sólo mostraba el folio pelado.
 *
 * ── Qué se agrega, y con qué se verificó ────────────────────────────────────────────────────
 *
 * `referencia` = `btrim(kdxe.c16)`. ⛔ La columna **no se adivinó**: se cruzó contra un hecho
 * independiente —las 38 obligaciones que Compras capturó a mano, que traen SU `invoice_folio` **y**
 * la llave completa del documento de Kepler— y el resultado fue **38 de 38 exactas**, con
 * **control placebo de 0 de 38** contra documentos ajenos al azar. O sea: `c16` es el mismo campo
 * que la pantalla de Compras llama «Referencia».
 *
 * ⚠️ **Pero es captura LIBRE, y por eso el rótulo dice «Referencia» y no «Factura del proveedor».**
 * Medido sobre los 2,897 documentos que la pantalla de Pagos muestra hoy:
 *
 * | | |
 * |---|---|
 * | con algo escrito | **2,684 (92.6 %)**, 2,130 valores distintos |
 * | con forma de factura (`0-F-2525`, `30-1402`, `F-62435`) | la mayoría |
 * | con texto libre que **no** es una factura | `GNF-Z2` (509), `LPA` (333), `DAMASO` (298), `M.A.` (240), `S/R` (175), `jmea` (131), `YURECUARO` (119) |
 * | vacías | 213 (7.4 %) |
 *
 * Llamarla «Factura» sería un rótulo que nombra una cosa y muestra otra en 2,705 documentos.
 *
 * ── Por qué en la VISTA y no con un join en el servicio ─────────────────────────────────────
 *
 * `listObligations` tiene un presupuesto de 500 ms y hoy corre en 325–377 ms con `LIMIT`. Meterle
 * un join a `kdxe` sin medirlo arriesga el presupuesto, y además la referencia **es un atributo
 * del documento**: su lugar es donde ya viven folio, fecha y vencimiento. Mismo criterio que
 * `20261007300000`, que publicó `referencia` en la vista de órdenes de entrada.
 *
 * ⛔ **Aditiva y sin pérdida**: la vista conserva sus 16 columnas con la misma definición —se
 * reproduce textual la de prod— y suma la 17ª. Ningún consumidor cambia.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_payables AS
    WITH doc AS MATERIALIZED (
      SELECT kdxe.sucursal,
             btrim(kdxe.c2) AS proveedor,
             kdxe.c4 AS doc_tipo,
             kdxe.c5 AS doc_sub,
             btrim(kdxe.c6) AS folio,
             -- [PGP.12] la referencia del proveedor, tal como se capturó en el ERP
             nullif(btrim(kdxe.c16), '') AS referencia,
             CASE WHEN kdxe.c7 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c7::date ELSE NULL::date END AS fecha,
             CASE WHEN kdxe.c10 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c10::date ELSE NULL::date END AS vencimiento,
             kdxe.c11 AS importe
        FROM kepler_ods.kdxe
       WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A'::text
    ), apl AS MATERIALIZED (
      SELECT kdxf.sucursal, kdxf.c7 AS t, kdxf.c8 AS s, btrim(kdxf.c9) AS f, sum(kdxf.c10) AS aplicado
        FROM kepler_ods.kdxf
       WHERE btrim(kdxf.c1) = kdxf.sucursal
       GROUP BY kdxf.sucursal, kdxf.c7, kdxf.c8, (btrim(kdxf.c9))
    ), prov AS MATERIALIZED (
      SELECT DISTINCT ON ((btrim(kdxd.c2))) btrim(kdxd.c2) AS ck, kdxd.c3 AS nombre, kdxd.c13 AS grupo
        FROM kepler_ods.kdxd
       ORDER BY (btrim(kdxd.c2)), (kdxd.sucursal <> '00'::text), kdxd.sucursal
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           d.sucursal, d.proveedor, p.nombre AS proveedor_nombre, p.grupo,
           d.doc_tipo, d.doc_sub, d.folio, d.fecha, d.vencimiento, d.importe,
           COALESCE(a.aplicado, 0::numeric) AS aplicado,
           d.importe - COALESCE(a.aplicado, 0::numeric) AS pendiente,
           CASE WHEN d.vencimiento IS NULL THEN NULL::boolean ELSE d.vencimiento < CURRENT_DATE END AS vencido,
           CASE WHEN d.vencimiento IS NULL THEN NULL::integer ELSE CURRENT_DATE - d.vencimiento END AS dias_vencido,
           CASE WHEN d.fecha IS NULL THEN NULL::boolean ELSE d.fecha < '2026-10-01'::date END AS anterior_al_corte,
           d.referencia
      FROM doc d
      LEFT JOIN apl a ON a.sucursal = d.sucursal AND a.t = d.doc_tipo AND a.s = d.doc_sub AND a.f = d.folio
      LEFT JOIN prov p ON p.ck = d.proveedor
     WHERE (d.importe - COALESCE(a.aplicado, 0::numeric)) > 0.005;
  `);
};

/**
 * Vuelve a la vista de 16 columnas. ⚠️ No es un `DROP`: se reemplaza por la definición anterior,
 * palabra por palabra, para que un `down` no se lleve puesta la deuda viva de nadie.
 */
exports.down = async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_payables AS
    WITH doc AS MATERIALIZED (
      SELECT kdxe.sucursal, btrim(kdxe.c2) AS proveedor, kdxe.c4 AS doc_tipo, kdxe.c5 AS doc_sub,
             btrim(kdxe.c6) AS folio,
             CASE WHEN kdxe.c7 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c7::date ELSE NULL::date END AS fecha,
             CASE WHEN kdxe.c10 >= '1900-01-01 00:00:00'::timestamp without time zone
                  THEN kdxe.c10::date ELSE NULL::date END AS vencimiento,
             kdxe.c11 AS importe
        FROM kepler_ods.kdxe
       WHERE btrim(kdxe.c1) = kdxe.sucursal AND kdxe.c3 = 'A'::text
    ), apl AS MATERIALIZED (
      SELECT kdxf.sucursal, kdxf.c7 AS t, kdxf.c8 AS s, btrim(kdxf.c9) AS f, sum(kdxf.c10) AS aplicado
        FROM kepler_ods.kdxf
       WHERE btrim(kdxf.c1) = kdxf.sucursal
       GROUP BY kdxf.sucursal, kdxf.c7, kdxf.c8, (btrim(kdxf.c9))
    ), prov AS MATERIALIZED (
      SELECT DISTINCT ON ((btrim(kdxd.c2))) btrim(kdxd.c2) AS ck, kdxd.c3 AS nombre, kdxd.c13 AS grupo
        FROM kepler_ods.kdxd
       ORDER BY (btrim(kdxd.c2)), (kdxd.sucursal <> '00'::text), kdxd.sucursal
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           d.sucursal, d.proveedor, p.nombre AS proveedor_nombre, p.grupo,
           d.doc_tipo, d.doc_sub, d.folio, d.fecha, d.vencimiento, d.importe,
           COALESCE(a.aplicado, 0::numeric) AS aplicado,
           d.importe - COALESCE(a.aplicado, 0::numeric) AS pendiente,
           CASE WHEN d.vencimiento IS NULL THEN NULL::boolean ELSE d.vencimiento < CURRENT_DATE END AS vencido,
           CASE WHEN d.vencimiento IS NULL THEN NULL::integer ELSE CURRENT_DATE - d.vencimiento END AS dias_vencido,
           CASE WHEN d.fecha IS NULL THEN NULL::boolean ELSE d.fecha < '2026-10-01'::date END AS anterior_al_corte
      FROM doc d
      LEFT JOIN apl a ON a.sucursal = d.sucursal AND a.t = d.doc_tipo AND a.s = d.doc_sub AND a.f = d.folio
      LEFT JOIN prov p ON p.ck = d.proveedor
     WHERE (d.importe - COALESCE(a.aplicado, 0::numeric)) > 0.005;
  `);
};
