/**
 * La máquina de estados del ticket: QUIÉN puede mover qué. La base ya impide los estados incoherentes
 * (11 CHECK); esto protege el proceso de una persona.
 */
import { SD_STATUSES, type SdActor, type SdStatus } from '@megadulces/contracts';
import { efectosDe, esFinal, exigeAsignado, motivoDeCierre, puedeTransicionar, transicionesPosibles, TRANSICIONES } from './request-state';

const ACTORES: SdActor[] = ['requester', 'agent', 'coordinator', 'system'];

describe('puedeTransicionar — el camino feliz', () => {
  it.each<[SdStatus, SdStatus, SdActor]>([
    ['nuevo', 'asignado', 'agent'],
    ['asignado', 'en_proceso', 'agent'],
    ['en_proceso', 'resuelto', 'agent'],
    ['resuelto', 'cerrado', 'requester'],
    ['en_proceso', 'en_espera', 'agent'],
    ['en_espera', 'en_proceso', 'agent'],
    ['resuelto', 'en_proceso', 'requester'], // reabrir
    ['nuevo', 'cancelado', 'requester'],
    ['resuelto', 'cerrado', 'system'], // auto-cierre
  ])('%s → %s lo puede hacer %s', (from, to, actor) => {
    expect(puedeTransicionar(from, to, actor)).toBe(true);
  });
});

describe('puedeTransicionar — lo que NO se puede', () => {
  it('⭐ el solicitante no asigna, no inicia ni resuelve su propio ticket', () => {
    expect(puedeTransicionar('nuevo', 'asignado', 'requester')).toBe(false);
    expect(puedeTransicionar('asignado', 'en_proceso', 'requester')).toBe(false);
    expect(puedeTransicionar('en_proceso', 'resuelto', 'requester')).toBe(false);
  });
  it('⭐ quien resuelve NO cierra: cerrar es del solicitante, de coordinación o del sistema, no del agente', () => {
    expect(puedeTransicionar('resuelto', 'cerrado', 'agent')).toBe(false);
  });
  it('un ticket en proceso sólo lo cancela coordinación (no el solicitante ni el agente)', () => {
    expect(puedeTransicionar('en_proceso', 'cancelado', 'coordinator')).toBe(true);
    expect(puedeTransicionar('en_proceso', 'cancelado', 'requester')).toBe(false);
    expect(puedeTransicionar('en_proceso', 'cancelado', 'agent')).toBe(false);
  });
  it('no se salta etapas: nuevo no pasa directo a resuelto ni a en_proceso', () => {
    for (const actor of ACTORES) {
      expect(puedeTransicionar('nuevo', 'resuelto', actor)).toBe(false);
      expect(puedeTransicionar('nuevo', 'en_proceso', actor)).toBe(false);
    }
  });
  it('⭐ cerrado y cancelado son FINALES: nadie los mueve', () => {
    for (const from of ['cerrado', 'cancelado'] as const) {
      expect(esFinal(from)).toBe(true);
      for (const to of SD_STATUSES) for (const actor of ACTORES) expect(puedeTransicionar(from, to, actor)).toBe(false);
    }
  });
  it('desasignar (asignado → nuevo) es sólo de coordinación', () => {
    expect(puedeTransicionar('asignado', 'nuevo', 'coordinator')).toBe(true);
    expect(puedeTransicionar('asignado', 'nuevo', 'agent')).toBe(false);
  });
  it('un estado sobre sí mismo no es una transición', () => {
    for (const s of SD_STATUSES) for (const actor of ACTORES) expect(puedeTransicionar(s, s, actor)).toBe(false);
  });
});

describe('la tabla es coherente', () => {
  it('todo destino de la tabla es un estado válido de la base', () => {
    for (const from of SD_STATUSES) {
      for (const to of Object.keys(TRANSICIONES[from])) expect(SD_STATUSES as readonly string[]).toContain(to);
    }
  });
  it('transicionesPosibles lista sólo lo que el actor puede', () => {
    expect(transicionesPosibles('nuevo', 'requester')).toEqual(['cancelado']);
    expect(transicionesPosibles('nuevo', 'agent')).toEqual(['asignado']);
    expect(transicionesPosibles('cerrado', 'coordinator')).toEqual([]);
    expect(transicionesPosibles('en_proceso', 'agent').sort()).toEqual(['en_espera', 'resuelto']);
  });
});

describe('efectosDe', () => {
  it('en_espera pausa; salir de en_espera reanuda', () => {
    expect(efectosDe('en_proceso', 'en_espera').pausa).toBe(true);
    expect(efectosDe('en_espera', 'en_proceso').reanuda).toBe(true);
    expect(efectosDe('en_espera', 'resuelto').reanuda).toBe(true);
    expect(efectosDe('nuevo', 'asignado').pausa).toBe(false);
  });
  it('resolver marca la resolución; reabrir la limpia', () => {
    expect(efectosDe('en_proceso', 'resuelto').resuelve).toBe(true);
    const r = efectosDe('resuelto', 'en_proceso');
    expect(r.reabre).toBe(true);
    expect(r.resuelve).toBe(false);
  });
  it('cerrar y cancelar marcan el cierre; volver a nuevo desasigna', () => {
    expect(efectosDe('resuelto', 'cerrado').cierra).toBe(true);
    expect(efectosDe('nuevo', 'cancelado').cierra).toBe(true);
    expect(efectosDe('asignado', 'nuevo').desasigna).toBe(true);
    expect(efectosDe('en_proceso', 'resuelto').cierra).toBe(false);
  });
  it('exigeAsignado coincide con el CHECK de la base (asignado y en_proceso)', () => {
    expect(SD_STATUSES.filter(exigeAsignado)).toEqual(['asignado', 'en_proceso']);
  });
});

describe('motivoDeCierre', () => {
  it('cancelar → cancelado; cerrar a mano → confirmado; cerrar el sistema → auto', () => {
    expect(motivoDeCierre('cancelado', 'requester')).toBe('cancelado');
    expect(motivoDeCierre('cerrado', 'requester')).toBe('confirmado');
    expect(motivoDeCierre('cerrado', 'coordinator')).toBe('confirmado');
    expect(motivoDeCierre('cerrado', 'system')).toBe('auto');
  });
});
