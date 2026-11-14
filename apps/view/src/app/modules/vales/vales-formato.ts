import type { EstadoVale, PapelFirma } from '@megadulces/contracts';

/** `[MDT.3.4]` Una sola forma de decir cada estado y cada papel de firma del vale de servicio. */

const ESTADO: Record<EstadoVale, string> = {
  open: 'Abierto', in_progress: 'En proceso', completed: 'Completado', cancelled: 'Cancelado',
};
export const etiquetaEstadoVale = (e: EstadoVale): string => ESTADO[e] ?? e;

/** Abierto = espera a alguien (ámbar) · en proceso = alguien lo atiende (info) · completado (verde) · cancelado (gris). */
export function severidadEstadoVale(e: EstadoVale): 'warn' | 'info' | 'success' | 'secondary' {
  return e === 'open' ? 'warn' : e === 'in_progress' ? 'info' : e === 'completed' ? 'success' : 'secondary';
}

export const PAPEL: Record<PapelFirma, string> = {
  performed: 'Realizado por', reviewed: 'Revisado por', received: 'Recibido / seguimiento por',
};

const EVENTO: Record<string, string> = {
  created: 'Lo levantó', assigned: 'Lo asignó', taken: 'Lo tomó', updated: 'Capturó el trabajo', completed: 'Lo completó',
  cancelled: 'Lo canceló', reopened: 'Lo reabrió', signed: 'Agregó una firma', signature_removed: 'Quitó una firma',
};
export const etiquetaEvento = (k: string): string => EVENTO[k] ?? k;

/** Días completos desde que se levantó (para «hace N días» en la lista). */
export function diasDesde(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/** Fecha y hora legibles en hora de México. */
export function cuandoMx(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' });
}
