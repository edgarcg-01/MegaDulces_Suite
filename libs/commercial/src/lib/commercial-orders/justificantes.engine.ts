/**
 * `[MCP.18]` Reglas puras de los justificantes (el motivo de cada cambio a un pedido de preventa).
 * Sin base ni HTTP: se prueban solas (justificantes.engine.spec.ts). Los catálogos y las decisiones
 * viven en `@megadulces/contracts` (order-justification.contract.ts), una constante cada una.
 */
import type {
  MotivoOpcion,
  OrderJustification,
  PoliticaCorregir,
  PresalePickReport,
  PresaleReviewResult,
  PresaleReviewResultLine,
} from '@megadulces/contracts';
import { AVISO_PANTALLA_VIEJA, MOTIVOS_CAJA, MOTIVOS_SURTIDO, errorDeMotivo, motivoDeHistoria, textoDeMotivo } from '@megadulces/contracts';

/** Un motivo que no se puede guardar. El llamador lo vuelve un 400. */
export class MotivoInvalido extends Error {}

const LEGADO_MAX = 300;

/**
 * El motivo del cuerpo de «Corregir» o «Cancelar», como texto para `order_status_history.reason`.
 *  · `reason_code` (+ `note`): se valida contra el catálogo y se guarda «Etiqueta» o «Etiqueta: nota»;
 *  · sólo `reason` (lo que mandaban las pantallas de antes): se guarda tal cual, recortado;
 *  · nada: `null` — o error si `obligatorio`.
 * Con `obligatorio`, el texto fijo que escribían las pantallas de antes («Cancelado por el vendedor»)
 * no cuenta como motivo (D4).
 */
export function motivoDelCuerpo(
  body: { reason?: unknown; reason_code?: unknown; note?: unknown } | null | undefined,
  catalogo: readonly MotivoOpcion[],
  obligatorio = false,
): string | null {
  const b = body ?? {};
  if (b.reason_code != null && b.reason_code !== '') {
    const err = errorDeMotivo(catalogo, { reason_code: String(b.reason_code), note: b.note as string | null | undefined });
    if (err) throw new MotivoInvalido(err);
    return textoDeMotivo(catalogo, String(b.reason_code).trim(), b.note as string | null | undefined);
  }
  const legado = typeof b.reason === 'string' ? b.reason.trim().slice(0, LEGADO_MAX) : '';
  if (legado && (!obligatorio || motivoDeHistoria(legado))) return legado;
  if (obligatorio) throw new MotivoInvalido(`Elige el motivo. ${AVISO_PANTALLA_VIEJA}`);
  return legado || null;
}

/**
 * D4 · Todo renglón que faltó lleva su motivo. `renglones` = los que se quitaron o se dejaron con menos
 * (`id` = `line_id` al surtir, `key` en caja). Lanza con los productos sin motivo, en palabras.
 */
export function exigirMotivosDeRenglones(
  renglones: ReadonlyArray<{ id: string; product_name: string | null }>,
  motivos: Map<string, Motivo>,
): void {
  const faltan = renglones.filter((r) => !motivos.has(r.id)).map((r) => r.product_name?.trim() || 'un producto');
  if (!faltan.length) return;
  const nombres = faltan.length <= 3 ? faltan.join(', ') : `${faltan.slice(0, 3).join(', ')} y ${faltan.length - 3} más`;
  throw new MotivoInvalido(`Falta el porqué de lo que no se completó: ${nombres}. ${AVISO_PANTALLA_VIEJA}`);
}

/** Lo que se sabe del surtido de un pedido (una fila de `commercial.presale_picks`). */
export interface SurtidoDelPedido {
  started_at: Date | string | null;
  started_by_name: string | null;
  finished_at: Date | string | null;
  finished_by_name: string | null;
  reviewed_at?: Date | string | null;
  reviewed_by_name?: string | null;
}

/** `HH:MM` en hora de México. */
export function horaMx(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/**
 * D1 · ¿Se puede «Corregir» (reabrir) con este surtido? `null` = sí; si no, el mensaje para la
 * vendedora: qué pasó y qué hacer en su lugar. `surtidos` trae el del pedido y los de las otras
 * partes de su grupo (`[MCP.3.13]`): si cualquiera ya empezó, reabrir movería renglones bajo la mano
 * de un surtidor.
 */
export function bloqueoParaCorregir(
  surtidos: SurtidoDelPedido[],
  politica: PoliticaCorregir,
  /** `[MCP.21]` Cancelar directo desde la app sigue la misma regla que «Corregir». */
  accion: 'corregir' | 'cancelar' = 'corregir',
): string | null {
  if (politica === 'permitir') return null;
  const empezados = (surtidos ?? []).filter((s) => !!s.started_at);
  if (!empezados.length) return null;
  const terminado = empezados.find((s) => !!s.finished_at) ?? null;
  if (politica === 'hasta_que_termine_el_surtido' && !terminado) return null;
  const revisado = empezados.find((s) => !!s.reviewed_at) ?? null;
  const nombre = (n: string | null | undefined, porOmision: string) => String(n ?? '').trim() || porOmision;
  if (accion === 'cancelar') {
    const q = revisado
      ? `Ya lo revisó la caja (${nombre(revisado.reviewed_by_name, 'la cajera')}, ${horaMx(revisado.reviewed_at as Date | string)})`
      : terminado
        ? `Ya lo surtió ${nombre(terminado.finished_by_name, 'el surtidor')} a las ${horaMx(terminado.finished_at as Date | string)}`
        : `Ya lo está surtiendo ${nombre(empezados[0].started_by_name, 'el surtidor')} desde las ${horaMx(empezados[0].started_at as Date | string)}`;
    return `${q}: ya no se cancela desde la app. Avísale ${revisado || terminado ? 'a la caja' : 'al surtidor'} para que no siga con él, y que Comercial lo cancele.`;
  }
  if (revisado) {
    return `Ya lo revisó la caja (${nombre(revisado.reviewed_by_name, 'la cajera')}, ${horaMx(revisado.reviewed_at as Date | string)}): ya no se corrige desde la app. `
      + 'Si el cliente quiere algo más, toma un pedido nuevo; si quiere quitar algo, avísale a la caja antes de cobrar.';
  }
  const quien = terminado
    ? `Ya lo surtió ${nombre(terminado.finished_by_name, 'el surtidor')} a las ${horaMx(terminado.finished_at as Date | string)}`
    : `Ya lo está surtiendo ${nombre(empezados[0].started_by_name, 'el surtidor')} desde las ${horaMx(empezados[0].started_at as Date | string)}`;
  return `${quien}: ya no se corrige desde la app. Si el cliente quiere algo más, toma un pedido nuevo; `
    + `si quiere quitar algo, pídele ${terminado ? 'a la caja' : 'al surtidor'} que lo quite con el motivo «Lo pidió quitar el vendedor o el cliente».`;
}

type Motivo = { reason: string; reason_note?: string };

/**
 * Los motivos que llegaron por renglón, ya validados. `id` dice qué campo identifica el renglón
 * (`line_id` al surtir, `key` en caja). Un renglón sin `reason` no entra (= sin motivo registrado).
 */
export function motivosPorRenglon(
  marcados: ReadonlyArray<Record<string, unknown>> | null | undefined,
  catalogo: readonly MotivoOpcion[],
  id: 'line_id' | 'key',
): Map<string, Motivo> {
  const out = new Map<string, Motivo>();
  for (const m of marcados ?? []) {
    const ref = m?.[id];
    const reason = m?.['reason'];
    if (typeof ref !== 'string' || reason == null || reason === '') continue;
    const nota = m['reason_note'];
    const err = errorDeMotivo(catalogo, { reason_code: String(reason), note: nota as string | null | undefined });
    if (err) throw new MotivoInvalido(err);
    const n = String(nota ?? '').trim();
    out.set(ref, n ? { reason: String(reason).trim(), reason_note: n } : { reason: String(reason).trim() });
  }
  return out;
}

/** El reporte del surtido con el motivo en cada renglón quitado o recortado. Lo que no faltó no lleva motivo. */
export function conMotivosEnReporte(report: PresalePickReport | null, motivos: Map<string, Motivo>): PresalePickReport | null {
  if (!report || !motivos.size) return report;
  const poner = <T extends { line_id?: string }>(l: T): T => (l.line_id && motivos.has(l.line_id) ? { ...l, ...motivos.get(l.line_id) } : l);
  return { ...report, removed: report.removed.map(poner), adjusted: report.adjusted.map(poner) };
}

/**
 * Los renglones de la revisión con el motivo de la caja. Sólo donde la CAJA dejó menos de lo que surtió
 * el surtidor: un faltante que ya venía del surtido tiene su propio motivo en el reporte.
 */
export function conMotivosEnRevision(lines: PresaleReviewResultLine[], motivos: Map<string, Motivo>): PresaleReviewResultLine[] {
  if (!motivos.size) return lines;
  return lines.map((l) => (l.final < l.picked - 1e-9 && motivos.has(l.key) ? { ...l, ...motivos.get(l.key) } : l));
}

/** Una fila de `commercial.order_status_history` con el nombre de quien la hizo. */
export interface FilaHistoria {
  from_status: string | null;
  to_status: string;
  reason: string | null;
  changed_at: Date | string;
  by_name: string | null;
  /** ¿La hizo la vendedora del pedido? */
  by_seller: boolean;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (n: number): string => String(+Number(n).toFixed(3));

/**
 * Todo lo que cambió el pedido con su motivo, en orden de tiempo:
 *  · de la historia: cada «Corregir» (confirmado/por aprobar → borrador) y la cancelación;
 *  · del reporte del surtido: lo que se quitó y lo que se surtió de menos;
 *  · de la revisión en caja: lo que la caja dejó por debajo de lo surtido.
 * Lo que se guardó sin motivo sale con `reason: null` (la pantalla dice «Sin motivo registrado»).
 */
export function armarJustificantes(f: {
  historia?: FilaHistoria[];
  reporte?: PresalePickReport | null;
  surtio?: { name: string | null; at: Date | string | null } | null;
  revision?: PresaleReviewResult | null;
  reviso?: { name: string | null; at: Date | string | null } | null;
}): OrderJustification[] {
  const out: OrderJustification[] = [];
  for (const h of f.historia ?? []) {
    const reabierto = h.to_status === 'draft' && (h.from_status === 'confirmed' || h.from_status === 'pending_approval');
    const cancelado = h.to_status === 'cancelled';
    if (!reabierto && !cancelado) continue;
    out.push({
      actor: h.by_seller ? 'seller' : 'other',
      action: reabierto ? 'reopened' : 'cancelled',
      by_name: h.by_name?.trim() || null,
      at: iso(h.changed_at),
      product_name: null,
      detail: null,
      reason: motivoDeHistoria(h.reason),
    });
  }
  const surtido = (l: { reason?: string; reason_note?: string }): string | null =>
    l.reason ? textoDeMotivo(MOTIVOS_SURTIDO, l.reason, l.reason_note) : null;
  for (const l of f.reporte?.removed ?? []) {
    out.push({
      actor: 'picker', action: 'removed', by_name: f.surtio?.name?.trim() || null, at: iso(f.surtio?.at),
      product_name: l.product_name, detail: `${num(l.ordered)} ${l.unit}`, reason: surtido(l),
    });
  }
  for (const l of f.reporte?.adjusted ?? []) {
    out.push({
      actor: 'picker', action: 'trimmed', by_name: f.surtio?.name?.trim() || null, at: iso(f.surtio?.at),
      product_name: l.product_name, detail: `${num(l.picked)} de ${num(l.ordered)} ${l.unit}`, reason: surtido(l),
    });
  }
  for (const l of f.revision?.lines ?? []) {
    if (!(l.final < l.picked - 1e-9)) continue;
    out.push({
      actor: 'cashier', action: 'not_in_cart', by_name: f.reviso?.name?.trim() || null, at: iso(f.reviso?.at),
      product_name: l.product_name, detail: `${num(l.final)} de ${num(l.picked)} ${l.unit}`,
      reason: l.reason ? textoDeMotivo(MOTIVOS_CAJA, l.reason, l.reason_note) : null,
    });
  }
  // Estable: lo que no tiene hora queda en su lugar relativo, al final.
  return out
    .map((j, i) => ({ j, i }))
    .sort((a, b) => {
      const ta = a.j.at ? Date.parse(a.j.at) : Number.POSITIVE_INFINITY;
      const tb = b.j.at ? Date.parse(b.j.at) : Number.POSITIVE_INFINITY;
      return ta === tb ? a.i - b.i : ta - tb;
    })
    .map((x) => x.j);
}
