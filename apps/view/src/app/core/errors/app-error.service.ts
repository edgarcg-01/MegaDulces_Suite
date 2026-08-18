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
}

@Injectable({ providedIn: 'root' })
export class AppErrorService {
  readonly current = signal<AppError | null>(null);
  private seq = 0;

  report(kind: AppErrorKind, message: string): AppError {
    const err: AppError = { kind, id: this.nextId(), message };
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
}
