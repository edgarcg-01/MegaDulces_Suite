/**
 * `[GX.65]` — **En «Mis gastos» un vale abierto nunca se queda fuera por el `limit`.**
 *
 * ## El defecto
 * `list()` ordenaba por `created_at desc` y cortaba en `limit` (200 por defecto, 500 de
 * tope). Un vale ABIERTO más viejo que los últimos 200 —el devuelto que nadie corrigió, el
 * aprobado con cotización que espera su factura— desaparecía de la lista **sin aviso**,
 * justo cuando a la persona le toca hacer algo.
 *
 * ## La regla
 * Cuando la consulta es «lo mío», los abiertos viajan **todos** y el `limit` sólo recorta los
 * cerrados. Los abiertos de una persona son pocos (hoy 155 vales en TODA la empresa, local);
 * aun así llevan un tope duro, y si se alcanza **se declara** (`abiertos_truncados`) en vez
 * de cortar en silencio — que es el mismo defecto con otro número.
 *
 * ⚠️ «Abierto» es el estado NUESTRO del expediente, no la etapa de Kepler. Un vale `validada`
 * se cuenta cerrado aunque Kepler todavía no haya creado el gasto; eso lo resuelve la fase
 * de la comprobación, no ésta.
 */

/** Estados en los que el vale todavía le pide algo a alguien. `validada` es el único cerrado. */
export const ESTADOS_ABIERTOS = ['recibida', 'aprobada', 'revision', 'rechazada'] as const;

/** Tope duro de abiertos por persona. Alcanzarlo se declara; no se corta callado. */
export const TOPE_ABIERTOS = 1000;

/** Lo único que la unión necesita de cada fila. Llega de knex sin tipar, por eso `unknown`. */
export interface FilaConFecha {
  id?: unknown;
  created_at?: unknown;
  /** Sin esto TS la trata como tipo «débil» y rechaza las filas de knex (`FilaDeGasto`). */
  [k: string]: unknown;
}

const msDe = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v ?? '')).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Une abiertos (completos) y cerrados (recortados), sin duplicar, en el mismo orden que la
 * lista de siempre: lo más reciente primero.
 *
 * `abiertos` debe pedirse con `TOPE_ABIERTOS + 1` filas: la fila de más es la que delata
 * que hubo corte.
 */
export function unirAbiertosYCerrados<T extends FilaConFecha>(
  abiertos: T[],
  cerrados: T[],
  tope: number = TOPE_ABIERTOS,
): { filas: T[]; abiertos_truncados: boolean } {
  const abiertos_truncados = abiertos.length > tope;
  const vistos = new Set<string>();
  const filas: T[] = [];
  for (const f of [...abiertos.slice(0, tope), ...cerrados]) {
    const id = String(f.id ?? '');
    if (id && vistos.has(id)) continue;
    if (id) vistos.add(id);
    filas.push(f);
  }
  filas.sort((a, b) => msDe(b.created_at) - msDe(a.created_at));
  return { filas, abiertos_truncados };
}
