import { Injectable } from '@angular/core';
import { PreloadingStrategy, Route } from '@angular/router';
import { Observable, of, timer } from 'rxjs';
import { switchMap } from 'rxjs/operators';

/**
 * Precarga de rutas lazy: por lista explícita y fuera del camino crítico.
 *
 * Antes precargaba TODO para quien tuviera dashboard completo (reportes de equipo o
 * global) — es decir, para los administradores. Suena inocente y no lo es: el
 * `RouterPreloader` de Angular recorre las rutas con `from(res).pipe(mergeAll())`, **sin
 * límite de concurrencia**, y lo re-dispara en **cada `NavigationEnd`**. Con 170
 * `loadComponent` en `app.routes.ts` eso son 170 `import()` simultáneos, ~2.2 MB de
 * chunks, compitiendo por la conexión justo cuando la pantalla recién abierta pide sus
 * datos. En el Centro de Control —11 llamadas en paralelo, la ruta con más XHR de la
 * app— el resultado se ve como un cuelgue: el servidor responde en milisegundos y el
 * navegador tarda decenas de segundos en recibirlo.
 *
 * Dos cambios, los dos deliberados:
 *
 *  1. **Opt-in.** Solo se precarga una ruta marcada con `data: { preload: true }`. El
 *     default es no precargar: una ruta lazy pesa un chunk y se baja en el momento, que
 *     es exactamente para lo que existe. La lista arranca VACÍA a propósito — agregá una
 *     ruta cuando tengas motivo, no por si acaso, y de a pocas: la concurrencia sigue
 *     sin tope, así que marcar veinte reproduce el problema en chico.
 *
 *  2. **Demora.** Aunque esté marcada, no arranca hasta pasados unos segundos. La
 *     pantalla que el usuario pidió va primero; la precarga es para la SIGUIENTE.
 */
@Injectable({ providedIn: 'root' })
export class SelectivePreloadStrategy implements PreloadingStrategy {
  /** Nada se precarga antes de esto: la pantalla en curso tiene prioridad. */
  private static readonly PRELOAD_DELAY_MS = 8_000;

  preload(route: Route, load: () => Observable<unknown>): Observable<unknown> {
    if (route.data?.['preload'] !== true) return of(null);
    return timer(SelectivePreloadStrategy.PRELOAD_DELAY_MS).pipe(switchMap(() => load()));
  }
}
