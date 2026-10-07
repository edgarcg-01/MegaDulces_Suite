/**
 * `[MS.2.3]` La máquina de estados del ticket. Función pura. ADR-081.
 *
 * La BASE ya impide los estados incoherentes (asignado sin asignado, en_espera sin reloj pausado,
 * cerrado sin motivo: `servicedesk.requests`, 11 CHECK). Esto es la otra mitad: QUIÉN puede mover el
 * ticket de dónde a dónde. Los dos niveles son distintos a propósito: la base protege el dato de un bug;
 * esto protege el proceso de una persona.
 *
 *   nuevo ──asignar──▶ asignado ──iniciar──▶ en_proceso ──resolver──▶ resuelto ──confirmar──▶ cerrado
 *     │                   │  ▲                  │  ▲                      │
 *     │                   └──┼── en_espera ◀────┘  └────── reabrir ───────┘
 *     └────────────── cancelado (solicitante o coordinación)
 *
 * · `en_espera` pausa el reloj del SLA (espera al solicitante o a un tercero).
 * · `resuelto` lo confirma el SOLICITANTE (o se cierra solo a los N días): quien resuelve no cierra.
 * · `cerrado` y `cancelado` son finales.
 */
import type { SdActor, SdStatus } from '@megadulces/contracts';

const AGENTE: readonly SdActor[] = ['agent', 'coordinator'];

/** `from → to → quién puede`. Lo que no está aquí NO se puede. */
export const TRANSICIONES: Readonly<Record<SdStatus, Readonly<Partial<Record<SdStatus, readonly SdActor[]>>>>> = {
  nuevo: {
    asignado: AGENTE,
    cancelado: ['requester', 'coordinator'],
  },
  asignado: {
    en_proceso: AGENTE,
    en_espera: AGENTE,
    nuevo: ['coordinator'], // desasignar
    cancelado: ['requester', 'coordinator'],
  },
  en_proceso: {
    en_espera: AGENTE,
    resuelto: AGENTE,
    cancelado: ['coordinator'],
  },
  en_espera: {
    // El solicitante que responde reanuda el ticket (lo hace el servicio al recibir su comentario).
    en_proceso: ['agent', 'coordinator', 'requester', 'system'],
    resuelto: AGENTE,
    cancelado: ['requester', 'coordinator'],
  },
  resuelto: {
    cerrado: ['requester', 'coordinator', 'system'],
    en_proceso: ['requester', 'agent', 'coordinator'], // reabrir
  },
  cerrado: {},
  cancelado: {},
};

export function puedeTransicionar(from: SdStatus, to: SdStatus, actor: SdActor): boolean {
  return TRANSICIONES[from]?.[to]?.includes(actor) ?? false;
}

/** Los estados a los que `actor` puede llevar un ticket que hoy está en `from`. */
export function transicionesPosibles(from: SdStatus, actor: SdActor): SdStatus[] {
  const destinos = TRANSICIONES[from] ?? {};
  return (Object.keys(destinos) as SdStatus[]).filter((to) => destinos[to]?.includes(actor));
}

export function esFinal(status: SdStatus): boolean {
  return status === 'cerrado' || status === 'cancelado';
}

/** Estados que exigen que el ticket tenga a alguien asignado (lo vigila también un CHECK de la base). */
export function exigeAsignado(status: SdStatus): boolean {
  return status === 'asignado' || status === 'en_proceso';
}

/** Lo que cada transición provoca además del cambio de estado. El servicio lo aplica en la misma transacción. */
export interface EfectosDeTransicion {
  /** Pone `paused_at`: el reloj del SLA se detiene. */
  pausa: boolean;
  /** Quita `paused_at` y empuja los plazos lo que duró la pausa. */
  reanuda: boolean;
  /** Pone `resolved_at`/`resolved_by`. */
  resuelve: boolean;
  /** Vuelve de `resuelto` a trabajo vivo: limpia `resolved_at` y suma a `reopened_count`. */
  reabre: boolean;
  /** Pone `closed_at`/`close_reason`. */
  cierra: boolean;
  /** Quita al asignado (volver a `nuevo`). */
  desasigna: boolean;
}

export function efectosDe(from: SdStatus, to: SdStatus): EfectosDeTransicion {
  return {
    pausa: to === 'en_espera',
    reanuda: from === 'en_espera' && to !== 'en_espera',
    resuelve: to === 'resuelto',
    reabre: from === 'resuelto' && to === 'en_proceso',
    cierra: to === 'cerrado' || to === 'cancelado',
    desasigna: to === 'nuevo',
  };
}

/** El motivo de cierre que corresponde a cada estado final y actor. */
export function motivoDeCierre(to: 'cerrado' | 'cancelado', actor: SdActor): 'confirmado' | 'auto' | 'cancelado' {
  if (to === 'cancelado') return 'cancelado';
  return actor === 'system' ? 'auto' : 'confirmado';
}
