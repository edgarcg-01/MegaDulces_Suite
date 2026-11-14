import type { Knex } from 'knex';
import { applySmartSearch, type SmartSearchOptions } from '../search/smart-search';
import { normalizarCodigoDeBarras, pareceCodigoDeBarras } from '@megadulces/contracts/http/codigo-de-barras';

/**
 * `[BU.4.2]` Todo buscador de producto del servidor encuentra el producto por su CÓDIGO DE BARRAS,
 * no sólo por nombre y SKU. Es la misma búsqueda que el cotizador ya hacía (`[COT.41]`,
 * `libs/commercial/src/lib/shared/catalogo-buscador.ts`), sacada a una pieza para que no la reescriba
 * cada servicio (ADR-056). Vive en `platform-core` porque la usan `commercial`, `trade`, `finance` y
 * `reconciliation`, y ninguna de ellas depende de las otras.
 *
 * Dónde: las 7 casillas de código de `kepler_ods.kdii` (ERP_KEPLER §3.y.4) — base `c7`, `c93`, `c102`
 * · unidad dos `c82`, `c95`, `c96` · unidad tres `c85` — más la propia clave `c1`. Igualdad EXACTA, como
 * el checado: quitar ceros a la izquierda confundiría la pieza con el paquete (`006001` vs `06001`).
 *
 * Cuánto cuesta (medido en prod el 2026-11-14, las 9 sucursales, 86,421 filas): el índice GIN
 * `ix_kdii_codigos_verificador` resuelve las seis casillas indexadas en ~2 ms; `c102` no está en el
 * índice y es la única casilla de 630 códigos, así que va en una rama aparte que recorre la tabla
 * (~75 ms; ~20 ms con una sucursal). Y sólo corre cuando el término TIENE FORMA de código
 * (`pareceCodigoDeBarras`): un nombre no paga nada.
 *
 * Sin sucursal busca en todas: un código es del producto, no de la sucursal. ⚠️ Pasar sucursal SÓLO
 * si es la clave de Kepler (`kdii.sucursal`, «01»…): con otro formato el filtro vacía el resultado.
 */
export const KDII_CASILLAS_DE_CODIGO = ['c7', 'c93', 'c102', 'c82', 'c95', 'c96', 'c85'] as const;

/** La consulta de las CLAVES de un código (una columna `sku`), o `null` si no parece código. */
export function sqlClavesDeCodigoDeBarras(
  termino: string | null | undefined,
  sucursal?: string | null,
): { sql: string; bindings: string[] } | null {
  if (!pareceCodigoDeBarras(termino)) return null;
  const codigo = normalizarCodigoDeBarras(termino);
  const porSucursal = sucursal ? ' AND btrim(k.sucursal) = ?' : '';
  const sucBind = sucursal ? [String(sucursal).trim()] : [];
  // La etiqueta de caja `C` + clave NO está guardada en ninguna casilla: Kepler la arma al imprimir
  // (medido 2026-11-14: `C00066` no aparece en `kdii`; `kdii-codigo.ts` la reconoce igual). Es la clave.
  const etiquetaCaja = /^C[0-9]{5}$/.test(codigo) ? codigo.slice(1) : null;
  const ramaCaja = etiquetaCaja ? '\n      UNION\n      SELECT ?::text' : '';
  return {
    sql: `SELECT btrim(k.c1) AS sku FROM kepler_ods.kdii k
       WHERE ARRAY[btrim(k.c1), btrim(k.c7), btrim(k.c82), btrim(k.c93), btrim(k.c95), btrim(k.c96), btrim(k.c85)] @> ARRAY[?::text]${porSucursal}
      UNION
      SELECT btrim(k.c1) FROM kepler_ods.kdii k
       WHERE btrim(k.c102) = ?${porSucursal}${ramaCaja}`,
    bindings: [codigo, ...sucBind, codigo, ...sucBind, ...(etiquetaCaja ? [etiquetaCaja] : [])],
  };
}

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
  const claves = sqlClavesDeCodigoDeBarras(termino, sucursal);
  if (!claves) return null;
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(columnaSku)) {
    throw new Error(`sqlSkuPorCodigoDeBarras: columna inválida «${columnaSku}»`);
  }
  return { sql: `btrim(${columnaSku}) = ANY(ARRAY(${claves.sql}))`, bindings: claves.bindings };
}

/**
 * Suma «o es el producto de este código» a un grupo de búsqueda: úsese DENTRO del mismo `where` que
 * agrupa la búsqueda por texto, para que quede `(texto) OR (código)` y no `texto AND código`.
 *
 * ```ts
 * qb.where((g) => {
 *   g.where('p.nombre', 'ilike', t).orWhere('p.sku', 'ilike', t);
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

/**
 * `applySmartSearch` de un buscador de PRODUCTO, más el código de barras: queda
 * `(palabras en las columnas) OR (la clave es de este código)`. Para los servicios que llamaban
 * `applySmartSearch(qb, term, …)` directo (que agrega su grupo con AND): se cambia esa línea por ésta.
 * Sin término no agrega nada; con un nombre queda IGUAL que `applySmartSearch` (no se arma el grupo).
 */
export function applySmartSearchConCodigo(
  qb: Knex.QueryBuilder,
  termino: string | null | undefined,
  opciones: SmartSearchOptions,
  columnaSku: string,
  sucursal?: string | null,
): Knex.QueryBuilder {
  if (!String(termino ?? '').trim()) return qb;
  if (!pareceCodigoDeBarras(termino)) {
    applySmartSearch(qb, termino, opciones);
    return qb;
  }
  return qb.andWhere((g) => {
    applySmartSearch(g, termino, opciones);
    orPorCodigoDeBarras(g, columnaSku, termino, sucursal);
  });
}

/**
 * La misma condición para consultas de SQL crudo con bindings NOMBRADOS (`:s`), donde no se pueden
 * mezclar `?` posicionales. Los nombres llevan el prefijo dado para no chocar con los de la consulta.
 * `null` si el término no parece código. Sin sucursal (todas): un código es del producto.
 */
export function sqlSkuPorCodigoDeBarrasNombrado(
  columnaSku: string,
  termino: string | null | undefined,
  prefijo = 'bu4',
): { sql: string; binds: Record<string, string> } | null {
  const q = sqlSkuPorCodigoDeBarras(columnaSku, termino);
  if (!q) return null;
  let i = 0;
  const binds: Record<string, string> = {};
  const sql = q.sql.replace(/\?/g, () => {
    const nombre = `${prefijo}_${i}`;
    binds[nombre] = q.bindings[i++];
    return `:${nombre}`;
  });
  return { sql, binds };
}

/**
 * Las claves de un código, ya resueltas, para los buscadores que arman su lista de SKUs antes de
 * consultar o que filtran en memoria. `[]` si el término no parece código o no es de nadie.
 */
export async function skusDeCodigoDeBarras(
  knex: Knex | Knex.Transaction,
  termino: string | null | undefined,
  sucursal?: string | null,
): Promise<string[]> {
  const q = sqlClavesDeCodigoDeBarras(termino, sucursal);
  if (!q) return [];
  const r = await knex.raw(`SELECT DISTINCT sku FROM (${q.sql}) AS t`, q.bindings);
  return (r.rows as Array<{ sku: string | null }>).map((x) => String(x.sku ?? '').trim()).filter(Boolean);
}
