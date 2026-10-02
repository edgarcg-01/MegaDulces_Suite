import type { StockoutKind } from './faltantes.service';

/**
 * `[FLT.23]` — Las reglas del buscador que anota solo, en un módulo PURO.
 *
 * Viven acá y no dentro del componente por la misma razón que `stockout-destino.ts` del backend:
 * son las dos decisiones que pueden estar mal sin que nada se vea roto en pantalla, y una regla
 * que sólo se puede probar levantando un navegador no se prueba.
 */

/**
 * El motivo con el que entra un alta automática. **Siempre `agotado`, nunca otro.**
 *
 * ⚠️ Es una pérdida consciente de información, no un descuido: al no preguntar nada, los otros
 * tres motivos dejan de capturarse por este camino. En particular `no_en_anaquel`, que es el
 * único que se recupera el MISMO día con la venta todavía viva. La captura manual de esos tres
 * sigue existiendo en la pantalla completa de faltantes — ver la nota de la fase.
 *
 * El reporte viaja además con `source: 'verificador'`, que es lo que le permite a Compras separar
 * «un cliente lo pidió y no había» de «alguien miró el precio». Sin esa marca las dos señales se
 * mezclan en la misma bandeja y la lista deja de medir lo que existe para medir.
 */
export const MOTIVO_AUTOMATICO: StockoutKind = 'agotado';

/** Lo que contesta el servidor sobre la existencia. `undefined` = la respuesta todavía viaja. */
export type VeredictoExistencia = 'hay_en_tienda' | 'sin_existencia' | 'no_medido' | undefined;

/**
 * ¿Este veredicto anota el faltante **sin preguntar**?
 *
 * Sólo `sin_existencia`. Los otros tres casos NO, y cada uno por su motivo:
 *
 *  · `hay_en_tienda` → no falta nada; era una consulta de precio y se contestó.
 *  · `no_medido`     → **no es cero: es que no se pudo leer** (ADR-056). Anotar solo un «no sé»
 *    inventa un faltante que a lo mejor está en el anaquel, y encima se lo manda a Compras como
 *    si fuera venta perdida. Ése es el único caso de la ventana que tiene un botón.
 *  · `undefined`     → la consulta sigue en el aire. Anotar acá sería anotar por adelantado y
 *    después tener que deshacerlo cuando llegue la respuesta.
 *
 * Es una función y no un `=== 'sin_existencia'` suelto en el componente para poder romperla a
 * propósito en una prueba: sin el caso negativo, «anota siempre» y «anota cuando toca» se ven
 * exactamente igual en pantalla.
 */
export function anotaSolo(veredicto: VeredictoExistencia): boolean {
  return veredicto === 'sin_existencia';
}

/**
 * Un tic del reloj de la ventana. Devuelve los milisegundos que quedan.
 *
 * En pausa **no descuenta**: el reloj se detiene mientras el mouse está encima. Sin eso, la
 * ventana se cierra justo cuando alguien estira la mano para tocar «Quitar», y entonces el botón
 * de deshacer es decorativo — que es peor que no tenerlo, porque promete una salida que no está.
 *
 * Nunca devuelve negativo: el ancho de la barra se calcula con esto y un negativo la dibujaría
 * al revés.
 */
export function pasoDeReloj(restanteMs: number, pausado: boolean, pasoMs: number): number {
  if (pausado) return restanteMs;
  return Math.max(0, restanteMs - pasoMs);
}

/** Qué tanto queda de la ventana, 0–100, para el ancho de la barra. */
export function porcentajeReloj(restanteMs: number, totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.max(0, Math.min(100, (restanteMs / totalMs) * 100));
}
