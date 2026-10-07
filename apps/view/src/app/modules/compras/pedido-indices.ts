/**
 * `[RA-PERF.7]` **Índices por producto del desglose de `/compras/pedido`.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * El template llama `trasRows(pid)` ×4 y `prodTr(pid)` ×3 **por cada fila abierta**, y las dos
 * colgaban de un `detailRows(pid)` que filtraba y ordenaba `urows()` COMPLETO en cada invocación.
 * Con `urows` de hasta 3,000 renglones (3 endpoints × `pageSize: 1000`) y 20 filas expandidas son
 * ~140 barridos por pasada de detección de cambios — y `onQtyEdit()` dispara `tick()`, así que
 * cada tecla en una cantidad lo pagaba entero.
 *
 * Agrupar una vez y leer por clave es el patrón que `branchBuyMap` ya usa en el mismo componente.
 *
 * ── Por qué vive acá y no dentro del componente ─────────────────────────────────────────────
 * Para que se pueda probar **cruzando dos implementaciones**: el candado compara este índice
 * contra el `filter(...).sort(...)` ingenuo que reemplaza, fila por fila. Verificar el índice
 * contra sí mismo habría pasado en verde cualquier cosa; es la lección de `[IC.0]`/`[IC.3]`.
 */

/** Lo mínimo que una fila necesita para entrar al índice. */
export interface FilaDeProducto {
  product_id: string;
  type: string;
}

/**
 * Agrupa por `product_id` y ordena cada grupo con el comparador dado.
 *
 * Equivale a `filas.filter(f => f.product_id === pid).sort(comparar)` para todo `pid`, pero en un
 * solo barrido. `Array.prototype.sort` es estable, así que el empate conserva el orden de llegada
 * igual que en la versión ingenua — de eso depende que la equivalencia sea exacta y no "parecida".
 */
export function agruparPorProducto<T extends FilaDeProducto>(
  filas: readonly T[],
  comparar: (a: T, b: T) => number,
): Map<string, T[]> {
  const idx = new Map<string, T[]>();
  for (const f of filas) {
    const grupo = idx.get(f.product_id);
    if (grupo) grupo.push(f); else idx.set(f.product_id, [f]);
  }
  for (const grupo of idx.values()) grupo.sort(comparar);
  return idx;
}

/**
 * Sub-índice con las filas de un solo tipo.
 *
 * ⚠️ Los productos que se quedan **sin ninguna** fila de ese tipo **no entran al mapa** (en vez de
 * entrar con un arreglo vacío): así el consumidor devuelve siempre la MISMA referencia vacía y el
 * `@for` del template no se reconstruye en cada pasada por recibir un arreglo nuevo con nada.
 */
export function filtrarPorTipo<T extends FilaDeProducto>(idx: Map<string, T[]>, tipo: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const [pid, filas] of idx) {
    const propias = filas.filter((f) => f.type === tipo);
    if (propias.length) out.set(pid, propias);
  }
  return out;
}
