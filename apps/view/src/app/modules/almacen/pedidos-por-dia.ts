import { SIN_VENDEDOR, agruparPorVendedor } from './pedidos-por-vendedor';

/**
 * `[MCP.24]` Las bandejas del surtidor y de la caja, **un día a la vez y por vendedor**. Lo pidió David
 * el 2026-11-12: «que siempre tengan a la mano los de hoy … pero puedan revisar los anteriores; sepáralos
 * por vendedor», sin mezclar días ni vendedores.
 *
 * · «Hoy» abre siempre. Ayer, un día anterior o uno del calendario se piden aparte.
 * · Lo PENDIENTE de otro día no se mezcla con lo de hoy, pero tampoco se esconde: se cuenta por día en
 *   un aviso arriba de «Hoy», y tocar un día lo abre.
 * · El vendedor se elige arriba. «Todos» conserva los encabezados por vendedor (MCP.14).
 *
 * Puro: se prueba solo (pedidos-por-dia.spec.ts).
 */

export interface PendienteDeOtroDia {
  /** `YYYY-MM-DD`. */
  fecha: string;
  n: number;
}

/** Lo pendiente que NO es de `hoy`, contado por día; el día más reciente primero. */
export function pendientesDeOtrosDias<T>(
  filas: readonly T[],
  fechaDe: (f: T) => string | null | undefined,
  esPendiente: (f: T) => boolean,
  hoy: string,
): PendienteDeOtroDia[] {
  const porDia = new Map<string, number>();
  for (const f of filas) {
    const d = fechaDe(f);
    if (!d || d === hoy || !esPendiente(f)) continue;
    porDia.set(d, (porDia.get(d) ?? 0) + 1);
  }
  return [...porDia.entries()].map(([fecha, n]) => ({ fecha, n })).sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

/** Suma días a un `YYYY-MM-DD` sin pasar por la zona horaria del navegador. */
export function sumarDiasIso(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  return t.toISOString().slice(0, 10);
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «Hoy», «Ayer», «Mañana» o «lun 10 nov». */
export function etiquetaDia(fecha: string, hoy: string): string {
  if (fecha === hoy) return 'Hoy';
  if (fecha === sumarDiasIso(hoy, -1)) return 'Ayer';
  if (fecha === sumarDiasIso(hoy, 1)) return 'Mañana';
  const [y, m, d] = fecha.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${DIAS[t.getUTCDay()]} ${d} ${MESES[m - 1]}`;
}

export interface OpcionVendedor {
  vendedor: string;
  n: number;
}

/** Los vendedores de la lista, en el mismo orden que sus encabezados (`agruparPorVendedor`), con cuántos pedidos. */
export function vendedoresDe<T extends { seller_name: string | null; code: string }>(
  filas: readonly T[],
  llegada: (f: T) => string | null | undefined,
): OpcionVendedor[] {
  return agruparPorVendedor(filas, llegada).map((g) => ({ vendedor: g.vendedor, n: g.pedidos.length }));
}

/**
 * Sólo los pedidos de `vendedor`; `null` = todos. Estricto: un vendedor sin pedidos en ESTA lista da `[]`.
 * Que un vendedor que ya no está regrese a «Todos» lo decide la pantalla con sus opciones (`vendedorEfectivo`),
 * no aquí: la caja filtra por separado lo pendiente y lo revisado, y aquí no se sabe de cuál lista se trata.
 */
export function deVendedor<T extends { seller_name: string | null }>(filas: readonly T[], vendedor: string | null): T[] {
  if (!vendedor) return [...filas];
  const nombre = (f: T): string => (f.seller_name ?? '').trim() || SIN_VENDEDOR;
  return filas.filter((f) => nombre(f) === vendedor);
}
