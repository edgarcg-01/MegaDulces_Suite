import { Injectable, signal } from '@angular/core';

/**
 * Qué clase de falla es. La distinción manda el diseño de la respuesta:
 *
 *  - `stale-version`: se desplegó una versión nueva con la pestaña abierta y el
 *    trozo de código que se pidió ya no existe en el servidor. La app quedó
 *    inservible para esa navegación y la ÚNICA salida es recargar → se bloquea.
 *  - `unexpected`: cualquier otra excepción no capturada. Casi siempre la app
 *    sigue usable, así que se avisa sin tapar nada. Tomarse la pantalla entera
 *    por un error recuperable haría perder trabajo en curso.
 */
export type AppErrorKind = 'stale-version' | 'unexpected';

export interface AppError {
  kind: AppErrorKind;
  /** Corto y pronunciable: sirve para reportarlo por teléfono o WhatsApp. */
  id: string;
  message: string;
  /** Momento (ISO) y pantalla donde ocurrió — sin esto el código no se puede rastrear. */
  at?: string;
  url?: string;
  /** Primeras líneas del stack, si el error las traía. */
  stack?: string;
}

/** Cuántos errores se guardan localmente para poder consultarlos después. */
const KEEP = 10;
const STORE_KEY = 'app_errors';

@Injectable({ providedIn: 'root' })
export class AppErrorService {
  readonly current = signal<AppError | null>(null);
  private seq = 0;

  report(kind: AppErrorKind, message: string, stack?: string): AppError {
    const err: AppError = {
      kind, id: this.nextId(), message, stack,
      at: new Date().toISOString(),
      url: typeof location !== 'undefined' ? location.pathname + location.search : undefined,
    };
    this.persist(err);
    // Una versión vieja gana sobre cualquier otro aviso: el resto de los errores
    // que vengan después son consecuencia de eso.
    if (kind === 'stale-version' || this.current()?.kind !== 'stale-version') {
      this.current.set(err);
    }
    return err;
  }

  dismiss(): void {
    this.current.set(null);
  }

  private nextId(): string {
    return `${Date.now().toString(36)}-${(++this.seq).toString(36)}`.toUpperCase();
  }

  /**
   * Guarda los últimos errores en el navegador.
   *
   * El aviso solo muestra un código, y el detalle iba únicamente a `console.error`: si la
   * consola no estaba abierta cuando ocurrió, el código que reporta el usuario no lleva a
   * ninguna parte. Con esto el detalle sobrevive a la recarga y se puede recuperar después
   * con `recent()` o desde el botón de copiar del aviso.
   */
  private persist(err: AppError): void {
    try {
      const prev = this.recent();
      localStorage.setItem(STORE_KEY, JSON.stringify([err, ...prev].slice(0, KEEP)));
    } catch { /* storage lleno o bloqueado: el aviso en pantalla sigue funcionando */ }
  }

  /** Últimos errores registrados en este navegador, del más reciente al más viejo. */
  recent(): AppError[] {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  /** Texto listo para pegar en un chat cuando alguien reporta un código. */
  describe(err: AppError): string {
    return [
      `código ${err.id}`,
      `cuándo  ${err.at ?? '—'}`,
      `pantalla ${err.url ?? '—'}`,
      `error   ${err.message}`,
      err.stack ? `stack\n${err.stack}` : '',
    ].filter(Boolean).join('\n');
  }
}
