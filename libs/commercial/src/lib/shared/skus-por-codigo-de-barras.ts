import type { Knex } from 'knex';
import { normalizarCodigoDeBarras, pareceCodigoDeBarras } from '@megadulces/contracts/http/codigo-de-barras';

/**
 * `[BU.4.2]` Todo buscador de producto del servidor encuentra el producto por su CÓDIGO DE BARRAS,
 * no sólo por nombre y SKU. Es la misma búsqueda que el cotizador ya hacía (`[COT.41]`,
 * `catalogo-buscador.ts`), sacada a una pieza para que no la reescriba cada servicio (ADR-056).
 *
 * Dónde: las 7 casillas de código de `kepler_ods.kdii` (ERP_KEPLER §3.y.4) — base `c7`, `c93`, `c102`
 * · unidad dos `c82`, `c95`, `c96` · unidad tres `c85` — más la propia clave `c1`. Igualdad EXACTA, como
 * el checado: quitar ceros a la izquierda confundiría la pieza con el paquete (`006001` vs `06001`).
 *
 * Cuánto cuesta (medido en prod el 2026-11-14, las 9 sucursales, 86,421 filas): el índice GIN
 * `ix_kdii_codigos_verificador` resuelve las seis casillas indexadas en ~2 ms; `c102` no está en el
 * índice y es la única casilla de 630 códigos, así que va en una rama aparte que recorre la tabla
 * (~80 ms). Y sólo corre cuando el término TIENE FORMA de código (`pareceCodigoDeBarras`): un nombre
 * no paga nada.
 *
 * Sin sucursal busca en todas: un código es del producto, no de la sucursal, y las pantallas de la
 * suite (catálogo, costos, existencia) no siempre filtran por una.
 */
export const KDII_CASILLAS_DE_CODIGO = ['c7', 'c93', 'c102', 'c82', 'c95', 'c96', 'c85'] as const;

/**
 * El SQL «la clave está entre las del código»: `= ANY(ARRAY(...))` y no `IN (SELECT ...)`, para que el
 * arreglo se calcule una vez y el filtro baje a la tabla de afuera (en `[COT.41]`, con `IN` la vista
 * de la sucursal se armaba entera: 1.0–1.2 s).
 *
 * Devuelve `null` si el término no parece código: quien lo use no agrega nada.
 */
export function sqlSkuPorCodigoDeBarras(
  columnaSku: string,
  termino: string | null | undefined,
  sucursal?: string | null,
): { sql: string; bindings: string[] } | null {
  if (!pareceCodigoDeBarras(termino)) return null;
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(columnaSku)) {
    throw new Error(`sqlSkuPorCodigoDeBarras: columna inválida «${columnaSku}»`);
  }
  const codigo = normalizarCodigoDeBarras(termino);
  const porSucursal = sucursal ? ' AND btrim(k.sucursal) = ?' : '';
  const sucBind = sucursal ? [String(sucursal).trim()] : [];
  // La etiqueta de caja `C` + clave NO está guardada en ninguna casilla: Kepler la arma al imprimir
  // (medido 2026-11-14: `C00066` no aparece en `kdii`; `kdii-codigo.ts` la reconoce igual). Es la clave.
  const etiquetaCaja = /^C[0-9]{5}$/.test(codigo) ? codigo.slice(1) : null;
  return {
    sql: `btrim(${columnaSku}) = ANY(ARRAY(
      SELECT btrim(k.c1) FROM kepler_ods.kdii k
       WHERE ARRAY[btrim(k.c1), btrim(k.c7), btrim(k.c82), btrim(k.c93), btrim(k.c95), btrim(k.c96), btrim(k.c85)] @> ARRAY[?::text]${porSucursal}
      UNION
      SELECT btrim(k.c1) FROM kepler_ods.kdii k
       WHERE btrim(k.c102) = ?${porSucursal}${etiquetaCaja ? `
      UNION
      SELECT ?::text` : ''}))`,
    bindings: [codigo, ...sucBind, codigo, ...sucBind, ...(etiquetaCaja ? [etiquetaCaja] : [])],
  };
}

/**
 * Suma «o es el producto de este código» a un grupo de búsqueda: úsese DENTRO del mismo `where` que
 * envuelve a `applySmartSearch`, para que quede `(palabras) OR (código)` y no `palabras AND código`.
 *
 * ```ts
 * qb.where((g) => {
 *   applySmartSearch(g, term, { columns: ['p.nombre', 'p.sku'] });
 *   orPorCodigoDeBarras(g, 'p.sku', term);
 * });
 * ```
 */
export function orPorCodigoDeBarras(
  qb: Knex.QueryBuilder,
  columnaSku: string,
  termino: string | null | undefined,
  sucursal?: string | null,
): Knex.QueryBuilder {
  const q = sqlSkuPorCodigoDeBarras(columnaSku, termino, sucursal);
  return q ? qb.orWhereRaw(q.sql, q.bindings) : qb;
}
