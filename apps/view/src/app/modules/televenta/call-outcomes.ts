/**
 * Resultados de una llamada de telemarketing — UNA sola definición para el módulo.
 *
 * Los valores son los que acepta `POST /commercial/televenta/calls` (`LogCallDto.outcome`).
 * ⚠️ Hasta el 2026-10-21 el tablero tenía su propio mapa con claves que el backend nunca manda
 * (`pedido_tomado`, `no_contesto`…): el día que se capturara una llamada, una venta se habría
 * pintado como «sale» en crudo y en amarillo. La ficha del cliente tenía el mapa correcto; dos
 * copias del mismo vocabulario divergieron sin que nada lo notara.
 */
import type { CallOutcome } from './televenta.service';

export type CallOutcomeSeverity = 'success' | 'danger' | 'warn' | 'info' | 'secondary';

export interface CallOutcomeOption {
  label: string;
  value: CallOutcome;
  severity: CallOutcomeSeverity;
}

/** `Record` sobre la unión: si el backend suma un resultado, esto deja de compilar. */
const POR_VALOR: Record<CallOutcome, Omit<CallOutcomeOption, 'value'>> = {
  sale: { label: 'Venta confirmada', severity: 'success' },
  no_sale: { label: 'No vendió', severity: 'danger' },
  callback_scheduled: { label: 'Llamar después (callback)', severity: 'warn' },
  no_answer: { label: 'No contestó', severity: 'info' },
  wrong_contact: { label: 'Contacto equivocado', severity: 'secondary' },
  other: { label: 'Otro', severity: 'secondary' },
};

/** En el orden del selector de la ficha del cliente. */
export const CALL_OUTCOMES: CallOutcomeOption[] = (Object.keys(POR_VALOR) as CallOutcome[])
  .map((value) => ({ value, ...POR_VALOR[value] }));

/** Un valor desconocido se muestra tal cual y en neutro: no se le inventa significado. */
export function callOutcomeLabel(value: string): string {
  return POR_VALOR[value as CallOutcome]?.label ?? value;
}

export function callOutcomeSeverity(value: string): CallOutcomeSeverity {
  return POR_VALOR[value as CallOutcome]?.severity ?? 'secondary';
}
