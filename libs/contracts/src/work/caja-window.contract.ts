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
