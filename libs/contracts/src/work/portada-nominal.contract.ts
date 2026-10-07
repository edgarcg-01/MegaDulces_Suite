/**
 * `[SN.35]` — **Departamentos a los que la portada NO les muestra el trabajo A SU NOMBRE.**
 *
 * ── El pedido ────────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-22: *«eliminemos esas conciliación a nombres de personas hasta nuevo aviso, solo
 * debe aparecer la base de datos (en mi caso)»*.
 *
 * ── Qué apaga, exactamente ───────────────────────────────────────────────────────────────────
 * El bloque **«A tu nombre»** entero: las tareas que alguien asignó (`MeWork.tareas`) y los
 * borradores propios (las bandejas de alcance `'mio'`). Lo que queda es **«De las que respondes»**
 * — en el caso de Sistemas, la cola de salud de las bases de datos y nada más.
 *
 * ── ⛔ Por qué por DEPARTAMENTO y no para todos ──────────────────────────────────────────────
 * Medido contra prod el 2026-09-22: hay **151 tareas vivas repartidas sobre 38 de 118 personas**.
 * Apagarlo global dejaría a 37 personas sin ver trabajo que alguien les asignó **con nombre y
 * fecha** — y el pedido dice *«(en mi caso)»*. Se acota al departamento que lo pidió; ampliarlo es
 * agregar una cadena a esta lista.
 *
 * ── ⛔ Se DECLARA en pantalla, no se esconde ─────────────────────────────────────────────────
 * Con el bloque apagado, la columna dice que su trabajo nominal está oculto y por qué. Sin esa
 * línea, una portada recortada es indistinguible de una portada vacía — que es exactamente lo que
 * `[SN.21]` corrigió para la lista de colas, y lo que ADR-056 llama «un cero dibujado».
 *
 * ⛔ **Y el titular se apaga con él.** Decir «0 pendientes a tu nombre» mientras se ocultan 10 no
 * es un recorte: es una afirmación falsa. Cuando esto está encendido, la columna no publica esa
 * cifra en vez de publicarla mal.
 *
 * ── ⚠️ Es un recorte de PORTADA, no de acceso ni de datos ────────────────────────────────────
 * Nada se borra y nada se reasigna: las tareas siguen en sus tablas, `me/work` las sigue
 * devolviendo y las pantallas que las resuelven siguen abiertas. Sólo dejan de ocupar la landing.
 * Volverlas a mostrar es **quitar una cadena de esta lista** — que es lo que «hasta nuevo aviso»
 * pide poder hacer sin pensarlo.
 *
 * ⚠️ El departamento llega de `GET /users/me/context`, que es asíncrono: hasta que contesta, el
 * bloque se pinta. Ocultar por un dato que todavía no llegó sería decidir sobre lo que no se midió.
 */
export const DEPARTAMENTOS_SIN_TRABAJO_NOMINAL: readonly string[] = ['sistemas'];

/** El motivo que la pantalla imprime cuando el bloque está apagado. Vive con la política. */
export const MOTIVO_SIN_TRABAJO_NOMINAL =
  'El trabajo a tu nombre está oculto por decisión de Dirección, hasta nuevo aviso. No se borró ' +
  'nada: las tareas siguen asignadas y las abrís desde su pantalla.';
