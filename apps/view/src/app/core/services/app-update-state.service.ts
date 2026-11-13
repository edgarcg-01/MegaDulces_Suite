import { Injectable, signal } from '@angular/core';

/**
 * ⭐ `[AUD.8]` (2026-11-13) — Una sola fuente de verdad de "ngsw ya tiene una versión nueva lista".
 *
 * `app.component` escucha `VERSION_READY` del service worker y lo deja marcado acá; dos
 * consumidores lo leen de forma **síncrona**, sin repetir ningún `fetch`:
 *
 *  - el propio `app.component`, que activa la versión nueva cuando la pestaña se oculta (`[SW.2]`);
 *  - el `GlobalErrorHandler`, que ante una falla de carga con una versión staged ya **sabe** que
 *    es `stale-version` y no tiene que adivinarla preguntándole al servidor por el archivo.
 *
 * ⛔ **Por qué un signal propio y no `SwUpdate`:** `SwUpdate` no expone "hay una versión bajada,
 * pendiente de activar" como una lectura síncrona — sólo el *stream* `versionUpdates`. Y el
 * discriminador de `[AUD.6]` hace un `HEAD` que el propio service worker puede contestar desde su
 * caché vieja (el SW ignora `cache: 'no-store'`), así que depender de ese `fetch` es justo lo
 * frágil que dejó al teléfono en «sin determinar» después de cada despliegue. El evento
 * `VERSION_READY` no pasa por ningún `fetch` ad-hoc: es el testigo limpio.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateState {
  /** true cuando ngsw ya bajó una versión nueva (emitió VERSION_READY) y está pendiente de activar. */
  readonly pending = signal(false);
}
