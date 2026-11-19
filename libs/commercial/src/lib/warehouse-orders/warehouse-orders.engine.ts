import {
  ETAPAS_PEDIDO,
  WAREHOUSE_ORDER_CANCELADO,
  WAREHOUSE_ORDER_ESTATUS,
  type EtapaPedido,
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

/**
 * Tope de renglones del listado cuando NO se pide página (quien no manda `limit`: la respuesta de
 * siempre). Los conteos y totales se calculan sobre todo el periodo.
 */
export const LIMITE_ITEMS = 2000;

/**
 * `[GP.10.5]` Página más grande que se acepta. Con página, la lista ya no se topa: cada pedido del
 * periodo cae en alguna página, y viaja sólo la que se ve (medido 2026-11-17: 700 bytes por pedido;
 * 2,000 pedidos eran 1.40 MB y aun así quedaban 348 fuera).
 */
export const PAGINA_MAX = 500;

export interface Pagina {
  offset: number;
  limit: number;
}

export class PaginaInvalida extends Error {}

/**
 * `[GP.10.5]` D4: a dónde va el importe del pedido, por su cliente en Kepler (`kdm1.c10`).
 *  · `TI###`            → traspaso a otra sucursal: no se factura (CEDIS, 615 embarques, 0 facturas).
 *  · `RD ###`/`RUTA ##` → carga al camión de ruta: la venta ocurre después, en la ruta.
 *  · lo demás           → a clientes (telemarketing, preventa, mostrador).
 * Es la misma partición que ERP_KEPLER.md (el reparto entre sucursales: 804 traspasos `TI` y 265
 * cargas a ruta en 30 días, «y nada más»). Formas medidas en prod el 2026-11-17 sobre oct–nov:
 * `TI###` 1,995 · `RUTA ##` 246 · `RD ###` 198; ninguna otra empieza así.
 */
export type DestinoImporte = 'clientes' | 'traspaso_sucursal' | 'carga_ruta';
export function destinoDe(clienteCode: string | null): DestinoImporte {
  const c = (clienteCode ?? '').trim().toUpperCase();
  if (/^TI\d{3}$/.test(c)) return 'traspaso_sucursal';
  if (/^(RUTA|RD)\s+\d+$/.test(c)) return 'carga_ruta';
  return 'clientes';
}

const ENTERO = /^\d{1,7}$/;

/**
 * `[GP.10.5]` La página pedida (`limit` 1–`PAGINA_MAX`, `offset` desde 0), o `null` si no se pidió.
 * Un valor mal escrito es un error, no un default silencioso: devolver la página 1 a quien pidió la 3
 * pintaría pedidos repetidos como si fueran otros.
 */
export function paginaDe(q: { offset?: string; limit?: string }): Pagina | null {
  const tieneLimit = q.limit != null && q.limit !== '';
  const tieneOffset = q.offset != null && q.offset !== '';
  if (!tieneLimit) {
    if (tieneOffset) throw new PaginaInvalida('"offset" necesita "limit".');
    return null;
  }
  if (!ENTERO.test(q.limit as string) || (tieneOffset && !ENTERO.test(q.offset as string))) {
    throw new PaginaInvalida('"limit" y "offset" son enteros sin signo.');
  }
  const limit = Number(q.limit);
  if (limit < 1 || limit > PAGINA_MAX) throw new PaginaInvalida(`"limit" va de 1 a ${PAGINA_MAX}.`);
  return { offset: tieneOffset ? Number(q.offset) : 0, limit };
}

/**
 * `[GP.10.5]` El orden de la lista: lo más nuevo primero, por la fecha que la tabla PINTA (la de
 * creación en Kepler; la de entrega en preventa). Antes la preventa se pegaba al final de los de
 * Kepler sin importar su fecha: con el tope de 2,000, las 348 más nuevas del mes no se veían.
 * Sort estable: dentro del mismo día y hora se respeta el orden de la consulta.
 */
export function ordenLista(a: WarehouseOrderRow, b: WarehouseOrderRow): number {
  if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
  if (a.hora === b.hora) return 0;
  if (a.hora == null) return 1;
  if (b.hora == null) return -1;
  return a.hora < b.hora ? 1 : -1;
}

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
/**
 * `[GP.RF.16]` La ventana de la fila de surtido: `dias` hacia atrás desde hoy (México). Igual que el pool
 * de Kepler (`(now() AT TIME ZONE MX)::date - dias`). Devuelve el primer día que entra y el último que no.
 */
export function ventanaPool(hoyMx: string, dias: number): { desde: string; hasta: string } {
  const d = new Date(`${hoyMx}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  const desde = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() - 1);
  return { desde, hasta: d.toISOString().slice(0, 10) };
}

export function relojMx(now: Date): { fecha: string; minutos: number } {
  const fecha = now.toLocaleDateString('en-CA', { timeZone: MX_TZ });
  const hm = now.toLocaleTimeString('en-GB', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = hm.split(':').map(Number);
  return { fecha, minutos: (h % 24) * 60 + m };
}

/**
 * Horas desde que se creó el pedido, contadas en hora de México. `null` si ya se embarcó, si está
 * cancelado (`[GP.10.0]`: no espera a nadie) o si Kepler no trae la hora (no se inventa una
 * medianoche: sería un número falso, ADR-056).
 */
export function horasAbierto(
  fecha: string,
  hora: string | null,
  estatus: string | null,
  reloj: { fecha: string; minutos: number },
): number | null {
  if (estatus === 'EMBARCADO' || estatus === WAREHOUSE_ORDER_CANCELADO) return null;
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
  /** `[GP.10.3]` Etapas de almacén (`EtapaPedido`). */
  etapa: string[];
  origen: string | null;
  sucursal: string | null;
  q: string | null;
  /** `[GP.10.3]` Si se incluyeron los pedidos de preventa (`PD-`). */
  preventa: boolean;
}

/** `[GP.10.3]` Origen de los pedidos de preventa en la consola. */
export const ORIGEN_PREVENTA = 'PREVENTA';

const esCancelado = (r: WarehouseOrderRow): boolean => r.estatus === WAREHOUSE_ORDER_CANCELADO || r.etapa === 'cancelado';

function coincideTexto(r: WarehouseOrderRow, q: string): boolean {
  const t = q.toLowerCase();
  return [r.documento, r.folio, r.cliente_code, r.destino_nombre, r.destino_ciudad, r.vendedor_nombre, r.guia]
    .some((v) => (v ?? '').toLowerCase().includes(t));
}

/**
 * Arma la respuesta. Los conteos por estatus respetan origen, sucursal y búsqueda pero NO el
 * filtro de estatus: son los números que van en los botones para elegirlo.
 *
 * `[GP.10.0]` Sin filtro de estatus («Todos»), los CANCELADOS no entran a la lista ni a los totales:
 * un cancelado no es trabajo pendiente ni venta. Tienen su propio conteo y se ven eligiéndolo.
 */
export function armarRespuesta(
  rows: WarehouseOrderRow[],
  filtros: Filtros,
  per: { from: string; to: string },
  alcance: WarehouseOrdersAlcance,
  generadoEn: Date,
  pagina: Pagina | null = null,
): WarehouseOrdersResponse {
  // [GP.10.5] Las sucursales del periodo, antes de cualquier filtro: son las opciones del selector
  // (antes salían de las filas que llegaban, y elegir una dejaba sólo ésa en la lista de opciones).
  const sucursalesPeriodo = new Map<string, string>();
  for (const r of rows) if (r.sucursal && !sucursalesPeriodo.has(r.sucursal)) sucursalesPeriodo.set(r.sucursal, r.sucursal_nombre);
  const base = rows.filter(
    (r) =>
      (!filtros.origen || r.origen === filtros.origen) &&
      (!filtros.sucursal || r.sucursal === filtros.sucursal) &&
      (!filtros.q || coincideTexto(r, filtros.q)),
  );

  const porEstatus = new Map<string, { pedidos: number; renglones: number; mas_antiguo_horas: number | null }>();
  for (const e of WAREHOUSE_ORDER_ESTATUS) porEstatus.set(e, { pedidos: 0, renglones: 0, mas_antiguo_horas: null });
  // Preventa no tiene estatus de Kepler: va sólo en los conteos por etapa (no inventa un «sin estatus»).
  for (const r of base.filter((x) => x.origen !== ORIGEN_PREVENTA)) {
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

  // [GP.10.3] Por etapa de almacén: el flujo en su orden (aunque esté en cero), y al final cancelado y
  // sin_dato sólo si hay. Sin los filtros de estatus ni de etapa: son los números de sus botones.
  const porEtapa = new Map<string, { pedidos: number; con_desfase: number }>();
  for (const e of ETAPAS_PEDIDO) porEtapa.set(e, { pedidos: 0, con_desfase: 0 });
  for (const r of base) {
    const c = porEtapa.get(r.etapa) ?? { pedidos: 0, con_desfase: 0 };
    c.pedidos += 1;
    if (r.desfase) c.con_desfase += 1;
    porEtapa.set(r.etapa, c);
  }
  const conteos_etapa = [...porEtapa.entries()].map(([etapa, c]) => ({ etapa: etapa as EtapaPedido, ...c }));

  const pasaEtapa = (r: WarehouseOrderRow): boolean =>
    filtros.estatus.length || filtros.etapa.length
      ? (!filtros.estatus.length || filtros.estatus.includes(r.estatus ?? 'SIN ESTATUS')) &&
        (!filtros.etapa.length || filtros.etapa.includes(r.etapa))
      : !esCancelado(r);
  const filtrados = base.filter(pasaEtapa).sort(ordenLista);

  // [GP.RF.21] Por origen: sucursal, búsqueda y el MISMO filtro de etapa/estatus que la lista, pero SIN el
  // de origen. Es el número del botón «Preventa»: lo que verá al tocarlo.
  const porOrigen = new Map<string, number>();
  for (const r of rows) {
    if ((filtros.sucursal && r.sucursal !== filtros.sucursal) || (filtros.q && !coincideTexto(r, filtros.q)) || !pasaEtapa(r)) continue;
    const o = r.origen ?? 'SIN ORIGEN';
    porOrigen.set(o, (porOrigen.get(o) ?? 0) + 1);
  }
  const conteos_origen = [...porOrigen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([origen, pedidos]) => ({ origen, pedidos }));
  const totales = filtrados.reduce(
    (t, r) => ({
      pedidos: t.pedidos + 1,
      renglones: t.renglones + r.renglones,
      importe: t.importe + (r.importe ?? 0),
      // [GP.10.5] El más antiguo sin embarcar de TODO lo filtrado: con página, la pantalla ya no lo
      // puede sacar de lo que le llega.
      mas_antiguo_horas:
        r.horas_abierto != null && (t.mas_antiguo_horas == null || r.horas_abierto > t.mas_antiguo_horas)
          ? r.horas_abierto
          : t.mas_antiguo_horas,
    }),
    { pedidos: 0, renglones: 0, importe: 0, mas_antiguo_horas: null as number | null },
  );
  totales.importe = Math.round(totales.importe * 100) / 100;
  // [GP.10.5] D4: el total separado por destino. Sumar el traspaso como venta la inflaba (noviembre:
  // $22.1 M de $35.3 M de Kepler eran traspasos a sucursal).
  const porDestino: Record<DestinoImporte, number> = { clientes: 0, traspaso_sucursal: 0, carga_ruta: 0 };
  for (const r of filtrados) porDestino[destinoDe(r.cliente_code)] += r.importe ?? 0;
  for (const k of Object.keys(porDestino) as DestinoImporte[]) porDestino[k] = Math.round(porDestino[k] * 100) / 100;

  const desde = pagina ? pagina.offset : 0;
  const hasta = pagina ? pagina.offset + pagina.limit : LIMITE_ITEMS;
  return {
    periodo: per,
    alcance,
    filtros,
    conteos,
    conteos_etapa,
    conteos_origen,
    totales: { ...totales, importe_por_destino: porDestino },
    items: filtrados.slice(desde, hasta),
    // Con página no hay tope: cada pedido está en alguna página y `pagina.total` dice cuántos son.
    truncado: !pagina && filtrados.length > LIMITE_ITEMS,
    pagina: pagina ? { offset: pagina.offset, limit: pagina.limit, total: filtrados.length } : undefined,
    sucursales_periodo: [...sucursalesPeriodo.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([codigo, nombre]) => ({ codigo, nombre })),
    generado_en: generadoEn.toISOString(),
  };
}

/**
 * `[MCP.3.2]` La respuesta del tablero sin dinero, para quien la ve sólo como surtidor (no tiene
 * `ALMACEN_PEDIDOS_VER`). Su pantalla muestra pedido y cliente; los importes no tienen por qué
 * viajar al celular aunque no se pinten. Se quitan en el servidor, no en la pantalla.
 */
export function sinImportes(r: WarehouseOrdersResponse): WarehouseOrdersResponse {
  return {
    ...r,
    totales: { ...r.totales, importe: null, importe_por_destino: null },
    items: r.items.map((x) => ({ ...x, importe: null })),
  };
}
