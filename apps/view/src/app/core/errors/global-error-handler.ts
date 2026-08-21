import { ErrorHandler, Injectable, inject } from '@angular/core';
import { AppErrorService } from './app-error.service';

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
    const err = this.errors.report(isStaleChunk(error, message) ? 'stale-version' : 'unexpected', message, stack);
    // El id se imprime junto al error para poder cruzar lo que reporta el
    // usuario con lo que quedó en la consola.
    console.error(`[${err.id}]`, error);
  }
}

/**
 * ¿El error es un trozo de código que ya no está en el servidor?
 *
 * Pasa cuando se despliega con la pestaña abierta: los nombres de archivo llevan
 * hash, así que el que la pestaña vieja pide desapareció. Cada bundler lo dice
 * distinto, de ahí la lista.
 */
export function isStaleChunk(error: unknown, message: string): boolean {
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

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err)?.slice(0, 500) ?? String(err);
  } catch {
    return String(err);
  }
}
