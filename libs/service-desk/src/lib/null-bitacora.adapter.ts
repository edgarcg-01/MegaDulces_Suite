import { Injectable } from '@nestjs/common';
import type { BitacoraPort } from '@megadulces/contracts';

/**
 * `[MS.2.8]` El espejo hacia la Bitácora de Sistemas, hoy APAGADO a propósito (P5: la unificación con task
 * llega después). Cada ticket ya ES una tarea de su asignado (`assigned_(to|by|at)`); esto sólo reserva el
 * lugar donde, el día que se unifique, un adaptador real escribe `external_refs.bitacora_folio` o sincroniza
 * `work_log` con `source = 'bitacora'`.
 */
@Injectable()
export class NullBitacoraAdapter implements BitacoraPort {
  async onTicketChanged(): Promise<void> {
    // intencionalmente vacío
  }
}
