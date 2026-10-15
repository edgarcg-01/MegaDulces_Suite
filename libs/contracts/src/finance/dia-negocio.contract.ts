/**
 * `[CGP-L.5]` **Las dos preguntas de fecha de la caja, que no son la misma.**
 *
 *   · ¿Qué día es esta columna `date`?                       → `diaDeFecha`
 *   · ¿Qué día de NEGOCIO (México) fue este instante?        → `diaMxDeInstante`
 *     (un `timestamptz`, un `now()`, un ISO con hora)
 *
 * Mezclarlas costó, medido en caja:
 *   · `String(date).slice(0, 10)` da «Tue Oct 13» —un `date` de Postgres llega como OBJETO `Date`
 *     (el repo no fija `setTypeParser`)— y rechazaba filas como futuras o no atribuía nada.
 *   · `toISOString().slice(0, 10)` sobre un instante da el día en UTC: un depósito de CAOS a las 19:00
 *     del 12-oct quedaba del 13, y podía consumir un cobro de un día que todavía no existía.
 *
 * Sin dependencias: lo comparten el servidor y la pantalla. Se prueba en tres zonas horarias del
 * proceso, porque el día de una fecha no puede depender de dónde corre el servidor.
 */
export const ZONA_NEGOCIO_MX = 'America/Mexico_City';

/**
 * El día de una columna `date`. node-postgres la arma como medianoche LOCAL del proceso, así que se
 * lee con sus componentes locales — no con `toISOString` (al este de UTC da el día anterior) ni con
 * la zona de México (con el proceso en UTC también da el día anterior). Un texto vale si empieza con
 * `YYYY-MM-DD`; cualquier otra cosa es `null`: una fecha que no se pudo leer se declara.
 */
export function diaDeFecha(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p2 = (x: number) => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** El día de negocio en México de un instante (`Date`, ISO con hora o `timestamptz`). */
export function diaMxDeInstante(v: unknown): string | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: ZONA_NEGOCIO_MX });
}
