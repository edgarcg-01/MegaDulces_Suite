import { WritableSignal } from '@angular/core';

export interface LazyTableEvent {
  first?: number | null;
  rows?: number | null;
}

/**
 * Handler para `(onLazyLoad)` de PrimeNG p-table. Traduce first/rows del evento a
 * page (1-based) + pageSize en las señales dadas y dispara la recarga. Reemplaza
 * el bloque idéntico que estaba copiado en cada tabla lazy.
 *
 * Uso (field initializer, después de declarar page/pageSize):
 *   readonly onLazyLoad = makeLazyLoad(this.page, this.pageSize, () => this.load());
 */
export function makeLazyLoad(
  page: WritableSignal<number>,
  pageSize: WritableSignal<number>,
  load: () => void,
): (e: LazyTableEvent) => void {
  return (e) => {
    const rows = e.rows ?? pageSize();
    page.set(Math.floor((e.first ?? 0) / rows) + 1);
    pageSize.set(rows);
    load();
  };
}
