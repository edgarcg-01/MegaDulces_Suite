/**
 * `[PGP.117]` **Lo que no se pagó se quita del Calendario, y queda la bitácora.**
 * Edgar, 2026-11-12: «después de una semana hay que quitar lo que no se haya pagado, pero dejar logs
 * de lo ocurrido».
 *
 * `[PGP.202]` → `[PGP.204]` **La semana se queda.** El 2026-11-23 se bajó a un día (pedido de Edgar: «cuando una
 * factura no se pagó y ya se pasó el día de pagos, quitémosla automáticamente pero dejemos el registro») y el mismo
 * día se regresó, con la medición: de 225 pagos que SÍ se pagaron (1-oct a 20-nov), 4 salieron del banco por OTRO
 * importe que el programado (dos parciales de ~$1M y ~$425k, uno junto con otra factura en un cheque, uno en efectivo
 * de Caja General) y Tesorería los capturó en Kepler 3 a 6 días después de su día: ningún testigo los veía. Con un
 * día se habrían liberado los 4 (y sus facturas, ofrecido otra vez); con 3, 2; con 6 o 7, ninguno. En 1 de cada 3
 * pagos Tesorería captura en Kepler 5 o 6 días después. Lo que se quita al día siguiente es la VISTA del pago
 * vencido (`[PGP.205]`), no el apartado de sus facturas.
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 * Un pago pendiente APARTA el saldo de sus facturas: mientras siga `pending`, la lista de deuda no
 * las ofrece. Si su día pasó y nadie lo pagó, esas facturas quedan escondidas sin fecha de regreso
 * (`[PGP.48]` sólo lo avisa). Medido el 2026-11-12: 76 pagos pendientes con su día hace 7 días o más.
 *
 * ── Qué cuenta como «pagado» (conservador: ante la duda, se queda) ─────────────────────────────
 * Hay dos testigos y basta UNO para conservar el pago:
 *  1. **Kepler.** Si alguna factura del pago se saldó o recibió un abono desde que se programó
 *     (`cierreDelPago`, `[PGP.94]`), se conserva. Si alguna factura no viene de Kepler, no hay con
 *     qué medirla y también se conserva: no se libera lo que no se puede comprobar.
 *  2. **El banco.** Si salió del banco un importe igual al del pago (±$1) desde 3 días antes de su
 *     día, se conserva aunque Kepler no diga nada. Es el caso del 5-nov: el dinero salió y Kepler no
 *     lo tenía; liberarlo habría vuelto a ofrecer las facturas, y pagarlas otra vez. Coincidir por
 *     importe tiene ruido (placebo +$100: 0 de 76 medidos), pero el ruido sólo puede CONSERVAR un
 *     pago, nunca liberarlo.
 * Un pago que alguien ligó a mano a un documento de Kepler o a un movimiento del banco se conserva.
 *
 * ⛔ `[PGP.173]` **Un cheque emitido no se libera nunca.** Kepler registra el cheque hasta que se cobra (28 de 28
 * medidos, 2026-11-19) y el banco no tiene salida mientras el proveedor no lo deposite: para los dos testigos, un
 * cheque ya entregado y sin depositar es «nadie lo pagó». Liberarlo vuelve a ofrecer sus facturas y, si después el
 * proveedor llama y Caja General lo libera en el banco, se pagan dos veces. Pasó el 17-nov con el 5383 (cobrado el
 * 11, lo regresó `[PGP.149]`). El cheque sale del Calendario cobrándose o cancelándose, no por el reloj.
 *
 * ⛔ Liberar NO borra: el pago pasa a `cancelled` con su nota, sus renglones se quedan, y la
 * bitácora (`finance.payment_allocation_history`) guarda lo que se midió en ese momento.
 */
import type { CierreKeplerPago } from './cierre-kepler.contract';

/**
 * Días después del día programado a partir de los cuales un pago sin testigo se libera. ⛔ `[PGP.204]` No bajarlo
 * sin un testigo que vea el pago por OTRO importe (parcial, junto con otra factura, efectivo): con 1 día se habrían
 * liberado 4 pagos ya pagados de 225 medidos; con 6 o 7, ninguno (Tesorería captura en Kepler hasta 6 días después).
 */
export const DIAS_PARA_LIBERAR = 7;
/** Holgura del banco: el dinero puede salir unos días antes del día programado. */
export const DIAS_ANTES_BANCO = 3;
/** Tolerancia del importe del banco contra el del pago. */
export const TOLERANCIA_BANCO = 1;
/** El evento que escribe la bitácora al liberar. */
export const EVENTO_LIBERADO = 'liberado_por_vencimiento';

export interface PagoPendienteVencido {
  /** El día al que estaba programado (`YYYY-MM-DD`). */
  lotDate: string;
  /** Lo que dice Kepler de sus facturas; `null` si no se pudo leer. */
  cierre: CierreKeplerPago | null;
  /** ¿Salió del banco el mismo importe (±$1) desde 3 días antes de su día? `null` = no se pudo medir. */
  salidaDeBanco: boolean | null;
  /** Ligado a mano a un pago de Kepler o a un movimiento del banco. */
  ligado: boolean;
  /** `[PGP.173]` El pago es con cheque y ya tiene su número: el cheque existe en papel (y casi siempre ya se entregó). */
  chequeEmitido: boolean;
}

export type MotivoConservar =
  | 'ligado' | 'cheque_emitido' | 'kepler_sin_medir' | 'kepler_pagado' | 'kepler_en_parte' | 'banco' | 'banco_sin_medir';

export type DecisionVencido =
  | { accion: 'esperar'; dias: number }
  | { accion: 'liberar'; dias: number }
  | { accion: 'conservar'; dias: number; motivo: MotivoConservar };

/** Días de `desde` a `hasta` (fechas `YYYY-MM-DD`), a mediodía UTC para no cruzar zonas. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta.slice(0, 10)}T12:00:00Z`) - Date.parse(`${desde.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}

/** La regla. Pura: la llama el servicio con lo que leyó de Kepler y del banco. */
export function decidirVencido(p: PagoPendienteVencido, hoy: string): DecisionVencido {
  const dias = diasEntre(p.lotDate, hoy);
  if (!Number.isFinite(dias) || dias < DIAS_PARA_LIBERAR) return { accion: 'esperar', dias };
  if (p.ligado) return { accion: 'conservar', dias, motivo: 'ligado' };
  // `[PGP.173]` Antes que Kepler y el banco: para un cheque en tránsito los dos dicen «no se pagó», y es falso.
  if (p.chequeEmitido) return { accion: 'conservar', dias, motivo: 'cheque_emitido' };
  const c = p.cierre;
  // Una sola factura sin medir basta para no liberar: lo que no se comprueba no se suelta.
  if (!c || c.estado === 'sin_medir' || c.facturas.sin_medir > 0) return { accion: 'conservar', dias, motivo: 'kepler_sin_medir' };
  if (c.estado === 'pagado' || c.estado === 'saldado_sin_dinero') return { accion: 'conservar', dias, motivo: 'kepler_pagado' };
  if (c.estado !== 'sin_pagar') return { accion: 'conservar', dias, motivo: 'kepler_en_parte' };
  if (p.salidaDeBanco === null) return { accion: 'conservar', dias, motivo: 'banco_sin_medir' };
  if (p.salidaDeBanco) return { accion: 'conservar', dias, motivo: 'banco' };
  return { accion: 'liberar', dias };
}

/** La nota que se agrega al pago liberado (la evidencia completa va en la bitácora). */
export function notaLiberado(hoy: string, dias: number): string {
  return `[liberado ${hoy}] ${dias === 1 ? '1 día' : `${dias} días`} después de su día sin pagarse: Kepler no registra abono a sus facturas desde que se programó y el banco no tiene una salida por ese importe. Las facturas vuelven a quedar disponibles.`;
}

/** Lo que devuelve una pasada: cuántos se liberaron y por qué se conservó el resto. */
export interface ResultadoPagosVencidos {
  hoy: string;
  revisados: number;
  liberados: number;
  monto_liberado: number;
  /** Los ids liberados, para que el log diga cuáles. */
  ids_liberados: string[];
  conservados: Record<MotivoConservar, number>;
  /** `[PGP.149]` Liberados antes que sí habían salido del banco y regresaron a pendientes. */
  regresados?: number;
  ids_regresados?: string[];
  /** `[PGP.149]` Liberados que salieron del banco pero sus facturas ya están en otro pago: los revisa una persona. */
  reprogramados_tras_liberar?: string[];
}
