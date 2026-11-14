/**
 * `[PGP.124]` **Los anticipos de mercancía con más de 90 días**, como tabla derivada de Kepler para
 * la bandeja «Anticipos sin factura» de «Mi trabajo». Vive aparte para que el texto que corre en
 * producción sea el MISMO que se mide contra prod.
 *
 * Cada fila es un `X-D-60` de un acreedor de mercancía (`C*`) con remanente (`kdxe.c20`, el árbitro
 * de `[PGP.118]`: 64/64) y más de 90 días. `estado` dice de quién es el paso:
 *  · `sin_factura`: el acreedor no tiene ninguna factura abierta en la sucursal del anticipo
 *    (Kepler no lo aplica contra otra sucursal, 115/115). Hay que pedirle la factura o el
 *    reembolso: es trabajo de Compras, y es lo que cuenta la bandeja.
 *  · `con_factura`: sí la tiene; se aplica al pagar esa factura (`[PGP.120]`), no es de esta cola.
 *
 * ⭐ «Tiene factura abierta» se lee del saldo que Kepler guarda en la factura (`kdxe.c20 > 0`), no de
 * `analytics.v_supplier_payables` (~390 ms de piso, y esta cola corre en cada carga de «Mi
 * trabajo»). Arbitrado contra la vista el 2026-11-14: **640 de 640** pares sucursal×acreedor `C*`
 * coinciden (377 con deuda, 263 sin; 0 desacuerdos), y la cola da los mismos 8 documentos
 * ($1,202,551) que la regla de la pantalla. La medición de la bandeja tarda 43–61 ms en prod (con
un `EXISTS` por renglón eran ~600 ms: por eso la pasada única de `con_factura`).
 *
 * `entro` = el día que el anticipo cumplió 90 días. Es aproximado hacia atrás: si ese día el
 * acreedor tenía factura abierta, entró a la cola después (Kepler no guarda cuándo se saldó).
 *
 * Kepler es el ERP de UN tenant: la fila sólo existe para él (como las vistas de `kepler_ods`).
 * Parámetros: `[tenant_id]`.
 */
export const SQL_ANTICIPOS_MAS_DE_90 = `(
  WITH a AS MATERIALIZED (
    SELECT k.sucursal, btrim(k.c2) AS proveedor, btrim(k.c6) AS folio, k.c20::numeric AS a_favor,
           k.c7::date AS fecha, (k.c7::date + 90)::timestamp AS entro
      FROM kepler_ods.kdxe k
     WHERE ?::uuid = '00000000-0000-0000-0000-00000000d01c'::uuid
       AND btrim(k.c1) = k.sucursal AND btrim(k.c3) = 'D' AND k.c4::int = 60
       AND coalesce(k.c20, 0) > 0.005 AND btrim(k.c2) LIKE 'C%'
       AND k.c7::date < current_date - 90
  ), con_factura AS (
    -- Una sola pasada por kdxe para todos los acreedores de arriba (un EXISTS por renglón eran ~600 ms).
    SELECT DISTINCT f.sucursal, btrim(f.c2) AS proveedor
      FROM kepler_ods.kdxe f
     WHERE btrim(f.c1) = f.sucursal AND f.c3 = 'A' AND coalesce(f.c20, 0) > 0.005
       AND btrim(f.c2) IN (SELECT proveedor FROM a)
  )
  SELECT a.*, CASE WHEN cf.proveedor IS NULL THEN 'sin_factura' ELSE 'con_factura' END AS estado
    FROM a LEFT JOIN con_factura cf ON cf.sucursal = a.sucursal AND cf.proveedor = a.proveedor
) AS anticipos`;
