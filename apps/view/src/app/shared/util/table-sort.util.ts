/**
 * Ordenamiento por columna para las tablas CRUDAS — las que no son `p-table` porque llevan
 * encabezados agrupados con colspan/rowspan que PrimeNG no arma, o porque salieron de PrimeNG
 * cuando v22 pasó a licencia comercial. `p-table` trae lo suyo con `pSortableColumn`; esto es
 * el equivalente mínimo para el resto: un campo, una dirección, y las tres piezas que un
 * encabezado clickeable necesita para no mentir (ícono, `aria-sort`, alternar).
 *
 * Vivía en `modules/finanzas/pages/finanzas-sort.ts` y su propio comentario ya se quejaba de
 * que Caja tuviera que importar del módulo del vecino. `[RE.20.2]` lo trajo acá cuando Compras
 * necesitó lo mismo: la tercera pantalla es la que paga la mudanza.
 *
 * **Dos mundos, misma cáscara.** El estado, el ícono y el `aria-sort` son idénticos; lo que
 * cambia es quién ordena:
 *   - **En memoria** (`sortRows`) — la tabla ya tiene TODAS las filas. Finanzas.
 *   - **En el servidor** (`serverSortParams`) — la tabla está paginada y sólo tiene la página
 *     de enfrente. Ordenar las 50 visibles de 875 no es ordenar: es mentir con una flecha.
 */
export type SortDir = 'asc' | 'desc';
/**
 * `F` deja atar el campo al union que entiende el endpoint (`SortState<'fecha' | 'monto'>`), y
 * entonces un typo en el nombre de una columna es error de compilación y no una lista que
 * vuelve en el orden de siempre sin decir por qué. Por default es `string`, que es lo que
 * necesitan las tablas que ordenan en memoria.
 */
export interface SortState<F extends string = string> { field: F; dir: SortDir }

/**
 * Alterna: mismo campo → invierte; campo nuevo → arranca en `inicial`.
 *
 * El default es `desc` porque en la mayoría de las tablas la primera columna que uno ordena es
 * dinero y ahí se busca lo más grande. Pero no siempre: en un nombre se busca la A, y en una
 * worklist se busca lo más viejo. Por eso `inicial` es un parámetro y no una constante — un
 * primer clic que cae del lado inútil obliga a un segundo clic siempre.
 */
export function toggleSort<F extends string>(cur: SortState<F> | null, field: F, inicial: SortDir = 'desc'): SortState<F> {
  if (cur?.field === field) return { field, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { field, dir: inicial };
}

/** Ícono del encabezado: neutro si la columna no es la activa. */
export function sortIcon(cur: SortState | null, field: string): string {
  if (cur?.field !== field) return 'pi pi-sort-alt';
  return cur.dir === 'asc' ? 'pi pi-sort-amount-up-alt' : 'pi pi-sort-amount-down';
}

/** `aria-sort` del `<th>` — sin esto la tabla ordenable no se anuncia a un lector de pantalla. */
export function ariaSort(cur: SortState | null, field: string): 'ascending' | 'descending' | 'none' {
  if (cur?.field !== field) return 'none';
  return cur.dir === 'asc' ? 'ascending' : 'descending';
}

/**
 * Los dos query params que espera un endpoint paginado (`?orden=…&dir=…`).
 * Se separa de `sortRows` para que quede a la vista cuál de los dos mundos usa cada tabla.
 */
export function serverSortParams<F extends string>(cur: SortState<F> | null): { orden?: F; dir?: SortDir } {
  return cur ? { orden: cur.field, dir: cur.dir } : {};
}

/**
 * Copia ordenada EN MEMORIA. Nulos siempre al final (en ambas direcciones): un dato ausente
 * no compite con uno presente por el primer lugar.
 *
 * ⚠️ Sólo para tablas que ya tienen todas sus filas. Si la tabla es server-paginada, va
 * `serverSortParams` y una recarga.
 */
export function sortRows<T>(rows: T[], sort: SortState | null, pick: (r: T, field: string) => unknown): T[] {
  if (!sort) return rows;
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = pick(a, sort.field), vb = pick(b, sort.field);
    const na = va == null || va === '', nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb), 'es-MX', { numeric: true }) * mul;
  });
}
