import { ServiceUnavailableException } from '@nestjs/common';

/**
 * FD.0 — Error tipado del PAC. Antes el adapter aplastaba el sobre estructurado del
 * PAC (código SAT, messageDetail, JSON crudo) a un solo string y lo tiraba como
 * ServiceUnavailableException. `PacError` conserva esos campos para que la captura
 * (fiscal.emission_errors) y el tablero de Diagnóstico puedan traducir el código a
 * lenguaje humano y proponer la solución.
 *
 * Extiende ServiceUnavailableException para NO cambiar el comportamiento HTTP ni
 * romper a los llamadores que ya leen `e.message` (el resumen).
 */
export type PacOperation = 'stamp' | 'cancel' | 'status' | 'auth' | 'pdf';

export interface PacErrorInit {
  httpStatus?: number;
  code?: string;
  message?: string;
  messageDetail?: string;
  raw?: unknown;
  summary?: string;
}

export class PacError extends ServiceUnavailableException {
  readonly operation: PacOperation;
  readonly httpStatus?: number;
  readonly pacCode?: string;
  readonly pacMessage?: string;
  readonly pacMessageDetail?: string;
  readonly pacRaw?: unknown;

  constructor(operation: PacOperation, init: PacErrorInit) {
    const label = operation === 'stamp' ? 'el timbrado'
      : operation === 'cancel' ? 'la cancelación'
      : operation === 'status' ? 'la consulta de estatus'
      : operation;
    const summary = init.summary
      || `El PAC rechazó ${label} (${init.httpStatus ?? '?'})${init.code ? ` [${init.code}]` : ''}: ${init.message || 'error'}`;
    super(summary);
    this.name = 'PacError';
    this.operation = operation;
    this.httpStatus = init.httpStatus;
    this.pacCode = init.code;
    this.pacMessage = init.message;
    this.pacMessageDetail = init.messageDetail;
    this.pacRaw = init.raw;
  }
}

/**
 * Extrae el código SAT/PAC de los textos del error. Cubre los formatos comunes de
 * SW/SAT: `CFDI40102`, `CRP20016`, `LCO0102`, y códigos SAT de 3 dígitos (301..308,
 * 401). Devuelve el primero que encuentra (mensaje primero, luego el detalle).
 */
export function extractPacCode(message?: string, messageDetail?: string): string | undefined {
  const hay = `${message || ''}\n${messageDetail || ''}`;
  const m =
    hay.match(/\b(CFDI\d{5})\b/i) ||
    hay.match(/\b(CRP\d{4,5})\b/i) ||
    hay.match(/\b(LCO\d{3,4})\b/i) ||
    hay.match(/\b(NOM\d{3,5})\b/i) ||
    hay.match(/\b(30[1-8]|40[1-9])\b/); // códigos SAT de estatus de timbrado/cancelación
  return m ? m[1].toUpperCase() : undefined;
}
