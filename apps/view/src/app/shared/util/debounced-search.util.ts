import { Subject, debounceTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/**
 * Search con debounce (RxJS), auto-limpiado vía `takeUntilDestroyed`. Devuelve la
 * función a enganchar en `(input)` / `(ngModelChange)`. Unifica los 3 estilos que
 * había en /comercial (Subject+debounceTime y setTimeout manual) en uno solo.
 *
 * DEBE llamarse en un injection context (field initializer o constructor), porque
 * `takeUntilDestroyed()` resuelve el DestroyRef del componente desde ahí.
 *
 * Uso:
 *   readonly onSearch = makeDebouncedSearch((term) => {
 *     this.searchTerm.set(term.trim()); this.page.set(1); this.load();
 *   });
 */
export function makeDebouncedSearch(
  apply: (term: string) => void,
  delayMs = 250,
): (value: string) => void {
  const subject = new Subject<string>();
  subject.pipe(debounceTime(delayMs), takeUntilDestroyed()).subscribe(apply);
  return (value: string) => subject.next(value);
}
