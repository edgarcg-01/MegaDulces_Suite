/**
 * `[MS.2.5]` El SLA de la Mesa de Servicio. Funciones puras sobre `business-clock`. ADR-081 §4.
 *
 * ── Lo que se decidió, y por qué ─────────────────────────────────────────────────────────────
 * 1. **Primero MIDE, después escala.** `evaluarSla` sólo devuelve un veredicto; qué se hace con él
 *    (avisar, escalar) lo decide el servicio según `settings.escalation_enabled`, que arranca APAGADO.
 *    `cash-count-sla` se retiró (SM.34) por estar mal calibrado: un reloj sin calibrar enseña a ignorar
 *    la alarma.
 * 2. **El reloj de cada política es suyo.** `urgente` corre corrido (24/7); el resto sólo en horario hábil.
 * 3. **`en_espera` pausa el reloj.** Al reanudar, los plazos se empujan EXACTAMENTE lo que duró la pausa,
 *    medido en el reloj de la política (no en minutos de pared): una pausa de domingo no le regala un día
 *    hábil a nadie.
 * 4. **Pausado no vence.** Un ticket en espera no se evalúa: su reloj está detenido.
 */
import type { SdClock, SdPriority, SdStatus } from '@megadulces/contracts';
import { addClockMinutes, clockMinutesBetween, type BusinessCalendar } from './business-clock';

export interface PoliticaSla {
  priority: SdPriority;
  first_response_minutes: number;
  resolution_minutes: number;
  clock: SdClock;
}

export interface Plazos {
  first_response_due_at: Date;
  due_at: Date;
}

/** Los plazos de un ticket recién creado. */
export function plazosIniciales(createdAt: Date, p: PoliticaSla, cal: BusinessCalendar): Plazos {
  return {
    first_response_due_at: addClockMinutes(createdAt, p.first_response_minutes, p.clock, cal),
    due_at: addClockMinutes(createdAt, p.resolution_minutes, p.clock, cal),
  };
}

export interface EntradaReanudar {
  due_at: Date | null;
  first_response_due_at: Date | null;
  first_responded_at: Date | null;
  paused_at: Date;
}

export interface ResultadoReanudar {
  due_at: Date | null;
  first_response_due_at: Date | null;
  /** Minutos de la política que duró la pausa; se SUMAN a `requests.paused_minutes`. */
  paused_delta_minutes: number;
}

/**
 * Reanuda un ticket que estaba en espera. Empuja `due_at` lo que duró la pausa, y
 * `first_response_due_at` sólo si todavía no se le respondió (si ya se respondió, ese plazo ya no importa).
 */
export function reanudarTrasPausa(e: EntradaReanudar, now: Date, p: PoliticaSla, cal: BusinessCalendar): ResultadoReanudar {
  const delta = clockMinutesBetween(e.paused_at, now, p.clock, cal);
  return {
    due_at: e.due_at && delta > 0 ? addClockMinutes(e.due_at, delta, p.clock, cal) : e.due_at,
    first_response_due_at:
      e.first_response_due_at && !e.first_responded_at && delta > 0
        ? addClockMinutes(e.first_response_due_at, delta, p.clock, cal)
        : e.first_response_due_at,
    paused_delta_minutes: delta,
  };
}

/**
 * Plazos tras CAMBIAR la prioridad: se recalculan desde `created_at` con la política nueva, más las pausas
 * ya acumuladas. (Si el reloj de la política nueva es distinto del de la vieja, esas pausas se cuentan en
 * minutos de la política NUEVA: una aproximación declarada, no exacta, que sólo afecta a tickets que
 * cambian de reloj estando pausados alguna vez.)
 */
export function plazosTrasCambioDePrioridad(
  createdAt: Date,
  pausedMinutes: number,
  firstRespondedAt: Date | null,
  nueva: PoliticaSla,
  cal: BusinessCalendar,
): Plazos {
  return {
    first_response_due_at: firstRespondedAt
      ? addClockMinutes(createdAt, nueva.first_response_minutes, nueva.clock, cal)
      : addClockMinutes(createdAt, nueva.first_response_minutes + pausedMinutes, nueva.clock, cal),
    due_at: addClockMinutes(createdAt, nueva.resolution_minutes + pausedMinutes, nueva.clock, cal),
  };
}

export type EstadoSla = 'ok' | 'por_vencer' | 'vencido' | 'pausado' | 'terminado';

export interface EntradaEvaluar {
  status: SdStatus;
  due_at: Date | null;
  first_response_due_at: Date | null;
  first_responded_at: Date | null;
  paused_at: Date | null;
  sla_first_breached_at: Date | null;
  sla_resolution_breached_at: Date | null;
}

export interface VeredictoSla {
  estado: EstadoSla;
  /** Hay que AVISAR (primera vez) que el plazo de resolución está al `escalate_at_pct` o más. */
  avisar: boolean;
  /** Es la PRIMERA vez que se detecta que venció la primera respuesta: hay que marcarlo. */
  primera_respuesta_vencida: boolean;
  /** Es la PRIMERA vez que se detecta que venció la resolución: hay que marcarlo. */
  resolucion_vencida: boolean;
  /** Fracción del plazo de resolución consumida (1 = justo en el límite; 1.5 = 50 % pasado). `null` si no se puede medir. */
  usado: number | null;
}

/**
 * El veredicto de un ticket en `now`. NO muta nada y NO escala: sólo dice qué hay que marcar.
 * «Primera vez» se decide mirando los `sla_*_breached_at` que ya trae: idempotente entre corridas.
 */
export function evaluarSla(
  e: EntradaEvaluar,
  now: Date,
  p: PoliticaSla,
  cal: BusinessCalendar,
  escalatePct: number,
): VeredictoSla {
  const nada: VeredictoSla = { estado: 'ok', avisar: false, primera_respuesta_vencida: false, resolucion_vencida: false, usado: null };

  if (e.status === 'resuelto' || e.status === 'cerrado' || e.status === 'cancelado') return { ...nada, estado: 'terminado' };
  if (e.paused_at) return { ...nada, estado: 'pausado' };
  if (!e.due_at) return nada; // sin plazo no se puede medir: se dice (usado = null), no se inventa un «ok»

  const total = p.resolution_minutes;
  let usado: number;
  if (now.getTime() < e.due_at.getTime()) {
    usado = 1 - clockMinutesBetween(now, e.due_at, p.clock, cal) / total;
  } else {
    usado = 1 + clockMinutesBetween(e.due_at, now, p.clock, cal) / total;
  }

  const vencidaPrimera =
    !e.first_responded_at && !!e.first_response_due_at && now.getTime() > e.first_response_due_at.getTime();
  const vencida = now.getTime() > e.due_at.getTime();
  const alUmbral = usado >= escalatePct / 100;

  return {
    estado: vencida ? 'vencido' : alUmbral ? 'por_vencer' : 'ok',
    avisar: alUmbral && !vencida && !e.sla_resolution_breached_at,
    primera_respuesta_vencida: vencidaPrimera && !e.sla_first_breached_at,
    resolucion_vencida: vencida && !e.sla_resolution_breached_at,
    usado: Math.round(usado * 1000) / 1000,
  };
}
