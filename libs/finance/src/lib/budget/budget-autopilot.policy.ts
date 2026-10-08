/**
 * [PU.VG.1] — A qué ejercicios entra la pasada del autopiloto.
 *
 * Módulo PURO a propósito: cero imports. Es la decisión que hay que poder romper en una prueba,
 * y dentro de un método de 80 líneas de un servicio de Nest no se puede — el spec arrastraría
 * todo el contenedor. Mismo criterio que `caja-autofill.engine.ts`.
 */

/** Estados en los que un ejercicio todavía se puede regenerar. Uno aprobado no se toca. */
export const ESTADOS_ABIERTOS = ['borrador', 'en_revision'];

/**
 * Dos condiciones, cada una por su motivo:
 *
 *   · el estado tiene que estar abierto — si alguien agrega un estado nuevo, este filtro se
 *     queda corto y el ejercicio NO entra, que es el lado seguro de equivocarse;
 *   · y no puede ser de prueba — medido en prod el 2026-10-08: de 3 ejercicios, 2 eran de
 *     prueba y uno se llama literalmente "PRUEBA ciclo ledger -- no usar". El cron lo recorría
 *     todas las mañanas y lo dejaba fresco, que es justo lo que lo hacía parecer legítimo.
 *
 * ⚠️ `is_test` se compara con `!== true` a propósito. La columna es NOT NULL DEFAULT false, pero
 * esta lista también la arma código viejo, y un `undefined` tiene que significar "no es de
 * prueba", nunca "no sé". Si algún día hace falta distinguir "no medido", es otra columna, no un
 * null acá (ADR-056).
 */
export function esEjercicioOperable(row: { status?: unknown; is_test?: unknown }): boolean {
  return ESTADOS_ABIERTOS.includes(String(row?.status)) && row?.is_test !== true;
}
