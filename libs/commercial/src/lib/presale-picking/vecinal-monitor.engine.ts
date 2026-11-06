/**
 * `[MV.1]` Reglas puras del Monitoreo vecinal (surtidores y cajeras). Sin base ni HTTP: se prueban
 * solas (vecinal-monitor.engine.spec.ts).
 *
 * De dónde sale cada número (todo de `commercial.presale_picks`, el registro propio del surtido):
 *  · surtidor = `started_by`; su tiempo = `finished_at − started_at`;
 *  · faltante = `outcome = 'con_faltantes'`; cambio por otro producto = `report.substituted`;
 *  · ajuste de la caja = algún renglón de `review` con `final ≠ picked`;
 *  · cajera = `reviewed_by`; su espera = `reviewed_at − finished_at`;
 *  · debió cobrarse = `review.total_after` (el total del pedido como lo dejó la revisión, con IVA).
 * ⛔ Cuánto TARDÓ la cajera no se sabe: no se guarda cuándo empezó a revisar. Se declara `null`.
 */
import type {
  PresalePickReport,
  PresaleReviewResult,
  VecinalCashierRow,
  VecinalMonitorLine,
  VecinalMonitorPeriod,
  VecinalPickerRow,
} from '@megadulces/contracts';
import { cantidadMostrada, diasEntre, sumarDias } from './presale-picking.engine';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** Un periodo más largo que esto ya es un reporte, no un monitoreo: se pide acotarlo. */
export const MAX_DIAS_PERIODO = 92;

export class PeriodoInvalido extends Error {}

/** `YYYY-MM-DD` válido de verdad (no 2026-02-31). */
function esFecha(s: string): boolean {
  if (!YMD.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Días con actividad del periodo: lunes a sábado (el domingo no hay reparto). Mínimo 1. */
export function diasConActividad(from: string, to: string): number {
  let n = 0;
  for (let f = from; f <= to; f = sumarDias(f, 1)) {
    const [y, m, d] = f.split('-').map(Number);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 0) n++;
  }
  return Math.max(n, 1);
}

/**
 * El periodo pedido. Sin fechas = hoy. Reglas: fechas reales, `from ≤ to`, nada en el futuro y no
 * más de `MAX_DIAS_PERIODO` días. Un periodo inválido es un 400, no un periodo «arreglado» en silencio.
 */
export function periodoDe(from: string | undefined, to: string | undefined, hoy: string): VecinalMonitorPeriod {
  const a = (from ?? '').trim() || (to ?? '').trim() || hoy;
  const b = (to ?? '').trim() || a;
  if (!esFecha(a) || !esFecha(b)) throw new PeriodoInvalido('Las fechas van como AAAA-MM-DD.');
  if (a > b) throw new PeriodoInvalido('La fecha de inicio va antes que la de fin.');
  if (b > hoy) throw new PeriodoInvalido('El periodo no puede terminar después de hoy.');
  if (diasEntre(a, b) + 1 > MAX_DIAS_PERIODO) throw new PeriodoInvalido(`El periodo es de máximo ${MAX_DIAS_PERIODO} días.`);
  return { from: a, to: b, days: diasConActividad(a, b) };
}

/** Lo que el motor necesita de un `presale_picks` (con su pedido). Fechas como ISO o Date. */
export interface PickParaMonitor {
  order_id: string;
  code: string;
  started_by: string;
  started_by_name: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
  outcome: 'completo' | 'con_faltantes' | null;
  report: PresalePickReport | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | Date | null;
  review: PresaleReviewResult | null;
}

const ms = (v: string | Date | null): number | null => {
  if (v == null) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
};
const iso = (v: string | Date | null): string | null => { const t = ms(v); return t == null ? null : new Date(t).toISOString(); };
const minutos = (a: string | Date | null, b: string | Date | null): number | null => {
  const x = ms(a), y = ms(b);
  return x == null || y == null || y < x ? null : Math.round((y - x) / 60000);
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** ¿La caja movió algo del pedido? */
export function cajaAjusto(review: PresaleReviewResult | null): boolean {
  return !!review?.lines?.some((l) => Math.abs(Number(l.final) - Number(l.picked)) > 1e-9);
}

/** Una fila por surtidor, la de más pedidos primero. */
export function resumenSurtidores(picks: PickParaMonitor[]): VecinalPickerRow[] {
  const por = new Map<string, PickParaMonitor[]>();
  for (const p of picks) (por.get(p.started_by) ?? por.set(p.started_by, []).get(p.started_by)!).push(p);
  const out: VecinalPickerRow[] = [];
  for (const [user, ps] of por) {
    const terminados = ps.filter((p) => p.finished_at);
    const tiempos = terminados.map((p) => ({ code: p.code, m: minutos(p.started_at, p.finished_at) })).filter((t): t is { code: string; m: number } => t.m != null);
    const lento = tiempos.reduce<{ code: string; m: number } | null>((a, t) => (!a || t.m > a.m ? t : a), null);
    const momentos = ps.flatMap((p) => [ms(p.started_at), ms(p.finished_at)]).filter((t): t is number => t != null);
    out.push({
      user_id: user,
      name: ps.find((p) => p.started_by_name)?.started_by_name ?? 'Surtidor',
      taken: ps.length,
      finished: terminados.length,
      in_progress: ps.length - terminados.length,
      avg_minutes: tiempos.length ? Math.round(tiempos.reduce((a, t) => a + t.m, 0) / tiempos.length) : null,
      slowest: lento ? { code: lento.code, minutes: lento.m } : null,
      with_shortage: ps.filter((p) => p.outcome === 'con_faltantes').length,
      substituted: ps.filter((p) => (p.report?.substituted?.length ?? 0) > 0).length,
      adjusted_by_cashier: ps.filter((p) => cajaAjusto(p.review)).length,
      first_at: momentos.length ? new Date(Math.min(...momentos)).toISOString() : null,
      last_at: momentos.length ? new Date(Math.max(...momentos)).toISOString() : null,
    });
  }
  return out.sort((a, b) => b.taken - a.taken || a.name.localeCompare(b.name));
}

/** Una fila por cajera, la de más revisiones primero. Sólo cuenta lo que ya revisó. */
export function resumenCajeras(picks: PickParaMonitor[]): VecinalCashierRow[] {
  const por = new Map<string, PickParaMonitor[]>();
  for (const p of picks) if (p.reviewed_by && p.reviewed_at) (por.get(p.reviewed_by) ?? por.set(p.reviewed_by, []).get(p.reviewed_by)!).push(p);
  const out: VecinalCashierRow[] = [];
  for (const [user, ps] of por) {
    const esperas = ps.map((p) => minutos(p.finished_at, p.reviewed_at)).filter((m): m is number => m != null);
    const ls = ps.flatMap((p) => p.review?.lines ?? []);
    const momentos = ps.map((p) => ms(p.reviewed_at)).filter((t): t is number => t != null);
    out.push({
      user_id: user,
      name: ps.find((p) => p.reviewed_by_name)?.reviewed_by_name ?? 'Cajera',
      reviewed: ps.length,
      avg_wait_minutes: esperas.length ? Math.round(esperas.reduce((a, m) => a + m, 0) / esperas.length) : null,
      avg_review_minutes: null,
      completed_lines: ls.filter((l) => Number(l.final) > Number(l.picked) + 1e-9).length,
      removed_lines: ls.filter((l) => Number(l.final) < Number(l.picked) - 1e-9).length,
      should_charge: r2(ps.reduce((a, p) => a + Number(p.review?.total_after ?? 0), 0)),
      delta: r2(ps.reduce((a, p) => a + Number(p.review?.total_after ?? 0) - Number(p.review?.total_before ?? 0), 0)),
      first_at: momentos.length ? new Date(Math.min(...momentos)).toISOString() : null,
      last_at: momentos.length ? new Date(Math.max(...momentos)).toISOString() : null,
    });
  }
  return out.sort((a, b) => b.reviewed - a.reviewed || a.name.localeCompare(b.name));
}

/** Un renglón vivo del pedido (cantidad en unidad BASE, como `order_lines`). */
export interface RenglonVivoMonitor {
  line_id: string;
  product_id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  qty_unit: string | null;
  qty_factor: number | null;
}

/**
 * Los productos de un pedido, como los dejó cada etapa. Con revisión, la foto es la revisión (los
 * renglones vivos ya se movieron); sin revisión, los renglones vivos + el reporte del surtido.
 *
 * A diferencia de la revisión en caja, aquí NO se esconde el original que el surtidor cambió por
 * otro producto: el monitoreo quiere ver «faltó → se cambió por».
 *
 * `skuDe` resuelve el SKU de lo que ya no tiene renglón (borrado al surtir), por `product_id`.
 */
export function lineasDelPedido(
  pick: Pick<PickParaMonitor, 'report' | 'review'>,
  vivos: RenglonVivoMonitor[],
  skuDe: (productId: string | null | undefined) => string | null,
): VecinalMonitorLine[] {
  const rep = pick.report;
  const subs = rep?.substituted ?? [];
  const sustitutoDe = (lineId: string | null | undefined) => {
    const x = lineId ? subs.find((s) => s.for_line_id === lineId) : undefined;
    return x ? { product_name: x.product_name, sku: x.sku, quantity: x.quantity, unit: x.unit } : null;
  };
  const enLugarDe = (lineId: string | null | undefined) => (lineId ? subs.find((s) => s.line_id === lineId)?.for_product_name ?? null : null);
  const ajustado = (lineId: string) => (rep?.adjusted ?? []).find((a) => a.line_id === lineId);

  if (pick.review?.lines?.length) {
    const out: VecinalMonitorLine[] = pick.review.lines.map((l) => {
      const borrado = /^borrado:(\d+)$/.exec(l.key);
      const r = borrado ? rep?.removed?.[Number(borrado[1])] : undefined;
      const lineId = borrado ? r?.line_id ?? null : l.key;
      const adj = !borrado && lineId ? ajustado(lineId) : undefined;
      const sub = sustitutoDe(lineId);
      return {
        product_name: l.product_name,
        sku: (l as { sku?: string | null }).sku ?? (borrado ? skuDe(r?.restore?.product_id) : vivos.find((v) => v.line_id === l.key)?.sku ?? null),
        unit: l.unit,
        // Si el surtidor cambió parte, la revisión lo dio por cubierto: lo pedido sale del reporte.
        ordered: sub && adj ? adj.ordered : Number(l.ordered),
        picked: Number(l.picked),
        final: Number(l.final),
        substitute: sub,
        substitutes_for: enLugarDe(lineId),
      };
    });
    // El original BORRADO y cubierto por un sustituto no entra a la revisión: se agrega aquí.
    (rep?.removed ?? []).forEach((r, i) => {
      if (!r.line_id || !subs.some((s) => s.for_line_id === r.line_id)) return;
      if (pick.review!.lines.some((l) => l.key === `borrado:${i}`)) return;
      out.push({ product_name: r.product_name, sku: skuDe(r.restore?.product_id), unit: r.unit, ordered: r.ordered, picked: 0, final: 0, substitute: sustitutoDe(r.line_id), substitutes_for: null });
    });
    return out;
  }

  const out: VecinalMonitorLine[] = vivos.map((v) => {
    const m = cantidadMostrada({ quantity: v.quantity, qty_unit: v.qty_unit, qty_factor: v.qty_factor });
    const adj = ajustado(v.line_id);
    return {
      product_name: v.product_name, sku: v.sku, unit: m.unit,
      ordered: adj ? adj.ordered : m.qty,
      picked: adj ? adj.picked : m.qty,
      final: null,
      substitute: sustitutoDe(v.line_id),
      substitutes_for: enLugarDe(v.line_id),
    };
  });
  for (const r of rep?.removed ?? []) {
    out.push({ product_name: r.product_name, sku: skuDe(r.restore?.product_id), unit: r.unit, ordered: r.ordered, picked: 0, final: null, substitute: sustitutoDe(r.line_id), substitutes_for: null });
  }
  return out;
}

export { iso, minutos };
