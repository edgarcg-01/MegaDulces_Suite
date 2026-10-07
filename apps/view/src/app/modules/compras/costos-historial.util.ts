import { RespuestaHistorial, VeredictoEntrada } from './costo-estandar.service';

/**
 * `[CAT-COSTO.5]` Lo que la pantalla del historial hace con la respuesta: mezclar las dos historias
 * en una línea de tiempo, aplicar los filtros y calcular la gráfica. Funciones puras, con prueba,
 * para que la plantilla sólo pinte.
 */

export type TipoEvento = 'estandar' | 'entrada' | 'primera' | 'entrada_igual';
export type FiltroTipo = 'ambos' | 'estandar' | 'entrada';

export interface FiltrosHistorial {
  sucursal: string | null;
  proveedor: string | null;
  tipo: FiltroTipo;
  incluirSinCambio: boolean;
}

export interface EventoTrazabilidad {
  fecha: string;
  sucursal: string | null;
  tipo: TipoEvento;
  antes: number | null;
  despues: number | null;
  cambio_pct: number | null;
  documento: string;
  nota: string;
  proveedor: string | null;
  vs_estandar_pct: number | null;
  veredicto: VeredictoEntrada | null;
  motivo: string | null;
}

const MOTIVO: Record<string, string> = {
  sin_plaza: 'no se sabe qué plaza recibió',
  unidad_sin_resolver: 'la unidad comprada no está en la escalera de la ficha',
  sin_estandar_previo: 'sin venta previa para saber el estándar de ese día',
};

export function eventosTrazabilidad(r: RespuestaHistorial, f: FiltrosHistorial): EventoTrazabilidad[] {
  const out: EventoTrazabilidad[] = [];

  if (f.tipo !== 'entrada') {
    for (const c of r.cambios_estandar) {
      if (f.sucursal && c.sucursal !== f.sucursal) continue;
      out.push({
        fecha: c.fecha,
        sucursal: c.sucursal,
        tipo: 'estandar',
        antes: c.antes,
        despues: c.despues,
        cambio_pct: c.cambio_pct,
        documento: 'Ficha de Kepler',
        nota: 'visto en la primera venta',
        // El estándar no tiene proveedor: el filtro de proveedor no lo esconde.
        proveedor: null,
        vs_estandar_pct: null,
        veredicto: null,
        motivo: null,
      });
    }
  }

  if (f.tipo !== 'estandar') {
    for (const e of r.entradas) {
      if (f.sucursal && e.plaza !== f.sucursal) continue;
      if (f.proveedor && e.proveedor !== f.proveedor) continue;
      const primera = e.antes === undefined;
      if (!primera && !e.cambio && !f.incluirSinCambio) continue;
      out.push({
        fecha: e.fecha,
        sucursal: e.plaza,
        tipo: primera ? 'primera' : e.cambio ? 'entrada' : 'entrada_igual',
        antes: e.antes ?? null,
        despues: e.costo_base,
        cambio_pct: e.cambio_pct,
        documento: e.folio,
        nota: e.unidad ? (e.factor && e.factor > 1 ? `${e.unidad} ÷ ${e.factor}` : e.unidad) : 'sin unidad',
        proveedor: e.proveedor,
        vs_estandar_pct: e.vs_estandar_pct,
        veredicto: e.veredicto,
        motivo: e.motivo ? (MOTIVO[e.motivo] ?? e.motivo) + (e.plaza_sin_kepler ? ` (${e.plaza_sin_kepler})` : '') : null,
      });
    }
  }

  // Lo más reciente arriba; el mismo día, el estándar antes que la entrada.
  return out.sort(
    (a, b) =>
      b.fecha.localeCompare(a.fecha) ||
      (a.tipo === 'estandar' ? -1 : 0) - (b.tipo === 'estandar' ? -1 : 0) ||
      (a.sucursal ?? '').localeCompare(b.sucursal ?? ''),
  );
}

export interface Grafica {
  /** `points` de un polyline en un lienzo de 1000 × 220. `''` si no hay estándar que dibujar. */
  linea: string;
  sucursalLinea: string | null;
  /** El estándar no se movió en el periodo o no hay venta: se dibuja plano y se dice. */
  lineaPlana: boolean;
  puntos: { x: number; y: number; titulo: string }[];
  ejeY: { y: number; t: string }[];
  ejeX: { x: number; t: string }[];
}

const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const W = 1000, X0 = 50, Y0 = 200, ALTO = 180;

export function graficaHistorial(r: RespuestaHistorial, f: FiltrosHistorial): Grafica {
  const t0 = Date.parse(`${r.desde}T00:00:00Z`);
  const t1 = Date.parse(`${r.hasta}T00:00:00Z`);
  const x = (iso: string) => X0 + Math.max(0, Math.min(1, (Date.parse(`${iso}T00:00:00Z`) - t0) / Math.max(1, t1 - t0))) * (W - X0);

  const suc = f.sucursal ?? r.estandar_hoy[0]?.sucursal ?? null;
  const cambios = r.cambios_estandar.filter((c) => c.sucursal === suc);
  const hoy = r.estandar_hoy.find((e) => e.sucursal === suc)?.costo ?? null;
  const inicio = (suc ? r.estandar_al_inicio[suc] : null) ?? cambios[0]?.antes ?? hoy;

  const entradas = r.entradas.filter(
    (e) => e.costo_base !== null && e.costo_base > 0 && (!f.sucursal || e.plaza === f.sucursal) && (!f.proveedor || e.proveedor === f.proveedor),
  );
  const valores = [inicio, hoy, ...cambios.map((c) => c.despues), ...entradas.map((e) => e.costo_base as number)].filter(
    (v): v is number => v !== null && v > 0,
  );
  const lo = valores.length ? Math.min(...valores) * 0.97 : 0;
  const hi = valores.length ? Math.max(...valores) * 1.03 : 1;
  const y = (v: number) => Y0 - ((v - lo) / Math.max(1e-9, hi - lo)) * ALTO;

  let linea = '';
  if (inicio !== null) {
    const pts: [number, number][] = [[X0, y(inicio)]];
    for (const c of cambios) {
      const cx = x(c.fecha);
      pts.push([cx, pts[pts.length - 1][1]], [cx, y(c.despues)]);
    }
    pts.push([W, pts[pts.length - 1][1]]);
    linea = pts.map(([a, b]) => `${a.toFixed(0)},${b.toFixed(0)}`).join(' ');
  }

  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return `${MES[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  };
  return {
    linea,
    sucursalLinea: suc,
    lineaPlana: cambios.length === 0,
    puntos: entradas.map((e) => ({
      x: Math.round(x(e.fecha)),
      y: Math.round(y(e.costo_base as number)),
      titulo: `${e.fecha} · ${e.plaza ?? 'sin plaza'} · $${(e.costo_base as number).toFixed(2)}`,
    })),
    ejeY: [0, 1, 2, 3].map((i) => ({ y: Y0 - (ALTO * i) / 3 + 4, t: `$${(lo + ((hi - lo) * i) / 3).toFixed(2)}` })),
    ejeX: [0, 0.25, 0.5, 0.75, 1].map((p) => ({
      x: Math.round(X0 + p * (W - X0) - (p === 1 ? 40 : 0)),
      t: fmt(new Date(t0 + (t1 - t0) * p).toISOString().slice(0, 10)),
    })),
  };
}
