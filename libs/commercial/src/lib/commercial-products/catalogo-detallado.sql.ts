/**
 * Compras › Catálogo › Detallado: las consultas propias, en un archivo sin más dependencia que otro `.sql.ts`
 * (`catalogo-ficha.sql.ts`, de donde sale la definición única de entrada XA20). Parámetros con `?`.
 * ⚠️ Nada de `?` dentro de expresiones regulares: knex lo toma como binding.
 *
 * Lo demás NO se reescribe: la venta del mes usa `RESUMEN_HISTORIA_SQL` + `VENTA_VIVO_SQL` del motor PF, y la
 * lista usa el buscador y los laterales de Sencillo (`catalogo-ficha.sql.ts`).
 */

import { ENTRADAS_XA20 } from './catalogo-ficha.sql';

const N = (c: string) => `nullif(regexp_replace(${c}::text, '[^0-9.-]', '', 'g'), '')::numeric`;

/**
 * «Sin proveedor asignado» en un renglón del catálogo (requiere `p` = catalog.products y `s` = su proveedor
 * unido con LEFT JOIN). La regla es la de `PRODUCTOS_SIN_PROVEEDOR_SQL` (product-flow.sql.ts): sin proveedor,
 * o con el proveedor comodín «PRODUCTOS SIN PROVEEDOR ASIGNADO». Un `supplier_id` que ya no existe también
 * cuenta (la lista lo pinta como «Sin proveedor»).
 */
export const SIN_PROVEEDOR_EXPR = `(s.id IS NULL OR s.name ILIKE 'PRODUCTOS SIN PROVEEDOR%')`;

/** Los productos activos con SKU y su SKU (la venta del mes de todo el catálogo). Sin parámetros. */
export const ACTIVOS_CON_SKU_SQL = `
  SELECT p.id::text AS id, btrim(p.sku) AS sku
    FROM catalog.products p
   WHERE p.tenant_id = public.current_tenant_id() AND p.deleted_at IS NULL AND p.activo AND p.sku IS NOT NULL`;

/**
 * Las entradas que cuentan (XA20). `[PF.12.3]` Ya no es una copia: es la MISMA definición que la última entrada
 * (`ENTRADAS_XA20` de catalogo-ficha.sql.ts), con el mismo texto que tenía aquí.
 */
const ENTRADAS_DE = ENTRADAS_XA20('btrim(l.c8) = ?');

/**
 * Las compras de UN SKU desde una fecha: por unidad capturada, lo comprado y la primera fecha; y en cada
 * renglón el número de documentos DISTINTOS de la ventana. Parámetros: sku, desde.
 */
export const COMPRAS_VENTANA_SQL = `
  WITH e AS (
    SELECT ap.sucursal, ap.c1, ap.c6, ap.c68::date AS fecha,
           upper(btrim(l.c11::text)) AS unidad, ${N('l.c9')} AS cantidad
    ${ENTRADAS_DE}
       AND ap.c68::date BETWEEN ?::date AND ?::date
  )
  SELECT e.unidad, sum(e.cantidad) AS cantidad, to_char(min(e.fecha), 'YYYY-MM-DD') AS primera,
         (SELECT count(DISTINCT (d.sucursal, d.c1, d.c6)) FROM e d) AS docs
    FROM e
   GROUP BY e.unidad`;
