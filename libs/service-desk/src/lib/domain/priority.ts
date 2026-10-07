/**
 * `[MS.2.3]` La prioridad SUGERIDA. Función pura. ADR-081 §3.
 *
 * Para que TODOS puedan reportar sin que todo llegue como urgente, la prioridad no se autodeclara: el
 * solicitante dice dos cosas objetivas —cuánta gente afecta (`impact`) y si le impide trabajar
 * (`blocks_work`)— y el sistema sugiere; quien atiende la confirma o la cambia.
 *
 * ── La matriz (impacto × bloqueo) ────────────────────────────────────────────────────────────
 *
 *                 yo      varios   sucursal   red
 *   me bloquea    media   alta     URGENTE    URGENTE
 *   no me bloquea baja    baja     media      alta
 *
 * `urgente` sólo sale de «bloquea + sucursal/red». La sugerida final es el MÁXIMO entre la prioridad por
 * defecto de la categoría y la de la matriz: una categoría que ya es `alta` (ERP Kepler, Redes) no baja a
 * `baja` porque el solicitante diga que sólo le afecta a él.
 *
 * ⚠️ Esto es una SUGERENCIA, no una verdad: un solicitante puede exagerar el impacto. Por eso se guarda
 * `priority_suggested` aparte de `priority` (la que confirma quien atiende): la diferencia entre las dos
 * es exactamente lo que mide cuánto se sobrestima, y qué categorías lo hacen.
 */
import { SD_PRIORITIES, type SdActor, type SdImpact, type SdPriority } from '@megadulces/contracts';

const ORDEN: Record<SdPriority, number> = { baja: 0, media: 1, alta: 2, urgente: 3 };

export function compararPrioridad(a: SdPriority, b: SdPriority): number {
  return ORDEN[a] - ORDEN[b];
}

export function maxPrioridad(a: SdPriority, b: SdPriority): SdPriority {
  return ORDEN[a] >= ORDEN[b] ? a : b;
}

export function esPrioridad(v: unknown): v is SdPriority {
  return typeof v === 'string' && (SD_PRIORITIES as readonly string[]).includes(v);
}

const MATRIZ: Record<'bloquea' | 'libre', Record<SdImpact, SdPriority>> = {
  bloquea: { yo: 'media', varios: 'alta', sucursal: 'urgente', red: 'urgente' },
  libre: { yo: 'baja', varios: 'baja', sucursal: 'media', red: 'alta' },
};

export function prioridadPorImpacto(impact: SdImpact, blocksWork: boolean): SdPriority {
  return MATRIZ[blocksWork ? 'bloquea' : 'libre'][impact];
}

export interface EntradaPrioridad {
  defaultPriority: SdPriority;
  impact: SdImpact;
  blocksWork: boolean;
}

export function sugerirPrioridad(e: EntradaPrioridad): SdPriority {
  return maxPrioridad(e.defaultPriority, prioridadPorImpacto(e.impact, e.blocksWork));
}

/**
 * ¿Quién puede CAMBIAR la prioridad de un ticket ya creado? Sólo quien atiende o coordina (y el sistema).
 * El solicitante nunca: en particular no puede subirla a `alta` o `urgente` para saltarse la fila.
 */
export function puedeCambiarPrioridad(actor: SdActor): boolean {
  return actor === 'agent' || actor === 'coordinator' || actor === 'system';
}
