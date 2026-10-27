/**
 * `[LE.3.3]` `[LE.4.4]` — Qué movimientos de la máquina toca asentar ahora, EN ORDEN y sin saltar
 * ninguno (B41). Puro: lo usa el carril (`cashbook-caos.carril.ts`) y lo prueba su spec.
 *
 * La máquina numera sus movimientos sin huecos (`external_id` contiguo por equipo; medido el
 * 2026-10-27: 0 huecos en 1,283). Si falta un número, el libro NO sigue: lo que venga después
 * podría depender de lo que falta (un retiro de billetes que entraron en el movimiento perdido).
 * El hueco se declara en la cola de excepciones y el carril espera.
 */
import type { MovimientoCaos } from './identidad';

export interface PlanDeCaos {
  /** Los que siguen, contiguos desde el último procesado. */
  aAsentar: MovimientoCaos[];
  /** El primer hueco encontrado: desde/hasta los números que faltan. */
  hueco: { desde: number; hasta: number } | null;
}

export function planDeCaos(movs: readonly MovimientoCaos[], ultimoProcesado: number): PlanDeCaos {
  const ordenados = [...movs].filter((m) => Number(m.external_id) > ultimoProcesado)
    .sort((a, b) => Number(a.external_id) - Number(b.external_id));
  const aAsentar: MovimientoCaos[] = [];
  let esperado = ultimoProcesado + 1;
  for (const m of ordenados) {
    const id = Number(m.external_id);
    if (id !== esperado) return { aAsentar, hueco: { desde: esperado, hasta: id - 1 } };
    aAsentar.push(m);
    esperado = id + 1;
  }
  return { aAsentar, hueco: null };
}

/** `LE_LIBRO_CAOS_DESDE=AST700-19758:1607` → { equipo, desde }. Sin punto de apertura, null. */
export function puntoDeApertura(valor: string | undefined): { equipo: string; desde: number } | null {
  const m = /^([A-Za-z0-9_.-]+):(\d+)$/.exec(String(valor ?? '').trim());
  return m ? { equipo: m[1], desde: Number(m[2]) } : null;
}
