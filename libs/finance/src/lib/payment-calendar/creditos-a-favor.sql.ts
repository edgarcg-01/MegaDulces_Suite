/**
 * `[PGP.14]` + `[PGP.141]` **El crédito a favor sin aplicar, por acreedor** (`GET payment-calendar/creditos-a-favor`).
 * Vive aparte del servicio para que el texto que corre en producción sea el MISMO que se mide contra prod.
 *
 * `[PGP.141]` (Edgar, 2026-11-17: *«hay que agregar un texto que diga “este proveedor/factura tiene notas de crédito
 * aplicables”»*) agrega `por_sucursal`: el crédito de cada sucursal SIN anticipos (tienen su propio aviso, `[PGP.139]`)
 * y si en ESA sucursal le debemos (`con_deuda`). Una nota de crédito sólo se aplica contra facturas de su sucursal:
 * el total del acreedor sumaba sucursales donde no hay contra qué aplicarla.
 *
 * Medido en prod el 2026-11-17 (sólo lectura): sin anticipos quedan 162 documentos ($1.4 M), casi todos devoluciones
 * de compra (las notas de crédito Kepler las aplica solo: 5 pendientes, ~$10 mil); aplicables hoy, $0.34 M en 38
 * acreedor·sucursal (más $0.13 M de acreedores `TI…`, que esta regla excluye desde `[PGP.14]`). Control: las columnas
 * de siempre salen idénticas a la consulta anterior (81 de 81, mismo orden).
 * ⚠️ Latencia, 4 corridas en prod: ~550 ms antes, ~605 ms con el desglose (+55 ms). Ya estaba arriba de los 500 ms;
 * corre una vez al abrir el Calendario y en paralelo. Bajarla es deuda aparte (materializar la deuda viva).
 *
 * Parámetros: `[tenant, tenant]`.
 */
export const SQL_CREDITOS_A_FAVOR = `
WITH deuda AS (
  SELECT p.proveedor, p.sucursal
    FROM analytics.v_supplier_payables p
   WHERE p.pendiente > 0 AND p.proveedor NOT LIKE 'TI%' AND p.tenant_id = ?
   GROUP BY 1, 2
), c AS (
  SELECT * FROM analytics.v_supplier_credits c WHERE c.tenant_id = ? AND c.pendiente
), suc AS (
  SELECT x.proveedor, jsonb_agg(jsonb_build_object('sucursal', x.sucursal, 'clases', x.clases, 'a_favor', x.a_favor, 'docs', x.docs, 'con_deuda', x.con_deuda)
                               ORDER BY x.sucursal) AS por_sucursal
    FROM (SELECT c.proveedor, c.sucursal, string_agg(DISTINCT c.clase, ', ' ORDER BY c.clase) AS clases,
                 sum(c.a_favor)::float8 AS a_favor, count(*)::int AS docs, bool_or(d.proveedor IS NOT NULL) AS con_deuda
            FROM c LEFT JOIN deuda d ON d.proveedor = c.proveedor AND d.sucursal = c.sucursal
           WHERE c.clase NOT ILIKE 'anticipo%'
           GROUP BY 1, 2) x
   GROUP BY 1
)
SELECT c.proveedor,
       max(c.proveedor_nombre) AS proveedor_nombre,
       sum(c.a_favor)::float8 AS a_favor,
       count(*)::int AS docs,
       string_agg(DISTINCT c.clase, ', ' ORDER BY c.clase) AS clases,
       to_char(min(c.fecha), 'YYYY-MM-DD') AS mas_vieja,
       bool_or(d.proveedor IS NOT NULL) AS con_deuda_viva,
       coalesce(s.por_sucursal, '[]'::jsonb) AS por_sucursal
  FROM c
  LEFT JOIN (SELECT DISTINCT proveedor FROM deuda) d ON d.proveedor = c.proveedor
  LEFT JOIN suc s ON s.proveedor = c.proveedor
 GROUP BY c.proveedor, s.por_sucursal
 ORDER BY sum(c.a_favor) DESC`;
