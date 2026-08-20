/**
 * Ordenamiento por columna para las tablas CRUDAS de Finanzas — las que no son `p-table`
 * porque llevan encabezados agrupados con colspan/rowspan que PrimeNG no arma.
 *
 * Vive fuera de `bancos-shared` desde 2026-08: el detalle del día de `/finanzas/caja` ordena
 * igual que el detalle por cuenta de `/finanzas/bancos`, y dejarlo bajo `bancos/` obligaba a
 * Caja a importar del módulo del vecino.
 */
/**
 * Ordenamiento por columna para las tablas CRUDAS del tablero (las que no son
 * `p-table`, porque llevan encabezados agrupados con colspan/rowspan que PrimeNG
 * no arma). `p-table` trae lo suyo con `pSortableColumn`; esto es el equivalente
 * mínimo para el resto: un campo, una dirección, y un comparador que entiende
 * número, fecha ISO y texto.
 */
export type SortDir = 'asc' | 'desc';
export interface SortState { field: string; dir: SortDir }

/** Alterna: mismo campo → invierte; campo nuevo → arranca descendente (lo más grande primero). */
export function toggleSort(cur: SortState | null, field: string): SortState {
  if (cur?.field === field) return { field, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { field, dir: 'desc' };
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
 * Copia ordenada. Nulos siempre al final (en ambas direcciones): un dato ausente
 * no compite con uno presente por el primer lugar.
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
