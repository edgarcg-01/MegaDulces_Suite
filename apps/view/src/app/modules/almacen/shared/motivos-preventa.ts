/**
 * `[MCP.18]` El justificante del lado de la pantalla, sin Angular: qué motivo lleva cada renglón,
 * cuál falta completar y qué renglones de la caja lo piden. Se prueba solo (motivos-preventa.spec.ts).
 *
 * El motivo viene ya marcado con el de por omisión (lo que dice el botón que se tocó): el caso común
 * no cuesta un toque más. Sólo «Otro motivo» pide escribir.
 */
import type { MotivoOpcion, PresaleReviewLine } from '@megadulces/contracts';
import { errorDeMotivo } from '@megadulces/contracts';
import { resuelto, type ProgresoPedido } from '../revision-caja';

/** Lo elegido en un renglón. */
export interface MotivoLinea {
  reason: string;
  note: string;
}

/** El motivo de un renglón: el elegido, o el de por omisión si no se tocó. */
export function motivoDe(m: Readonly<Record<string, MotivoLinea>>, id: string, porOmision: string): MotivoLinea {
  return m[id] ?? { reason: porOmision, note: '' };
}

/** Los campos que viajan al servidor (sin nota vacía). */
export function camposDeMotivo(m: MotivoLinea): { reason: string; reason_note?: string } {
  const n = m.note.trim();
  return n ? { reason: m.reason, reason_note: n } : { reason: m.reason };
}

/** Los renglones cuyo motivo no se puede mandar todavía («Otro motivo» sin nota, nota de más). */
export function motivosIncompletos(
  m: Readonly<Record<string, MotivoLinea>>,
  ids: readonly string[],
  catalogo: readonly MotivoOpcion[],
  porOmision: string,
): string[] {
  return ids.filter((id) => {
    const x = motivoDe(m, id, porOmision);
    return !!errorDeMotivo(catalogo, { reason_code: x.reason, note: x.note });
  });
}

/**
 * Los renglones donde la CAJA deja menos de lo que surtió el surtidor («No hay» con menos de lo que
 * venía en el carrito según el surtido). Sólo ésos piden motivo en caja: un faltante que ya venía del
 * surtido tiene el motivo del surtidor.
 */
export function pidenMotivoEnCaja(lines: readonly PresaleReviewLine[], p: ProgresoPedido): PresaleReviewLine[] {
  return lines.filter((l) => {
    const mk = p.marcas[l.key];
    if (!mk || !resuelto(mk) || mk.estado !== 'nohay') return false;
    return Math.min(mk.vienen, l.ordered) < l.picked - 1e-9;
  });
}
