import {
  WAREHOUSE_ORDER_ESTATUS,
  type WarehouseOrderRow,
  type WarehouseOrdersAlcance,
  type WarehouseOrdersResponse,
} from '@megadulces/contracts';

/**
 * `[GP.1]` Lógica pura del tablero de pedidos del almacén: sin base de datos, sin Nest.
 * El servicio trae los pedidos del periodo; acá se filtran, se cuentan y se les calcula la
 * antigüedad. Separado para poder probarlo con casos chicos (warehouse-orders.engine.spec.ts).
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-\d{2}$/;
export const MX_TZ = 'America/Mexico_City';

/** Tope de renglones del listado. Los conteos y totales se calculan sobre todo el periodo. */
export const LIMITE_ITEMS = 2000;

export class PeriodoInvalido extends Error {}

/**
 * `from`+`to` mandan sobre `month`; sin nada, **el mes en curso** en hora de México
 * (decisión de Francisco, 2026-10-06: el tablero arranca en el mes en curso).
 */
export function periodo(
  q: { month?: string; from?: string; to?: string },
  hoyMx: string,
): { from: string; to: string } {
  if (q.from || q.to) {
    if (!q.from || !q.to || !ISO.test(q.from) || !ISO.test(q.to)) {
      throw new PeriodoInvalido('El rango necesita "from" y "to" con formato AAAA-MM-DD.');
    }
    if (q.from > q.to) throw new PeriodoInvalido('"from" no puede ser posterior a "to".');
    return { from: q.from, to: q.to };
  }
  const m = q.month && MES.test(q.month) ? q.month : hoyMx.slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(ultimo).padStart(2, '0')}` };
}

/** Fecha y hora "de pared" de México para un instante dado: `YYYY-MM-DD` y minutos del día. */
export function relojMx(now: Date): { fecha: string; minutos: number } {
  const fecha = now.toLocaleDateString('en-CA', { timeZone: MX_TZ });
  const hm = now.toLocaleTimeString('en-GB', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = hm.split(':').map(Number);
  return { fecha, minutos: (h % 24) * 60 + m };
}

/**
 * Horas desde que se creó el pedido, contadas en hora de México. `null` si ya se embarcó o si
 * Kepler no trae la hora (no se inventa una medianoche: sería un número falso, ADR-056).
 */
export function horasAbierto(
  fecha: string,
  hora: string | null,
  estatus: string | null,
  reloj: { fecha: string; minutos: number },
): number | null {
  if (estatus === 'EMBARCADO') return null;
  const hm = hora && /^(\d{1,2}):(\d{2})/.exec(hora);
  if (!hm || !ISO.test(fecha)) return null;
  const dias = Math.round((Date.parse(`${reloj.fecha}T00:00:00Z`) - Date.parse(`${fecha}T00:00:00Z`)) / 86_400_000);
  const min = dias * 1440 + reloj.minutos - (Number(hm[1]) * 60 + Number(hm[2]));
  return min < 0 ? 0 : Math.round((min / 60) * 10) / 10;
}

/** Orden de los estatus: primero los conocidos en el orden en que avanza el pedido. */
export function ordenEstatus(a: string, b: string): number {
  const ia = (WAREHOUSE_ORDER_ESTATUS as readonly string[]).indexOf(a);
  const ib = (WAREHOUSE_ORDER_ESTATUS as readonly string[]).indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
}

export interface Filtros {
  estatus: string[];
  origen: string | null;
  sucursal: string | null;
  q: string | null;
}

function coincideTexto(r: WarehouseOrderRow, q: string): boolean {
  const t = q.toLowerCase();
  return [r.documento, r.folio, r.cliente_code, r.destino_nombre, r.destino_ciudad, r.vendedor_nombre, r.guia]
    .some((v) => (v ?? '').toLowerCase().includes(t));
}

/**
 * Arma la respuesta. Los conteos por estatus respetan origen, sucursal y búsqueda pero NO el
 * filtro de estatus: son los números que van en los botones para elegirlo.
 */
export function armarRespuesta(
  rows: WarehouseOrderRow[],
  filtros: Filtros,
  per: { from: string; to: string },
  alcance: WarehouseOrdersAlcance,
  generadoEn: Date,
): WarehouseOrdersResponse {
  const base = rows.filter(
    (r) =>
      (!filtros.origen || r.origen === filtros.origen) &&
      (!filtros.sucursal || r.sucursal === filtros.sucursal) &&
      (!filtros.q || coincideTexto(r, filtros.q)),
  );

  const porEstatus = new Map<string, { pedidos: number; renglones: number; mas_antiguo_horas: number | null }>();
  for (const e of WAREHOUSE_ORDER_ESTATUS) porEstatus.set(e, { pedidos: 0, renglones: 0, mas_antiguo_horas: null });
  for (const r of base) {
    const k = r.estatus ?? 'SIN ESTATUS';
    const c = porEstatus.get(k) ?? { pedidos: 0, renglones: 0, mas_antiguo_horas: null };
    c.pedidos += 1;
    c.renglones += r.renglones;
    if (r.horas_abierto != null && (c.mas_antiguo_horas == null || r.horas_abierto > c.mas_antiguo_horas)) {
      c.mas_antiguo_horas = r.horas_abierto;
    }
    porEstatus.set(k, c);
  }
  const conteos = [...porEstatus.entries()]
    .sort(([a], [b]) => ordenEstatus(a, b))
    .map(([estatus, c]) => ({ estatus, ...c }));

  const filtrados = filtros.estatus.length ? base.filter((r) => filtros.estatus.includes(r.estatus ?? 'SIN ESTATUS')) : base;
  const totales = filtrados.reduce(
    (t, r) => ({ pedidos: t.pedidos + 1, renglones: t.renglones + r.renglones, importe: t.importe + (r.importe ?? 0) }),
    { pedidos: 0, renglones: 0, importe: 0 },
  );
  totales.importe = Math.round(totales.importe * 100) / 100;

  return {
    periodo: per,
    alcance,
    filtros,
    conteos,
    totales,
    items: filtrados.slice(0, LIMITE_ITEMS),
    truncado: filtrados.length > LIMITE_ITEMS,
    generado_en: generadoEn.toISOString(),
  };
}
