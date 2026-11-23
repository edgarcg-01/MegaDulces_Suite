/**
 * Fase RH · `[RH.15.10]` — Los límites LEGALES de la semana de trabajo, año por año.
 *
 * Decreto que reforma la LFT en materia de reducción de la jornada laboral (DOF, 1-may-2026):
 *   · Art. 59 + transitorio 2.º: jornada ordinaria máxima por semana, desde el 1 de enero de cada año:
 *     48 h (2026) · 46 h (2027) · 44 h (2028) · 42 h (2029) · 40 h (2030 en adelante).
 *   · Arts. 66 / 68 + transitorio 4.º: horas extra por semana, desde el 1 de enero de cada año:
 *     9 h (2026 y 2027) · 10 h (2028) · 11 h (2029) · 12 h (2030 en adelante).
 *     Las que pasan de ese tope se pagan al TRIPLE (art. 68).
 *   · Transitorio 7.º: la reducción no baja sueldos ni prestaciones.
 *
 * Esto NO reemplaza las horas extra que ya calcula la Suite contra el horario de cada persona (eso es política de la
 * empresa, `banco-horas-extra.ts`): mide la semana contra la LEY, que es lo que revisa una inspección. Antes de 2026
 * se usan los valores de 2026 (48 h y 9 h, la LFT anterior).
 *
 * ⚠️ Mide la semana tal como viene (jueves a miércoles). Una semana cortada por el rango que se pidió trae menos
 * horas, así que nunca acusa de más: puede dejar de ver un exceso, no inventarlo.
 */

/** Año → [jornada máxima semanal, horas extra máximas por semana], en horas. */
const TABLA: ReadonlyArray<readonly [number, number, number]> = [
  [2026, 48, 9],
  [2027, 46, 9],
  [2028, 44, 10],
  [2029, 42, 11],
  [2030, 40, 12],
];

export interface LimitesLegales {
  anio: number;
  /** Jornada ordinaria máxima de la semana, en minutos. */
  jornadaMaxMin: number;
  /** Horas extra que se pueden trabajar en la semana antes de pagarse al triple, en minutos. */
  extraMaxMin: number;
}

/** Los límites que rigen en una fecha ('YYYY-MM-DD'): los del año en que cae. */
export function limitesLegales(fecha: string): LimitesLegales {
  const anio = Number(String(fecha).slice(0, 4)) || 2026;
  let fila = TABLA[0];
  for (const f of TABLA) if (anio >= f[0]) fila = f;
  return { anio, jornadaMaxMin: fila[1] * 60, extraMaxMin: fila[2] * 60 };
}

export interface SemanaLegal extends LimitesLegales {
  /** Minutos trabajados por encima de la jornada máxima legal (0 si no se pasó). */
  excedenteMin: number;
  /** De esos, los que pasan del tope de horas extra: se pagan al triple (art. 68). */
  triplesMin: number;
}

/**
 * Una semana contra la ley. `inicio` decide el año: la semana que cruza el 1 de enero se mide con los límites del año
 * en que EMPIEZA (lo que dice el transitorio es «a partir del 1 de enero»; una semana que lo cruza tiene la mayor
 * parte de sus días antes o después, y empezar por el inicio es la regla que se puede explicar).
 */
export function semanaContraLey(inicio: string, minutosTrabajados: number): SemanaLegal {
  const l = limitesLegales(inicio);
  const excedenteMin = Math.max(0, Math.round(minutosTrabajados) - l.jornadaMaxMin);
  return { ...l, excedenteMin, triplesMin: Math.max(0, excedenteMin - l.extraMaxMin) };
}
