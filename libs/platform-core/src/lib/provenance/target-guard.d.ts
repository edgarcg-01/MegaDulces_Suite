/**
 * Tipos de `target-guard.js`.
 *
 * La implementación es CommonJS a propósito (ver el encabezado del `.js`: es lo
 * primero que corre cada script que escribe, y `ts-node` cuesta ~1.4 s por
 * proceso). Con `allowJs:false` en `tsconfig.base.json`, TypeScript resuelve los
 * tipos por este `.d.ts` y el bundler resuelve el `.js` en tiempo de build — el
 * patrón estándar de "JS con tipos a mano". Si cambiás la firma en el `.js`,
 * cambiala acá: no hay nada que las cruce automáticamente.
 */

export type TargetKind = 'prod' | 'local' | 'compartida' | 'desconocido';

export interface TargetInfo {
  kind: TargetKind;
  host: string | null;
  db: string | null;
}

/** Clasifica sin matar el proceso. Es la única función testeable en el mismo proceso. */
export function classify(url: string | null | undefined): TargetInfo;

/**
 * Aborta (`process.exit(2)`) si el destino no es seguro para ESCRIBIR.
 * `prod` y `desconocido` abortan; `compartida` pasa avisando.
 */
export function assertSafeTarget(nombre: string, opts?: { url?: string }): TargetInfo;

/**
 * Aborta si el destino/origen no es exactamente `expect`.
 * Con `intent:'write'`, `TEST_TARGET_ALLOW` no aplica.
 */
export function assertTarget(
  nombre: string,
  opts: { url: string; intent: 'read' | 'write'; expect: 'prod' | 'local' | 'compartida' },
): TargetInfo;

/** Aborta si las dos URLs son la misma base física (compara `host:port/db`). */
export function assertDistinct(
  nombre: string,
  urlA: string,
  urlB: string,
): { a: string; b: string };
