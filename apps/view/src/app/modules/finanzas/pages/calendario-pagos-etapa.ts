/**
 * `[PGP.114]` **En qué etapa está cada pago** — la regla de la bandeja de `/finanzas/calendario-pagos`.
 *
 * Edgar (2026-11-10): «haremos una a una» → cada pago avanza solo: se prepara, se autoriza, se paga,
 * se valida y va a Kepler por su cuenta (`[PGP.113]`: se autoriza el PAGO, no el día). La pantalla
 * entra por la etapa, no por el día.
 *
 * Una función pura para que la regla se pruebe sola y la pantalla no la reparta en plantillas.
 * Las reglas de «preparado» y de «cerrado en Kepler» NO se copian aquí: vienen de quien las decide
 * (`isPrepared` del backend, replicada en la pantalla; `cierreCompleto` del contrato).
 *
 * ⛔ Un pago PENDIENTE que Kepler ya saldó (Tesorería lo capturó a mano) es «pagado», no «por
 * preparar»: medido en prod el 2026-11-10, 56 de 173 pendientes ($9.8 M) estaban así, y contarlos
 * como trabajo por hacer inflaba la primera etapa en un tercio. Sólo si su día ya llegó: en un día
 * por venir, lo que Kepler ya pagó es «quítalo del día» (ocupa el tope de un día que se arma; `[PGP.96]`).
 */
import { cierreCompleto, type CierreKeplerPago } from '@megadulces/contracts';

export type EtapaPago = 'preparar' | 'autorizar' | 'pagar' | 'kepler' | 'pagado' | 'rebote';

/** El orden de la tira: el del circuito. «Rebotó» va al final y sólo se pinta si hay. */
export const ETAPAS: readonly EtapaPago[] = ['preparar', 'autorizar', 'pagar', 'kepler', 'pagado', 'rebote'];

export const ETAPA_NOMBRE: Record<EtapaPago, string> = {
  preparar: 'Por preparar',
  autorizar: 'Por autorizar',
  pagar: 'Por pagar',
  kepler: 'Por registrar en Kepler',
  pagado: 'Pagados',
  rebote: 'Rebotaron',
};

/** Lo mínimo que la regla lee de un pago. */
export interface PagoParaEtapa {
  status: string;
  payment_method: string | null;
  bank_account_id: string | null;
  destination_account_text: string | null;
  authorized_at?: string | null;
  /** `[PGP.113]` true también si su día se autorizó completo (regla vieja). Ausente = API anterior. */
  autorizado?: boolean;
  kepler_cierre: CierreKeplerPago | null;
  /** `[PGP.113]` El día del pago (AAAA-MM-DD). Ausente = API anterior: se toma el día que se está viendo. */
  lot_date?: string;
}

/** Misma regla que `isPrepared()` del backend: método, origen (salvo efectivo) y destino (transferencia). */
export function preparado(a: Pick<PagoParaEtapa, 'payment_method' | 'bank_account_id' | 'destination_account_text'>): boolean {
  if (!a.payment_method) return false;
  if (a.payment_method !== 'efectivo' && !a.bank_account_id) return false;
  if (a.payment_method === 'transferencia' && !(a.destination_account_text ?? '').trim()) return false;
  return true;
}

export function autorizado(a: Pick<PagoParaEtapa, 'autorizado' | 'authorized_at'>): boolean {
  return a.autorizado ?? !!a.authorized_at;
}

/** `[PGP.114]` Pendiente en la Suite, su día ya llegó y Kepler ya lo saldó: lo pagó Tesorería a mano. */
export function pagadoPorKepler(a: PagoParaEtapa, hoy: string, diaVisto?: string): boolean {
  const dia = a.lot_date ?? diaVisto ?? '';
  return a.status === 'pending' && !!dia && dia <= hoy && cierreCompleto(a.kepler_cierre);
}

export function etapaDelPago(a: PagoParaEtapa, hoy: string, diaVisto?: string): EtapaPago {
  if (a.status === 'failed') return 'rebote';
  if (a.status === 'executed') return cierreCompleto(a.kepler_cierre) ? 'pagado' : 'kepler';
  if (pagadoPorKepler(a, hoy, diaVisto)) return 'pagado';
  if (!preparado(a)) return 'preparar';
  if (!autorizado(a)) return 'autorizar';
  return 'pagar';
}

/**
 * La etapa con la que abre la pantalla: la primera del circuito que tiene trabajo; si la persona
 * autoriza y hay algo por autorizar, ésa (es lo único que sólo ella puede destrabar).
 */
export function etapaInicial(conteo: Readonly<Record<EtapaPago, number>>, puedeAutorizar: boolean): EtapaPago {
  if (puedeAutorizar && conteo.autorizar > 0) return 'autorizar';
  return (['preparar', 'autorizar', 'pagar', 'kepler', 'rebote'] as const).find((e) => conteo[e] > 0) ?? 'preparar';
}

/** Días completos entre el día del pago y hoy (positivo = ya pasó). */
export function diasDeAtraso(dia: string | null | undefined, hoy: string): number {
  if (!dia) return 0;
  return Math.round((Date.parse(`${hoy}T12:00:00Z`) - Date.parse(`${dia.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}
