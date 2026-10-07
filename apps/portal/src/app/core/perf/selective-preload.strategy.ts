import { Injectable } from '@angular/core';
import { PreloadingStrategy, Route } from '@angular/router';
import { Observable, of, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

/**
 * Preload selectivo y consciente de la red (reemplaza a PreloadAllModules).
 *
 * - En red lenta (2g) o Save-Data NO precarga nada: el chunk baja on-demand al
 *   navegar, en vez de saturar el enlace y competir con la interacción — clave
 *   en gama baja / datos móviles.
 * - En red normal precarga SOLO las rutas marcadas `data.preload`, y tras 2s
 *   para no pelear con el render inicial. El resto queda lazy puro.
 */
@Injectable({ providedIn: 'root' })
export class SelectivePreloadStrategy implements PreloadingStrategy {
  preload(route: Route, load: () => Observable<unknown>): Observable<unknown> {
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return of(null);
    if (route.data?.['preload']) return timer(2000).pipe(mergeMap(() => load()));
    return of(null);
  }
}
