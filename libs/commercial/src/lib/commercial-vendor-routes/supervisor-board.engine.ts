import type { BoardPeriod, BoardSales } from '@megadulces/contracts';
import type { RouteCatalog } from './route-scope';

/**
 * `[MCP.3.9]` Reglas puras del tablero del supervisor: la catorcena y la venta atribuida a la ruta.
 * Sin base: todo lo que aquí se decide se prueba en supervisor-board.engine.spec.ts.
 */

/**
 * Sábado que abre una catorcena (dos semanas de nómina seguidas, sáb→vie: la nómina de ContPAQi es
 * semanal sáb→vie). Todas las catorcenas se cuentan de 14 en 14 días desde aquí, hacia adelante y
 * hacia atrás. ⚠️ Confirmar con David que el 17-oct-2026 abre catorcena (y no la semana siguiente):
 * si no, sólo cambia esta constante.
 */
export const CATORCENA_ANCLA = '2026-10-17';

const DIA_MS = 86_400_000;

/** Días entre dos `YYYY-MM-DD` (b − a), sin husos: se comparan a mediodía UTC. */
function diasEntre(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DIA_MS);
}

function sumarDias(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
}

/** La catorcena que contiene una fecha: sábado de inicio, viernes de fin y qué día es (1–14). */
export function catorcenaOf(ymd: string, ancla: string = CATORCENA_ANCLA): BoardPeriod {
  const d = diasEntre(ancla, ymd);
  const k = Math.floor(d / 14);
  const start = sumarDias(ancla, k * 14);
  return { start, end: sumarDias(start, 13), day: d - k * 14 + 1 };
}

/** ¿Es el sábado de inicio de una catorcena (alineado al ancla)? */
export function isCatorcenaStart(ymd: string, ancla: string = CATORCENA_ANCLA): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const t = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== ymd) return false;
  return catorcenaOf(ymd, ancla).start === ymd;
}

/** Avance contra la meta, en % con un decimal. `null` si falta meta (o es 0) o venta. */
export function progressPct(target: number | null, amount: number | null): number | null {
  if (target == null || amount == null || !(target > 0)) return null;
  return Math.round((amount / target) * 1000) / 10;
}

/** Por qué no se midió la venta — textos de pantalla, una sola vez. */
export const SIN_MEDIR = {
  directa:
    'La venta de Ruta Directa no se cobra en Kepler: la camioneta cobra a bordo (Wincaja) y Kepler sólo registra '
    + 'el embarque. Sólo se publica la venta cobrada en Kepler, así que aquí no hay cifra.',
  otroTipo: (ruta: string, tipo: string) =>
    `La ruta «${ruta}» es de tipo ${tipo}: este tablero sólo tiene fuente de venta cobrada en Kepler por ruta para las vecinales.`,
  sinCodigo: (ruta: string) =>
    `La ruta «${ruta}» no tiene código de Kepler declarado (trade.catalogs.erp_vendor_code): no se puede ligar a su venta.`,
  sinRuta: 'Sin ruta ese día: la venta se atribuye a la ruta, y no tuvo ninguna.',
  sinRutaPeriodo: 'Sin ruta en la catorcena: la venta se atribuye a la ruta, y no tuvo ninguna.',
  /** `[MCP.3.10]` La vista de venta Kepler no respondió (o no existe en esta base): no hay cifra. */
  sinFuente:
    'No se pudo leer la venta cobrada en Kepler (analytics.v_kepler_vecinal_sales_docs): no se publica cifra hasta que vuelva.',
} as const;

/** Venta Kepler de una ruta en un día. La llave es `CÓDIGO|YYYY-MM-DD`. */
export interface RouteDaySale {
  amount: number;
  tickets: number;
}

export function saleKey(code: string, ymd: string): string {
  return `${code.toUpperCase()}|${ymd}`;
}

/** La venta atribuida a un vendedor, más lo que hace falta para el total sin contar dos veces. */
export interface AttributedSales {
  sales: BoardSales;
  /** Llaves `CÓDIGO|día` medidas (aunque hayan vendido $0): el total suma cada una UNA vez. */
  keys: string[];
  /** Hubo al menos una ruta-día sin fuente: el total del equipo tampoco se puede afirmar. */
  blocks: boolean;
}

/**
 * La venta de un vendedor = la venta Kepler de SUS RUTAS en los días que las tuvo. La venta se
 * atribuye a la RUTA, no a la persona: si cubrió una ruta ajena ese día, la venta de esa ruta le
 * cuenta a él (y si dos personas tienen la misma ruta el mismo día, le cuenta a las dos; el total
 * del equipo la suma una sola vez).
 *
 * Si UNA de sus rutas-día no se puede medir (Ruta Directa, o vecinal sin código), la cifra entera es
 * `null` con el motivo: publicar sólo la parte medida sería afirmar un total que no es.
 */
export function attributeSales(
  routeDays: readonly { date: string; route: string }[],
  catalog: RouteCatalog,
  /** `null` = no se pudo leer la fuente: toda ruta-día vecinal queda sin medir. */
  sales: ReadonlyMap<string, RouteDaySale> | null,
  sinRutaReason: string = SIN_MEDIR.sinRuta,
): AttributedSales {
  if (!routeDays.length) return { sales: { amount: null, tickets: null, unmeasured_reason: sinRutaReason }, keys: [], blocks: false };
  const keys: string[] = [];
  let amount = 0;
  let tickets = 0;
  let reason: string | null = null;
  for (const rd of routeDays) {
    // Sólo la venta vecinal tiene fuente cobrada en Kepler (ver `SupervisorBoardService`).
    const kind = catalog.kindOf(rd.route);
    if (kind !== 'vecinal') {
      reason ??= kind == null || kind === 'camion' ? SIN_MEDIR.directa : SIN_MEDIR.otroTipo(rd.route, kind);
      continue;
    }
    const code = catalog.keplerCode(rd.route);
    if (!code) { reason ??= SIN_MEDIR.sinCodigo(rd.route); continue; }
    if (!sales) { reason ??= SIN_MEDIR.sinFuente; continue; }
    const k = saleKey(code, rd.date);
    if (keys.includes(k)) continue;
    keys.push(k);
    const s = sales.get(k);
    amount += s?.amount ?? 0;
    tickets += s?.tickets ?? 0;
  }
  if (reason) return { sales: { amount: null, tickets: null, unmeasured_reason: reason }, keys: [], blocks: true };
  return { sales: { amount: round2(amount), tickets, unmeasured_reason: null }, keys, blocks: false };
}

/** Total del equipo: cada ruta-día una vez. `null` si alguien no se pudo medir o nada se midió. */
export function teamSales(parts: readonly AttributedSales[], sales: ReadonlyMap<string, RouteDaySale> | null): number | null {
  if (parts.some((p) => p.blocks)) return null;
  const keys = new Set(parts.flatMap((p) => p.keys));
  if (!keys.size) return null;
  let t = 0;
  for (const k of keys) t += sales?.get(k)?.amount ?? 0;
  return round2(t);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
