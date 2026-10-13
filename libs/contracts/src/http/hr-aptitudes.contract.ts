/**
 * Fase RH · `[RH.2.4]` — la EVALUACIÓN DE APTITUDES (entrevista técnica por competencias, formato STAR) que llena el jefe
 * que entrevista, por liga. Copia de `mega-talento-90/src/app/core/models/proceso.model.ts` (formato STAR): 3 niveles
 * con 5 / 8 / 10 puntos, total sobre 10 × competencias, bandas por porcentaje. Vive en el contrato porque lo usan los
 * dos lados: la página le muestra al jefe el puntaje mientras califica, y el servidor decide con él.
 *
 * El catálogo de hojas por puesto NO está aquí: vive sólo en el servidor (`libs/hr/.../data/competencias-puesto.ts`) y
 * la hoja se congela en el candidato al generar la liga.
 */

export type HrNivelStar = 'inferior' | 'cumple' | 'supera';

export const HR_NIVELES_STAR: ReadonlyArray<{ id: HrNivelStar; label: string; puntos: number }> = [
  { id: 'inferior', label: 'Inferior a lo esperado', puntos: 5 },
  { id: 'cumple', label: 'Cumple lo esperado', puntos: 8 },
  { id: 'supera', label: 'Supera lo esperado', puntos: 10 },
];

/** Una competencia con su pregunta STAR y las 3 anclas que guían la calificación. */
export interface HrCompetenciaStar {
  key: string;
  categoria: string;
  parametro: string;
  preguntaStar: string;
  anclas: { inferior: string; cumple: string; supera: string };
}

export type HrBandaStar = 'Altamente Recomendable' | 'Recomendable' | 'Recomendable con Reservas' | 'No Recomendable';

/** Umbrales por porcentaje (135/150 = 90%, 115/150 ≈ 76.7%, 90/150 = 60%), para hojas de distinto tamaño. */
export function hrBandaStar(pct: number): HrBandaStar {
  if (pct >= 90) return 'Altamente Recomendable';
  if (pct >= 76.667) return 'Recomendable';
  if (pct >= 60) return 'Recomendable con Reservas';
  return 'No Recomendable';
}

/** «Aprobado» = al menos Recomendable (la compuerta 3 → 4 de Mega Talento). */
export const HR_APTITUDES_APROBADO_PCT = 76.667;

export interface HrResultadoStar {
  puntaje: number;
  max: number;
  pct: number;
  calificadas: number;
  total: number;
  banda: HrBandaStar;
  completa: boolean;
}

export function hrPuntajeStar(rubrica: Record<string, HrNivelStar> | null | undefined, competencias: readonly HrCompetenciaStar[]): HrResultadoStar {
  const total = competencias.length;
  const max = total * 10;
  let puntaje = 0, calificadas = 0;
  for (const c of competencias) {
    const cfg = HR_NIVELES_STAR.find((n) => n.id === rubrica?.[c.key]);
    if (!cfg) continue;
    puntaje += cfg.puntos;
    calificadas++;
  }
  const pct = max > 0 ? Math.round((puntaje / max) * 100) : 0;
  return { puntaje, max, pct, calificadas, total, banda: hrBandaStar(pct), completa: total > 0 && calificadas === total };
}

/** Lo que guarda el jefe al terminar (además de la rúbrica). */
export interface HrAptitudesEvaluacion {
  rubrica: Record<string, HrNivelStar>;
  evaluador: string;
  cargo_evaluador?: string | null;
  tiempo?: string | null;
  observaciones?: string | null;
}

/** Lo que queda en el candidato (`aptitude_eval`), con los nombres de Mega Talento. */
export interface HrAptitudesEvalGuardada {
  evaluador: string;
  cargoEvaluador: string;
  tiempo: string;
  observaciones: string;
  puntaje: number;
  max: number;
  pct: number;
  banda: HrBandaStar;
  aprobado: boolean;
  completadaEn: string;
}
