import { Injectable, signal } from '@angular/core';

/**
 * Qué clase de falla es. La distinción manda el diseño de la respuesta.
 *
 * ⛔⛔ **Una falla de carga NO es por sí sola un despliegue** (`[AUD.6]`, 2026-11-12). Hasta
 * ese día todas caían en `stale-version` y la pantalla AFIRMABA que se había publicado una
 * versión — también cuando se cortó la red, cuando el nodo de CDN que le tocó no tenía el
 * archivo, o cuando el equipo estaba sin conexión; y en esos casos su único botón, recargar,
 * no saca a nadie de ahí. Eso es la ley 0 del estándar rota (*nada afirma lo que no es*) en
 * la pantalla que se pinta encima de todo.
 *
 * El error del navegador es el MISMO en los cuatro casos, así que la causa no se adivina:
 * se le pregunta al servidor por el archivo que falló (`clasificarFallaDeCarga`).
 *
 *  - `load-checking`: falló la carga y todavía no sabemos por qué. Estado honesto y breve:
 *    bloquea y no afirma ninguna causa.
 *  - `stale-version`: el archivo ya NO está en el servidor (404/410) → hubo versión nueva y
 *    recargar es la salida.
 *  - `load-offline`: el equipo no tiene conexión. Recargar no ayuda; se reintenta.
 *  - `load-server`: el servidor contestó con error (5xx). Ni versión nueva ni la red de quien
 *    la usa.
 *  - `local-copy`: el archivo SÍ está en el servidor, esta pestaña corre la versión de hoy, y
 *    hay un service worker controlándola. El único que queda en el camino es la copia que el
 *    dispositivo tiene guardada, y la cura es borrarla — no recargar (`[AUD.7]`, 2026-11-13:
 *    recargar devolvía al mismo aviso una y otra vez, porque el service worker sobrevive a la
 *    recarga y vuelve a servir lo mismo).
 *  - `load-unknown`: no se pudo determinar la causa (el archivo responde bien, o la consulta
 *    también falló). Se DECLARA, no se inventa ninguna de las otras tres.
 *  - `unexpected`: cualquier otra excepción no capturada. Casi siempre la app sigue usable,
 *    así que se avisa sin tapar nada. Tomarse la pantalla entera por un error recuperable
 *    haría perder trabajo en curso.
 */
export type AppErrorKind =
  | 'load-checking'
  | 'stale-version'
  | 'load-offline'
  | 'load-server'
  | 'local-copy'
  | 'load-unknown'
  | 'unexpected';

/** Las que tapan la pantalla: la navegación quedó inservible y hay que decidir algo. */
const BLOQUEANTES: readonly AppErrorKind[] = [
  'load-checking', 'stale-version', 'load-offline', 'load-server', 'local-copy', 'load-unknown',
];

export function bloquea(kind: AppErrorKind): kind is Exclude<AppErrorKind, 'unexpected'> {
  return BLOQUEANTES.includes(kind);
}

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
  /** El archivo que no cargó, cuando el error lo traía. Es lo que se le pregunta al servidor. */
  recurso?: string;
}

/** Cuántos errores se guardan localmente para poder consultarlos después. */
const KEEP = 10;
const STORE_KEY = 'app_errors';

@Injectable({ providedIn: 'root' })
export class AppErrorService {
  readonly current = signal<AppError | null>(null);
  private seq = 0;

  report(kind: AppErrorKind, message: string, stack?: string, recurso?: string): AppError {
    const err: AppError = {
      kind, id: this.nextId(), message, stack, recurso,
      at: new Date().toISOString(),
      url: typeof location !== 'undefined' ? location.pathname + location.search : undefined,
    };
    this.persist(err);
    // Una falla de carga gana sobre cualquier otro aviso: el resto de los errores
    // que vengan después son consecuencia de eso.
    const actual = this.current();
    if (bloquea(kind) || !actual || !bloquea(actual.kind)) {
      this.current.set(err);
    }
    return err;
  }

  /**
   * Cambia la causa de una falla de carga una vez que el servidor contestó.
   *
   * Sólo toca el aviso si sigue siendo EL MISMO que se está mostrando: si mientras tanto
   * entró otro, el veredicto viejo no debe pisarlo.
   */
  resolver(id: string, kind: AppErrorKind): void {
    const actual = this.current();
    if (!actual || actual.id !== id) return;
    this.current.set({ ...actual, kind });
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
      `causa   ${err.kind}`,
      err.recurso ? `archivo ${err.recurso}` : '',
      `error   ${err.message}`,
      err.stack ? `stack\n${err.stack}` : '',
    ].filter(Boolean).join('\n');
  }
}
