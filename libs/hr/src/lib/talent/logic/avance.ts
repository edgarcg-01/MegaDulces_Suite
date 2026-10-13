/**
 * Fase RH · `[RH.2.4]` — los MÍNIMOS para que un candidato avance de etapa. Copia de
 * `mega-talento-90/src/app/core/models/requisitos-avance.model.ts`. Pura (se prueba en CI).
 *
 * Por qué existe (Mega Talento, 30-jul-2026): al auditar las fases adelantadas salieron 20 candidatos que no debían
 * estar ahí —sin CV, con el registro del bot a medias, pidiendo un puesto cerrado, y una persona con un familiar en la
 * empresa sin revisar—. La causa era el AUTOAVANCE del cuestionario: la única condición era el puntaje.
 *
 * La asimetría es deliberada: al SISTEMA se le prohíbe avanzar solo si no cumple; a RH sólo se le advierte (puede tener
 * razones que el sistema no conoce: trajo el CV impreso, el puesto se abre la semana que entra).
 */
import { tieneCv } from './etapas';

export interface CandidatoParaAvance {
  stage: string | null;
  cv_url?: string | null;
  documents?: unknown;
  bot_state?: string | null;
  position_interest?: string | null;
  portal_data?: Record<string, unknown> | null;
}

export interface RevisionAvance { ok: boolean; motivos: string[] }

const norm = (s: string) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** ¿Cumple lo mínimo? `puestosAbiertos`: si se pasa, también valida que su puesto siga abierto. */
export function revisarAvance(c: CandidatoParaAvance | null | undefined, puestosAbiertos?: string[]): RevisionAvance {
  if (!c) return { ok: false, motivos: ['No hay datos del candidato.'] };
  const motivos: string[] = [];
  if (!tieneCv(c)) motivos.push('No tiene CV en el expediente.');
  const bot = String(c.bot_state ?? '');
  if (bot.startsWith('esperando_')) motivos.push(`Su registro está incompleto: falta ${bot.replace('esperando_', '').replace(/_/g, ' ')}.`);
  // Banderas graves del dictamen del bot: son políticas de la empresa (un familiar en la empresa exige revisar el
  // conflicto de interés ANTES de seguirlo evaluando). `sin_cv` ya se cuenta arriba.
  const dictamen = (c.portal_data?.['dictamen'] ?? null) as { reglas?: Array<{ gravedad?: string; codigo?: string; texto?: string }> } | null;
  for (const g of (dictamen?.reglas ?? []).filter((r) => r?.gravedad === 'alta' && r?.codigo !== 'sin_cv')) {
    motivos.push(g.texto || `Bandera grave: ${g.codigo}`);
  }
  if (Array.isArray(puestosAbiertos) && puestosAbiertos.length && c.position_interest) {
    if (!puestosAbiertos.some((p) => norm(p) === norm(String(c.position_interest)))) motivos.push(`El puesto "${c.position_interest}" no está abierto hoy.`);
  }
  return { ok: motivos.length === 0, motivos };
}

/**
 * ¿El cuestionario de liderazgo puede mover SOLO a este candidato a Aptitudes? Sólo hacia adelante y sólo desde Filtro
 * Inicial o Entrevista Orientación (la compuerta 2 → 3 de Mega Talento); a quien va más adelante o ya se resolvió no se
 * le toca. Y además, los mínimos.
 */
export const ETAPAS_QUE_AVANZA_EL_CUESTIONARIO = [null, 'filtro_inicial', 'nuevo', 'entrevista_rh'] as const;

export function puedeAvanzarPorCuestionario(c: CandidatoParaAvance, puestosAbiertos?: string[]): RevisionAvance {
  if (!(ETAPAS_QUE_AVANZA_EL_CUESTIONARIO as readonly (string | null)[]).includes(c.stage ?? null)) {
    return { ok: false, motivos: ['Ya va más adelante en el proceso (o ya se resolvió).'] };
  }
  return revisarAvance(c, puestosAbiertos);
}
