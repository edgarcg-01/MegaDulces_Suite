/**
 * `[PGP.120]` **El anticipo aplicado desde el Calendario de pagos**: cuánto de cada `X-D-60` ya está
 * apartado en pagos pendientes, y la verificación de UN renglón «Anticipo» contra Kepler.
 *
 * Vive aparte del servicio para que el texto que corre en producción sea el MISMO que se mide contra
 * prod (los scripts lo leen de este archivo; no se copia).
 *
 * ⭐ **Lo apartado** de un anticipo = la suma de sus renglones «Anticipo» en pagos NO cancelados
 * (pendientes y ya pagados), MENOS lo
 * que Kepler ya aplicó de ese anticipo a esas mismas facturas (`kdxf`, abono `X-D-60` → cargo). Así,
 * cuando Cuentas por pagar lo aplica en Kepler, el remanente de Kepler (`a_favor` = `kdxe.c20`) baja y
 * lo apartado baja lo mismo: el disponible (`a_favor − apartado`) no se cuenta dos veces.
 * Si CxP lo aplica a OTRA factura, lo apartado no baja y el disponible queda corto: el error es
 * conservador (nunca deja aplicar dos veces el mismo peso).
 *
 * ⛔ La llave de la factura es la de `kepler-payable-key.contract.ts`
 *    (`md5('kepler_payable|'||sucursal||'|'||tipo||'|'||subtipo||'|'||btrim(folio))::uuid`), armada aquí
 *    del lado CARGO de `kdxf` (`c7`, `c8`, `c9`). Si esa llave cambia, cambia aquí también.
 * ⛔ Un anticipo sólo se aplica contra una factura de SU sucursal: Kepler aplica abono y cargo en la
 *    misma base (115 de 115 aplicaciones de `X-D-60` en 12 meses, prod 2026-11-13).
 */

/** Los renglones «Anticipo» de pagos pendientes y lo que Kepler ya aplicó de esos anticipos a esas facturas. */
function cteApartado(excluirItem: boolean): string {
  return `res AS (
  SELECT l->'anticipo'->>'sucursal' AS suc, l->'anticipo'->>'folio' AS folio, i.id AS item_id, i.obligation_id,
         sum((l->>'amount')::numeric) AS monto
    FROM finance.payment_allocation_items i
    -- ⛔ Todo lo que no esté cancelado: un pago ya marcado «Pagado» (executed) sigue apartando su
    -- anticipo hasta que Kepler lo aplique (kdxf); si dejara de contar, el anticipo quedaría libre dos veces.
    JOIN finance.payment_allocations a ON a.id = i.allocation_id AND a.status <> 'cancelled'
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.discount_lines) = 'array' THEN i.discount_lines ELSE '[]'::jsonb END) l
   WHERE i.tenant_id = ?${excluirItem ? ' AND i.id <> ?::uuid' : ''} AND l->>'reason' = 'anticipo'
   GROUP BY 1, 2, 3, 4
), apl AS (
  SELECT x.sucursal AS suc, btrim(x.c6) AS folio,
         md5('kepler_payable|'||x.sucursal||'|'||x.c7||'|'||x.c8||'|'||btrim(x.c9))::uuid AS obligation_id,
         sum(x.c10) AS aplicado
    FROM kepler_ods.kdxf x
    JOIN (SELECT DISTINCT suc, folio FROM res) r ON r.suc = x.sucursal AND r.folio = btrim(x.c6)
   WHERE btrim(x.c1) = x.sucursal AND x.c4::int = 60
   GROUP BY 1, 2, 3
)`;
}

/**
 * La lista del submódulo de Anticipos con lo apartado de cada uno. Parámetros: `[tenant_id, tenant_id]`.
 */
export const SQL_ANTICIPOS_CON_APARTADO = `WITH ${cteApartado(false)}, ap AS (
  SELECT res.suc, res.folio, sum(greatest(res.monto - coalesce(apl.aplicado, 0), 0)) AS apartado
    FROM res
    LEFT JOIN apl ON apl.suc = res.suc AND apl.folio = res.folio AND apl.obligation_id = res.obligation_id
   GROUP BY 1, 2
)
SELECT c.sucursal, c.proveedor, c.proveedor_nombre, c.folio, c.referencia,
       to_char(c.fecha, 'YYYY-MM-DD') AS fecha,
       (current_date - c.fecha)::int AS dias,
       c.importe::float8 AS importe, c.aplicado::float8 AS aplicado,
       c.a_favor::float8 AS a_favor,
       coalesce(ap.apartado, 0)::float8 AS apartado
  FROM analytics.v_supplier_credits c
  LEFT JOIN ap ON ap.suc = c.sucursal AND ap.folio = c.folio
 WHERE c.tenant_id = ? AND c.doc_tipo::int = 60 AND c.pendiente
 ORDER BY c.a_favor DESC
 LIMIT 1000`;

/**
 * La verificación de UN renglón «Anticipo» sobre UNA factura del pago.
 * Parámetros: `[tenant_id, item_id, sucursal, obligation_id, tenant_id, sucursal, folio, sucursal, folio]`.
 * - `fac_n` = 1 si la factura es de Kepler y de la MISMA sucursal del anticipo (0 si no).
 * - `ant_n` = cuántos `X-D-60` hay con esa sucursal y folio (0 = no existe; >1 = ambiguo).
 * - `apartado` = lo apartado del anticipo en OTROS renglones de pagos no cancelados.
 */
export const SQL_ANTICIPO_PARA_FACTURA = `WITH ${cteApartado(true)}, fac AS (
  SELECT btrim(k.c2) AS acreedor
    FROM kepler_ods.kdxe k
   WHERE k.sucursal = ? AND btrim(k.c1) = k.sucursal AND k.c3 = 'A'
     AND md5('kepler_payable|'||k.sucursal||'|'||k.c4||'|'||k.c5||'|'||btrim(k.c6))::uuid = ?::uuid
), ant AS (
  SELECT btrim(c.proveedor) AS proveedor, c.a_favor
    FROM analytics.v_supplier_credits c
   WHERE c.tenant_id = ? AND c.doc_tipo::int = 60 AND c.sucursal = ? AND c.folio = ?
)
SELECT (SELECT count(*) FROM fac)::int AS fac_n, (SELECT min(acreedor) FROM fac) AS fac_acreedor,
       (SELECT count(*) FROM ant)::int AS ant_n, (SELECT min(proveedor) FROM ant) AS ant_proveedor,
       (SELECT sum(a_favor) FROM ant)::float8 AS a_favor,
       coalesce((SELECT sum(greatest(res.monto - coalesce(apl.aplicado, 0), 0))
                   FROM res
                   LEFT JOIN apl ON apl.suc = res.suc AND apl.folio = res.folio AND apl.obligation_id = res.obligation_id
                  WHERE res.suc = ? AND res.folio = ?), 0)::float8 AS apartado`;

/** Una fila de {@link SQL_ANTICIPO_PARA_FACTURA}. */
export interface FilaAnticipoParaFactura {
  fac_n: number;
  fac_acreedor: string | null;
  ant_n: number;
  ant_proveedor: string | null;
  a_favor: number | null;
  apartado: number;
}
