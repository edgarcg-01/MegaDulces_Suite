/**
 * `[SUP.2]` «Mi equipo hoy»: las reglas puras de la pantalla del supervisor en la app (sin HTTP).
 *
 * ⛔ No calcula nada que el servidor ya sepa: junta DOS respuestas que ya existen.
 *  · `visits/monitor` (`[MCP.3.7]`): su equipo (`supervisor_id`), el estado de la ruta y cada cliente
 *    del día — también los que NO se visitaron y las faltas medidas con GPS.
 *  · `vecinal-monitor/vendors` (`[MV.2]`): lo levantado en la app, lo cobrado en Kepler y la meta.
 * Si la segunda no se pudo leer, el dinero se DECLARA sin dato; no se pinta como cero.
 */
import type {
  VecinalVendorRow,
  VecinalVendorsResponse,
  VecinalVendorVisit,
  VisitMonitorRow,
  VisitMonitorStatus,
  VisitMonitorVendor,
} from '@megadulces/contracts';
import { NO_SALE_OPTIONS } from './visit-protocol';

export type Tono = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

/** Lo que se sabe del dinero de un vendedor. `sin_dato` = no se pudo leer; `no_vecinal` = su ruta no es vecinal. */
export type DineroVendedor =
  | { estado: 'medido'; levantado: number; cobrado: number | null; cobrado_motivo: string | null; meta: number | null; avance: number | null }
  | { estado: 'sin_dato'; motivo: string }
  | { estado: 'no_vecinal' };

export interface FilaEquipo {
  vendor: VisitMonitorVendor;
  dinero: DineroVendedor;
  /** 0 = lo primero que tiene que ver el supervisor. */
  prioridad: number;
  /** Por qué está arriba, en una frase. `null` = va bien. */
  aviso: string | null;
}

/** Cómo se lee la respuesta de ventas: la respuesta, o el motivo por el que no llegó. */
export type Ventas = { ok: true; data: VecinalVendorsResponse } | { ok: false; motivo: string };

export function dineroDe(userId: string, ventas: Ventas | null): DineroVendedor {
  if (!ventas) return { estado: 'sin_dato', motivo: 'Cargando la venta…' };
  if (!ventas.ok) return { estado: 'sin_dato', motivo: ventas.motivo };
  const r: VecinalVendorRow | undefined = ventas.data.rows.find((x) => x.user_id === userId);
  if (!r) return { estado: 'no_vecinal' };
  return {
    estado: 'medido',
    levantado: Number(r.ordered_total) || 0,
    cobrado: r.charged === null ? null : Number(r.charged),
    cobrado_motivo: r.charged_unmeasured_reason,
    meta: r.target === null ? null : Number(r.target),
    avance: r.progress_pct,
  };
}

/**
 * Quién va primero: faltas → no ha empezado (sólo HOY: un día pasado ya no se arregla) → visitas
 * abiertas sin cerrar → en ruta → terminó. Dentro de cada grupo, el que lleva menos avance.
 */
export function prioridadDe(v: VisitMonitorVendor, esHoy: boolean): { prioridad: number; aviso: string | null } {
  const c = v.counts;
  if (c.faltas > 0) return { prioridad: 0, aviso: `${c.faltas} ${c.faltas === 1 ? 'falta' : 'faltas'}: ${detalleFaltas(c.se_fue_sin_abrir, c.no_paso)}` };
  if (esHoy && v.day_state === 'sin_iniciar') return { prioridad: 1, aviso: 'No ha iniciado su ruta' };
  if (c.abiertas > 0) return { prioridad: 2, aviso: `${c.abiertas} ${c.abiertas === 1 ? 'visita abierta' : 'visitas abiertas'} sin cerrar` };
  if (!esHoy && v.day_state === 'sin_iniciar') return { prioridad: 2, aviso: 'No inició la ruta ese día' };
  if (v.day_state === 'en_ruta') return { prioridad: 3, aviso: null };
  return { prioridad: 4, aviso: null };
}

function detalleFaltas(seFue: number, noPaso: number): string {
  const p: string[] = [];
  if (seFue) p.push(`pasó y no abrió ${seFue}`);
  if (noPaso) p.push(`no pasó con ${noPaso}`);
  return p.join(' · ');
}

/** Avance de visitas: visitados / clientes de la ruta. `null` sin clientes (no se divide entre cero). */
export function avanceVisitas(v: VisitMonitorVendor): number | null {
  return v.counts.clientes > 0 ? Math.round((v.counts.visitados / v.counts.clientes) * 100) : null;
}

export function armarEquipo(vendors: VisitMonitorVendor[], ventas: Ventas | null, esHoy: boolean): FilaEquipo[] {
  return vendors
    .map((vendor) => ({ vendor, dinero: dineroDe(vendor.user_id, ventas), ...prioridadDe(vendor, esHoy) }))
    .sort((a, b) =>
      a.prioridad - b.prioridad
      || (avanceVisitas(a.vendor) ?? 101) - (avanceVisitas(b.vendor) ?? 101)
      || a.vendor.name.localeCompare(b.vendor.name, 'es'));
}

/** El resumen de arriba. El cobrado sólo se suma si TODOS los vecinales se midieron (si no, quedaría corto). */
export interface ResumenEquipo {
  vendedores: number;
  en_ruta: number;
  sin_iniciar: number;
  clientes: number;
  visitados: number;
  con_pedido: number;
  faltas: number;
  levantado: number | null;
  cobrado: number | null;
  cobrado_motivo: string | null;
}

export function resumenEquipo(filas: FilaEquipo[]): ResumenEquipo {
  const medidos = filas.map((f) => f.dinero).filter((d): d is Extract<DineroVendedor, { estado: 'medido' }> => d.estado === 'medido');
  const sinDato = filas.find((f) => f.dinero.estado === 'sin_dato')?.dinero as Extract<DineroVendedor, { estado: 'sin_dato' }> | undefined;
  const sinCobro = medidos.find((d) => d.cobrado === null);
  const s = (k: 'clientes' | 'visitados' | 'con_pedido' | 'faltas') => filas.reduce((a, f) => a + f.vendor.counts[k], 0);
  return {
    vendedores: filas.length,
    en_ruta: filas.filter((f) => f.vendor.day_state !== 'sin_iniciar').length,
    sin_iniciar: filas.filter((f) => f.vendor.day_state === 'sin_iniciar').length,
    clientes: s('clientes'),
    visitados: s('visitados'),
    con_pedido: s('con_pedido'),
    faltas: s('faltas'),
    levantado: sinDato || !medidos.length ? null : medidos.reduce((a, d) => a + d.levantado, 0),
    cobrado: sinDato || sinCobro || !medidos.length ? null : medidos.reduce((a, d) => a + (d.cobrado ?? 0), 0),
    cobrado_motivo: sinDato ? sinDato.motivo : sinCobro ? sinCobro.cobrado_motivo ?? 'Kepler no se pudo leer.' : !medidos.length ? 'Nadie del equipo tiene ruta vecinal ese día.' : null,
  };
}

/** `YYYY-MM-DD` del día anterior (aritmética en UTC: no la mueve el horario de verano). */
export function diaAnterior(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** «jue 6 nov». */
export function fechaCorta(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** El mensaje del servidor si lo hay; si no, el genérico. Un 403 se dice como falta de permiso. */
export function motivoDeError(e: unknown, generico: string): string {
  const x = e as { status?: number; error?: { message?: string | string[] } } | null;
  if (x?.status === 403) return 'Tu usuario no tiene permiso para ver esto.';
  if (x?.status === 0) return 'Sin conexión con el servidor.';
  const m = x?.error?.message;
  return (Array.isArray(m) ? m.join(' ') : m) || generico;
}

// ── Detalle de un vendedor ──

const ETIQUETA: Record<VisitMonitorStatus, { texto: string; tono: Tono; orden: number }> = {
  se_fue_sin_abrir: { texto: 'Pasó y no abrió', tono: 'bad', orden: 0 },
  no_paso: { texto: 'No pasó', tono: 'bad', orden: 0 },
  abierta: { texto: 'Abierta sin cerrar', tono: 'warn', orden: 1 },
  pendiente: { texto: 'Por visitar', tono: 'info', orden: 2 },
  sin_gps: { texto: 'Sin visita · sin GPS', tono: 'muted', orden: 3 },
  sin_ubicacion: { texto: 'Sin visita · cliente sin ubicación', tono: 'muted', orden: 3 },
  sin_pedido: { texto: 'Sin pedido', tono: 'info', orden: 4 },
  con_pedido: { texto: 'Con pedido', tono: 'ok', orden: 4 },
};

export function etiquetaCliente(status: VisitMonitorStatus): { texto: string; tono: Tono } {
  const e = ETIQUETA[status];
  return { texto: e.texto, tono: e.tono };
}

export function motivoNoVenta(key: string | null): string | null {
  if (!key) return null;
  return NO_SALE_OPTIONS.find((o) => o.key === key)?.label ?? key;
}

/** Minutos con el cliente, de la visita cerrada. `null` = no se cerró (no se sabe cuánto duró). */
export function minutosVisita(r: Pick<VisitMonitorRow, 'visited_at' | 'ended_at'>): number | null {
  if (!r.visited_at || !r.ended_at) return null;
  const m = (Date.parse(r.ended_at) - Date.parse(r.visited_at)) / 60_000;
  return Number.isFinite(m) && m >= 0 ? Math.round(m) : null;
}

/** Los clientes del día: primero lo que pide acción (faltas, abiertas, por visitar), luego lo hecho por hora. */
export function ordenarClientes(rows: VisitMonitorRow[]): VisitMonitorRow[] {
  return [...rows].sort((a, b) =>
    ETIQUETA[a.status].orden - ETIQUETA[b.status].orden
    || (a.visited_at ?? '').localeCompare(b.visited_at ?? '')
    || a.name.localeCompare(b.name, 'es'));
}

/** Lo que se le levantó y lo que Kepler le cobró a un cliente ese día (del detalle de `[MV.2]`). */
export function ventaDelCliente(customerId: string, visitas: VecinalVendorVisit[] | null): VecinalVendorVisit | null {
  return visitas?.find((v) => v.customer_id === customerId) ?? null;
}
