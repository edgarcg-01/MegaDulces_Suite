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

/**
 * `[MS.7.7]` La matriz de Mantenimiento: riesgo para personas × detiene la operación.
 *
 *                       detiene la operación     no detiene
 *   riesgo: sí          URGENTE («Crítica»)      alta
 *   riesgo: no          alta                     media
 *
 * Es SUGERIDA, igual que la de impacto: quien atiende la confirma, y **la persona no la baja** (decisión M4: ni a «baja»).
 * La mínima es `media` —no `baja`—: un problema físico del local nunca llega a «puede esperar» por lo que diga quien reporta.
 */
const MATRIZ_RIESGO: Record<'riesgo' | 'sinRiesgo', Record<'detiene' | 'sigue', SdPriority>> = {
  riesgo: { detiene: 'urgente', sigue: 'alta' },
  sinRiesgo: { detiene: 'alta', sigue: 'media' },
};

export function prioridadPorRiesgo(riesgoParaPersonas: boolean, detieneOperacion: boolean): SdPriority {
  return MATRIZ_RIESGO[riesgoParaPersonas ? 'riesgo' : 'sinRiesgo'][detieneOperacion ? 'detiene' : 'sigue'];
}

export interface EntradaPrioridad {
  defaultPriority: SdPriority;
  impact: SdImpact;
  blocksWork: boolean;
}

export function sugerirPrioridad(e: EntradaPrioridad): SdPriority {
  return maxPrioridad(e.defaultPriority, prioridadPorImpacto(e.impact, e.blocksWork));
}

export interface EntradaPrioridadPorModelo extends EntradaPrioridad {
  /** `queues.priority_model` de la cola del ticket. Un valor desconocido cae a `impacto` (el de siempre): nunca revienta un alta. */
  modelo: string;
  /** Sólo se lee con el modelo `riesgo_operacion`. */
  safetyRisk?: boolean | null;
}

/**
 * `[MS.7.7]` La prioridad sugerida según el MODELO de la cola. `impacto` es exactamente la de siempre (TI no cambia);
 * `riesgo_operacion` usa la matriz de arriba, también con el piso de la categoría (una categoría que ya es `alta` no baja a
 * `media` porque quien reporta diga que no hay riesgo). La respuesta de riesgo es obligatoria en ese modelo: quien llama la
 * valida ANTES (un `null` aquí sería adivinar que no hay riesgo, y el peligro nunca se infiere por omisión).
 */
export function sugerirPrioridadPorModelo(e: EntradaPrioridadPorModelo): SdPriority {
  if (e.modelo === 'riesgo_operacion') {
    if (typeof e.safetyRisk !== 'boolean') throw new Error('sugerirPrioridadPorModelo: el modelo riesgo_operacion exige safetyRisk (verdadero o falso)');
    return maxPrioridad(e.defaultPriority, prioridadPorRiesgo(e.safetyRisk, e.blocksWork));
  }
  return sugerirPrioridad(e);
}

/**
 * ¿Quién puede CAMBIAR la prioridad de un ticket ya creado? Sólo quien atiende o coordina (y el sistema).
 * El solicitante nunca: en particular no puede subirla a `alta` o `urgente` para saltarse la fila.
 */
export function puedeCambiarPrioridad(actor: SdActor): boolean {
  return actor === 'agent' || actor === 'coordinator' || actor === 'system';
}
