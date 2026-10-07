/**
 * `[CG.21]` — **Hasta cuántos días atrás un movimiento de caja es TRABAJO, y no archivo.**
 *
 * ── Por qué vive acá y no en `libs/finance` ──────────────────────────────────────────────────
 * Lo consumen DOS librerías que no se pueden importar entre sí: `libs/finance` (la bandeja de
 * `/finanzas/caja-general`) y `libs/trade` (el conteo de «Mi trabajo»). Si los dos números se
 * escribieran a mano, el día que uno cambie la pantalla y el tablero dirían cosas distintas sobre
 * la misma cola — y nadie se enteraría, porque los dos seguirían siendo plausibles. Es el defecto
 * que ADR-056 midió como «cinco familias de constantes duplicadas a mano».
 *
 * ── De dónde sale el 45 ──────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-09-22, al aplicar las migraciones de CG.21: `finance.cash_ledger`
 * está **vacío**, así que "pendiente de aplicar" es literalmente todo lo que Kepler registró desde
 * que hay ODS — **12,160 movimientos, el más viejo del 2025-01-01**. Cierto, e inútil como cola de
 * trabajo: publicarlo diría que la persona lleva veinte meses de atraso sobre un libro que todavía
 * no existía.
 *
 * 45 días sale del rezago de captura medido sobre 673 movimientos que llevan la fecha del hecho en
 * el texto: **4.7 días de promedio, peor caso 34**. La ventana cubre el peor caso con margen.
 *
 * ⛔ **Lo que queda fuera se DECLARA, no se esconde.** `GET /finance/cash-ledger/movimientos-pendientes`
 * devuelve `fuera_de_ventana` con su conteo y su monto, y la pantalla lo dice. Una bandeja acotada
 * que no publica dónde cortó es indistinguible de una bandeja vacía.
 *
 * ⚠️ Es POLÍTICA, no medición: se cambia en una línea. Lo que no se puede cambiar sin volver a
 * medir es la frase de arriba — si el rezago de captura baja, este número puede bajar con él.
 */
export const CAJA_VENTANA_DIAS = 45;

/**
 * `[CG.51]` — **Cuánto se muestra AL ABRIR la pantalla.** No es lo mismo que el techo de arriba.
 *
 * `CAJA_VENTANA_DIAS` es hasta dónde un movimiento sigue siendo trabajo: el BORDE. Éste es con
 * cuánto arranca la bandeja, que es otra pregunta — una cola de 12,976 renglones es correcta y
 * también es inservible como primera pantalla del día.
 *
 * ── Por qué NO es 1 (o sea, «hoy») ───────────────────────────────────────────────────────────
 * Pedido de Edgar el 2026-10-07: *"por default sólo deben ser los movimientos del día"*. Medido
 * contra prod ese mismo día, antes de implementarlo:
 *
 *     hoy (2026-10-07) ........      0 movimientos
 *     hoy + ayer ..............      7
 *     últimos 7 días ..........    201
 *     en la ventana de 45 .....  12,976
 *     día más reciente con volumen: 2026-10-05, con 40
 *
 * ⛔ **«Hoy» da la pantalla VACÍA**, y no por casualidad: `fecha_valor` es la fecha del DOCUMENTO
 * en Kepler, no la de cuándo el trabajo llega. El propio código ya lo tenía escrito — *"el ERP
 * captura con 3 días de mediana, y ninguno legítimo tiene `fecha_valor` de hoy"*— y hasta tiene
 * un contador aparte (`malFechados`) para los que vienen fechados **en el futuro**: medidos hoy,
 * 7 documentos entre el 01 y el 14 de diciembre.
 *
 * ── De dónde sale el 3 ───────────────────────────────────────────────────────────────────────
 * De esa misma mediana de captura. Tres días es «la jornada y su rezago normal»: lo que de verdad
 * llegó para trabajarse hoy. Medido: **48 movimientos**, contra 12,976 de la ventana completa.
 *
 * ⚠️ Lo de atrás NO se esconde: la bandeja publica cuántos quedan antes del corte y con cuánto
 * dinero, y el selector los trae en un clic. Una bandeja acotada que no publica dónde cortó es
 * indistinguible de una bandeja vacía.
 */
export const CAJA_JORNADA_DIAS = 3;
