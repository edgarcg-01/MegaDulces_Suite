import { ErrorHandler, Injectable, inject } from '@angular/core';
import { AppErrorService, AppErrorKind } from './app-error.service';
import { hayServiceWorker, versionDelServidor } from './rescate';

/**
 * ErrorHandler global de la plataforma web.
 *
 * `apps/view` no tenía ninguno (el portal sí): una excepción no capturada dejaba
 * la pantalla en blanco, sin nada que ver, nada que reportar y nada registrado.
 *
 * Engancha también `unhandledrejection`, que el ErrorHandler de Angular NO
 * captura por su cuenta — y en una app llena de `subscribe`/`await` es de donde
 * sale buena parte de los errores.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly errors = inject(AppErrorService);
  private hooked = false;

  constructor() {
    if (typeof window !== 'undefined' && !this.hooked) {
      this.hooked = true;
      window.addEventListener('unhandledrejection', (e) => this.handleError(e.reason));
    }
  }

  handleError(error: unknown): void {
    const message = describe(error);
    const stack = error instanceof Error && error.stack
      ? error.stack.split('\n').slice(0, 6).join('\n')
      : undefined;

    if (fallaDeCarga(error, message)) {
      // ⛔ No se afirma la causa todavía: el navegador da el MISMO error para
      // «ya no existe» y «no llegó». Se pregunta y recién entonces se dice.
      const recurso = recursoDe(error, message) ?? undefined;
      const err = this.errors.report('load-checking', message, stack, recurso);
      console.error(`[${err.id}]`, error);
      void clasificarFallaDeCarga(recurso ?? null).then((kind) => this.errors.resolver(err.id, kind));
      return;
    }

    const err = this.errors.report('unexpected', message, stack);
    // El id se imprime junto al error para poder cruzar lo que reporta el
    // usuario con lo que quedó en la consola.
    console.error(`[${err.id}]`, error);
  }
}

/**
 * ¿El error es un trozo de código de la app que no se pudo cargar?
 *
 * ⚠️ Dice **que la carga falló**, no POR QUÉ. Cada bundler lo redacta distinto, de ahí la
 * lista; ninguno distingue un archivo que ya no está de uno que no llegó. Esa pregunta la
 * contesta `clasificarFallaDeCarga` preguntándole al servidor.
 */
export function fallaDeCarga(error: unknown, message: string): boolean {
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'ChunkLoadError') {
    return true;
  }
  const m = message.toLowerCase();
  return (
    m.includes('failed to fetch dynamically imported module') ||   // esbuild / Vite
    m.includes('error loading dynamically imported module') ||     // Vite
    m.includes('loading chunk') ||                                 // webpack
    m.includes('loading css chunk') ||
    m.includes('importing a module script failed')                 // Safari
  );
}

/**
 * El archivo que no cargó, sacado del texto del error.
 *
 * Los bundlers lo incluyen en el mensaje ("Failed to fetch dynamically imported module:
 * https://…/chunk-ABC.js"). Sin él no se puede preguntar nada y la causa queda declarada
 * como indeterminada, que es lo correcto — no se adivina.
 */
export function recursoDe(error: unknown, message: string): string | null {
  const directo = (error as { request?: unknown; url?: unknown } | null)?.request
    ?? (error as { url?: unknown } | null)?.url;
  if (typeof directo === 'string' && /^https?:\/\//i.test(directo)) return directo;
  const m = /https?:\/\/[^\s"')]+/i.exec(message);
  return m ? m[0] : null;
}

/** Cuánto se espera al servidor antes de declarar que no se pudo saber. */
const TIMEOUT_MS = 4000;

/**
 * ⭐ El discriminador: le pregunta al servidor por el archivo que falló.
 *
 * Es lo único que separa las cuatro causas, porque el error del navegador es idéntico en
 * todas. **404/410 es el único caso en el que se puede afirmar que hubo versión nueva**: el
 * archivo lleva hash en el nombre, así que si el servidor dice que no existe es porque se
 * publicó otra cosa encima.
 *
 * Se consulta con `no-store` a propósito: una respuesta de la caché contestaría por un
 * archivo que el navegador ya tenía y no por el que falló.
 */
export async function clasificarFallaDeCarga(
  recurso: string | null,
  deps: {
    fetch?: typeof fetch;
    enLinea?: () => boolean;
    timeoutMs?: number;
    /** Para la segunda medida (`veredictoLocal`): quién controla la página y qué corre. */
    nav?: Navigator;
    documento?: Document;
  } = {},
): Promise<AppErrorKind> {
  const enLinea = deps.enLinea ?? (() => globalThis.navigator?.onLine !== false);
  const hacerFetch = deps.fetch ?? globalThis.fetch?.bind(globalThis);

  if (!enLinea()) return 'load-offline';
  if (!hacerFetch) return 'load-unknown';
  // Sin archivo que preguntar no se acabó la medición: todavía se puede comparar la versión
  // de esta pestaña contra la del servidor, que no necesita saber cuál archivo faltó.
  if (!recurso) return veredictoLocal(deps);

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const ms = deps.timeoutMs ?? TIMEOUT_MS;
  let t: ReturnType<typeof setTimeout> | undefined;

  // ⚠️ El corte NO se delega en la señal de aborto: si quien contesta la ignora, la promesa
  // se queda colgada y el aviso se queda en «un momento» para siempre. Por eso el reloj es
  // una carrera aparte, y el aborto va además para no dejar la consulta viva.
  const porTiempo = new Promise<AppErrorKind>((resolve) => {
    t = setTimeout(() => { ctrl?.abort(); resolve('load-unknown'); }, ms);
  });

  const porServidor = (async (): Promise<AppErrorKind> => {
    try {
      const r = await hacerFetch(recurso, { method: 'HEAD', cache: 'no-store', signal: ctrl?.signal });
      if (r.status === 404 || r.status === 410) return 'stale-version';
      if (r.status >= 500) return 'load-server';
      // Contesta bien (o con otro 4xx): el archivo ESTÁ en el servidor. Entonces lo que falló
      // está de este lado, y hay una medida más que hacer antes de rendirse (`[AUD.7]`).
      return veredictoLocal(deps);
    } catch {
      // La consulta tampoco llegó. Si entretanto se cayó la red, eso explica las dos.
      return enLinea() ? 'load-unknown' : 'load-offline';
    }
  })();

  try {
    return await Promise.race([porServidor, porTiempo]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * ⭐ Segunda medida, cuando el servidor NO acusó al archivo: ¿de qué lado está el problema?
 *
 * Se llega acá en dos situaciones, y en las dos el servidor queda descartado: el archivo
 * contestó bien, o el error del navegador no traía ningún archivo que preguntar. Lo que queda
 * por medir es local, y son dos preguntas:
 *
 *  1. **¿Esta pestaña corre la versión de hoy?** Si no, hubo despliegue y es `stale-version`,
 *     aunque el archivo que falló todavía exista — el servidor conserva los viejos un rato.
 *  2. **¿Hay un service worker controlando la página?** Si la versión es la de hoy y el archivo
 *     está en el servidor, el único que queda en el camino es la copia guardada del dispositivo.
 *
 * ⛔ **Si no hay service worker, no se culpa a la copia local.** No hay nadie entre el navegador
 * y el servidor a quien atribuirle la falla, así que se DECLARA indeterminada. Acusar sin ese
 * testigo sería inventar una causa, que es exactamente el defecto que `[AUD.6]` vino a cerrar.
 */
async function veredictoLocal(
  deps: { fetch?: typeof fetch; nav?: Navigator; documento?: Document } = {},
): Promise<AppErrorKind> {
  const version = await versionDelServidor(deps);
  if (version === 'vieja') return 'stale-version';
  if (version === 'al-dia' && hayServiceWorker(deps)) return 'local-copy';
  return 'load-unknown';
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err)?.slice(0, 500) ?? String(err);
  } catch {
    return String(err);
  }
}
