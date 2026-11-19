import type { HrTalentEtapa } from './hr-talent.contract';

/**
 * Fase RH · `[RH.17.1]` — «Hoy» de Reclutamiento (`GET /hr/talent/today`): lo que RH tiene que hacer en el día, en
 * pendientes con verbo («Llamar a los nuevos»), en lugar de una tabla de 1,952 filas.
 *
 * Cada pendiente trae su TOTAL real y, como mucho, la CUOTA del día (los que se ven y se trabajan uno por uno). Así la
 * vista no abruma cuando hay rezago (medido el 19-nov: 846 activos fuera de su meta, casi todos traídos de Mega Talento
 * en el corte del 10-nov) y aun así dice cuántos son de verdad.
 */
export type HrHoyPendienteId = 'nuevos' | 'seguimiento' | 'expediente' | 'jefe';

/**
 * La nota EXACTA que deja el botón «No contestó»: la pantalla la escribe y la regla de «Hoy» la cuenta para saber cuántos
 * intentos van. Vive aquí para que las dos usen el mismo texto.
 */
export const HR_HOY_NOTA_NO_CONTESTO = 'No contestó';

/** Lo que hace falta para trabajar a un candidato en la tarjeta «uno por uno», sin abrir su ficha. */
export interface HrHoyCandidatoDto {
  id: string;
  full_name: string | null;
  phone: string | null;
  position_interest: string | null;
  city_branch: string | null;
  stage: HrTalentEtapa;
  created_at: string;
  last_activity_at: string | null;
  /** Por dónde entró: `web`, `whatsapp` o `null` (los que vinieron de Mega Talento). */
  origin: string | null;
  availability: string | null;
  commute_time: string | null;
  desired_salary: string | null;
  rehire_note: string | null;
  /** Llamadas registradas como «No contestó» desde su último cambio de etapa. */
  intentos_sin_respuesta: number;
  /** Casilleros obligatorios del expediente que le faltan (vacío = completo). */
  documentos_faltantes: string[];
  /** Lo último que pasó con esta persona (hasta 3), del más reciente al más viejo. */
  ultimos: Array<{ cuando: string; texto: string; quien: string | null }>;
}

export interface HrHoyPendienteDto {
  id: HrHoyPendienteId;
  /** Cuántos caen en este pendiente HOY (no sólo los de la cuota). */
  total: number;
  /** Los de la cuota del día, en el orden en que conviene atenderlos. */
  candidatos: HrHoyCandidatoDto[];
}

export interface HrHoyDto {
  generado_en: string;
  /** Cuántos se ven por pendiente (los demás siguen contados en `total`). */
  cuota: number;
  pendientes: HrHoyPendienteDto[];
  /** Activos sin movimiento en más de `dias_apartado` días: no son pendientes del día, se dicen aparte. */
  apartados: number;
  dias_apartado: number;
}
