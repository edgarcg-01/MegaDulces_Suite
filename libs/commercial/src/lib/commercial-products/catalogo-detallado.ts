/**
 * Compras › Catálogo › vista DETALLADO: lo puro (sin base). La lista de Sencillo + «Este mes» con su
 * variación, las etiquetas (Líder, Nuevo, Caducidad) y el menú «Mostrar» con los filtros de compra.
 *
 * ⛔ Nada de reglas nuevas: todo sale del motor de la fase PF (`product-flow.ts`) o de Productos nuevos.
 *  - «Este mes» = la MISMA suma que `resumirProducto`: historia cerrada (`RESUMEN_HISTORIA_SQL`) + lo en
 *    vivo del corte a hoy (`VENTA_VIVO_SQL`), juntado por sucursal con `juntarPlaza` y `variacion`.
 *  - «Qué hacer» = el veredicto de `analizarCompra` (vía `ProductFlowService.list`).
 *  - «Para cuidar hoy» = la foto `analytics.product_flow_watch` (o su cálculo en vivo, que se declara).
 *  - «Nuevo · día N» = la misma regla que pintaba la vista anterior sobre Productos nuevos.
 */
import {
  juntarPlaza, variacion,
  type CaducidadResumen, type HistoriaPlaza, type Periodos, type VentaVivo, type VeredictoCompra,
} from './product-flow';
import type { CatalogoFila, ConteosCatalogo, MostrarCatalogo } from './catalogo-ficha';

/** Lo que puede elegirse en «Mostrar» de Detallado. Los cuatro de Sencillo + los de compra y cuidado. */
export type FiltroDetallado =
  | MostrarCatalogo
  | 'sin_proveedor'
  | 'comprar' | 'traspasar' | 'esperar' | 'sobra' | 'no_comprar'
  | 'lideres_pendiente' | 'no_se_venden' | 'caducidad' | 'nuevos';

export const FILTROS_VEREDICTO = ['comprar', 'traspasar', 'esperar', 'sobra', 'no_comprar'] as const satisfies readonly VeredictoCompra[];
export type FiltroVeredicto = (typeof FILTROS_VEREDICTO)[number];
export const FILTROS_CUIDAR = ['lideres_pendiente', 'no_se_venden', 'caducidad', 'nuevos'] as const;
export const FILTROS_CATALOGO = ['todos', 'varios_codigos', 'sin_codigo', 'sin_precio', 'sin_proveedor'] as const;
export const FILTROS_DETALLADO: readonly FiltroDetallado[] = [...FILTROS_VEREDICTO, ...FILTROS_CUIDAR, ...FILTROS_CATALOGO];

/**
 * Hasta cuántos productos se calcula «Qué hacer» al momento: el tope de `ProductFlowService.list` (una
 * página del catálogo). Medido en prod el 2026-10-12: 269 productos de un proveedor tardan 1.1–1.9 s; el
 * catálogo entero (~11 mil activos) no cabe en una petición. Con más, el filtro se DECLARA sin medir.
 */
export const TOPE_VEREDICTO = 200;

export type OrdenDetallado = 'producto' | 'mes';
export type DireccionOrden = 'asc' | 'desc';

/** La etiqueta de caducidad del renglón, de la MISMA lista que «Para cuidar hoy › Caducan antes de venderse». */
export type EtiquetaCaducidad = 'caducado' | 'pronto';

/** Un renglón de Detallado: el de Sencillo + venta del mes y etiquetas. */
export interface FilaDetallada extends CatalogoFila {
  /** Venta con impuestos del 1 a hoy. null = no se pudo medir (se declara; nunca $0). */
  mes: number | null;
  /** Los mismos días del mes anterior. null = no se pudo medir. */
  mesAnterior: number | null;
  /** null = sin base para comparar (el mes anterior no vendió) o no medido. */
  variacion: number | null;
  /** Lugar en la venta de la red (Líder #N). null = no es líder (o no se midió: ver `etiquetas`). */
  lider: number | null;
  /** «Nuevo · día 12» / «Nuevo · sin movimiento». */
  nuevo: string | null;
  caducidad: EtiquetaCaducidad | null;
}

/** Conteo de una opción: número, o null = no se pudo medir (con su porqué en `notas`). */
export type ConteosDetallado = Record<FiltroDetallado, number | null>;

export interface CatalogoListaDetallada {
  vista: 'detallado';
  sucursal: string;
  /** Total del filtro aplicado (el que pagina). */
  total: number;
  filas: FilaDetallada[];
  calculado_al: string;
  /** El filtro que el servidor APLICÓ (uno no medible cae a «todos»). */
  mostrar: FiltroDetallado;
  orden: OrdenDetallado;
  dir: DireccionOrden;
  /** Conteos de la BÚSQUEDA entera (no dependen del filtro elegido). */
  conteos: ConteosDetallado;
  /** Por qué un conteo es null, o qué parte cubre (p. ej. «los 300 de más dinero detenido»). */
  notas: Partial<Record<FiltroDetallado, string>>;
  /** La venta del mes: periodo, edad y si se pudo medir. Sin medir, la columna dice «Sin dato» y no se ordena por ella. */
  venta: { medida: boolean; calculado_al: string | null; periodos: Pick<Periodos, 'hoy' | 'mesIni' | 'prevIni' | 'prevFin' | 'dias'> | null };
  /** Si cada familia de etiquetas se pudo medir: si no, el renglón sin etiqueta NO quiere decir «no es». */
  etiquetas: { lider: boolean; caducidad: boolean; nuevo: boolean };
  /** De dónde salió «Para cuidar hoy». */
  cuidar: { fuente: 'foto' | 'en_vivo'; calculado_at: string } | null;
}

/** Un producto de la búsqueda, con lo necesario para contar, filtrar, ordenar y pintar. */
export interface FilaUniverso {
  id: string;
  sku: string | null;
  nombre: string;
  description: string | null;
  barcode: string | null;
  proveedor_id: string | null;
  proveedor: string | null;
  n_codigos: number | string | null;
  /** null = no medible (la base no tiene precio por sucursal). */
  sin_precio: boolean | null;
  sin_proveedor: boolean;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

export function filtroDetalladoValido(s: string | null | undefined): FiltroDetallado {
  const t = (s ?? '').trim() as FiltroDetallado;
  return FILTROS_DETALLADO.includes(t) ? t : 'todos';
}
export function ordenValido(s: string | null | undefined): OrdenDetallado {
  return s === 'producto' ? 'producto' : 'mes';
}
export function direccionValida(s: string | null | undefined, orden: OrdenDetallado): DireccionOrden {
  if (s === 'asc' || s === 'desc') return s;
  return orden === 'producto' ? 'asc' : 'desc';
}

export interface VentaMes { mes: number; ant: number; variacion: number | null }

/**
 * «Este mes» de cada producto: por sucursal, la historia cerrada + lo en vivo (`juntarPlaza`), y la suma de
 * sus sucursales, con `variacion` — exactamente lo que hace `resumirProducto` con `mes` y `mes_anterior_mismo`.
 * Un producto sin una sola fila de venta no aparece: quien pinta lo trata como venta 0 MEDIDA (la historia
 * existe y no tiene venta), no como «sin dato».
 */
export function ventaMesDeProductos(
  p: Periodos,
  hist: HistoriaPlaza[],
  vivo: VentaVivo[],
  skuDe: Map<string, string>,
): Map<string, VentaMes> {
  const histPor = new Map<string, Map<string, HistoriaPlaza>>();
  for (const h of hist) {
    const m = histPor.get(h.product_id) ?? new Map<string, HistoriaPlaza>();
    m.set(h.plaza, h);
    histPor.set(h.product_id, m);
  }
  const vivoPor = new Map<string, Map<string, VentaVivo[]>>();
  for (const v of vivo) {
    const m = vivoPor.get(v.sku) ?? new Map<string, VentaVivo[]>();
    m.set(v.plaza, [...(m.get(v.plaza) ?? []), v]);
    vivoPor.set(v.sku, m);
  }
  const out = new Map<string, VentaMes>();
  for (const [id, sku] of skuDe) {
    const hs = histPor.get(id);
    const vs = vivoPor.get(sku);
    if (!hs && !vs) continue;
    const plazas = new Set([...(hs?.keys() ?? []), ...(vs?.keys() ?? [])]);
    let mes = 0;
    let ant = 0;
    for (const pl of plazas) {
      const j = juntarPlaza(p, hs?.get(pl), vs?.get(pl) ?? []);
      mes += j.mes;
      ant += j.mes_anterior_mismo;
    }
    mes = r2(mes);
    ant = r2(ant);
    out.set(id, { mes, ant, variacion: variacion(mes, ant) });
  }
  return out;
}

/** La caducidad del resumen de PF, como etiqueta: lo caducado primero; luego lo que no alcanza o caduca pronto. */
export function etiquetaCaducidad(c: CaducidadResumen | null | undefined): EtiquetaCaducidad | null {
  if (!c) return null;
  if (c.vencido > 0) return 'caducado';
  if (c.en_riesgo > 0 || c.por_caducar > 0) return 'pronto';
  return null;
}

/** «Nuevo · día N» / «Nuevo · sin movimiento»: la regla que pintaba la vista anterior sobre Productos nuevos. */
export function etiquetaNuevo(f: { estado: string; etapa: string; dia: number | null }): string | null {
  if (f.estado === 'seguimiento' && f.etapa !== 'graduado' && f.dia !== null) return `Nuevo · día ${f.dia}`;
  if (f.estado === 'sin_movimiento') return 'Nuevo · sin movimiento';
  return null;
}

/** Lo que dice «Para cuidar hoy» de cada producto (sólo los ids y lo que pinta el renglón). */
export interface Cuidado {
  lideres: Map<string, number>;
  lideresPendiente: Set<string>;
  noSeVenden: Set<string>;
  /** Cuántos no se venden en toda la red (la lista trae sólo los de más dinero detenido). */
  noSeVendenTotal: number;
  caducidad: Map<string, EtiquetaCaducidad>;
}

/** Saca de la respuesta de «Para cuidar hoy» los conjuntos que filtran y las etiquetas. */
export function cuidadoDe(c: {
  lideres: { lista: Array<{ motivos?: unknown[] | null; resumen: { product_id: string; lider: { rank: number } | null } }> };
  no_se_venden: { total: number; productos: Array<{ product_id: string }> };
  caducidad: { productos: Array<{ resumen: { product_id: string; caducidad: CaducidadResumen | null } }> };
}): Cuidado {
  const lideres = new Map<string, number>();
  const pendiente = new Set<string>();
  for (const x of c.lideres.lista) {
    if (x.resumen.lider) lideres.set(x.resumen.product_id, x.resumen.lider.rank);
    if (x.motivos?.length) pendiente.add(x.resumen.product_id);
  }
  const caducidad = new Map<string, EtiquetaCaducidad>();
  for (const x of c.caducidad.productos) {
    const e = etiquetaCaducidad(x.resumen.caducidad);
    if (e) caducidad.set(x.resumen.product_id, e);
  }
  return {
    lideres,
    lideresPendiente: pendiente,
    noSeVenden: new Set(c.no_se_venden.productos.map((x) => x.product_id)),
    noSeVendenTotal: c.no_se_venden.total,
    caducidad,
  };
}

/** Lo medido para filtrar: cada pieza puede faltar (null = no se pudo medir). */
export interface Medido {
  conPrecio: boolean;
  venta: Map<string, VentaMes> | null;
  cuidado: Cuidado | null;
  nuevos: Map<string, string> | null;
  /** Veredicto de cada producto de la búsqueda; null = no se calculó (búsqueda grande o falló). */
  veredicto: Map<string, VeredictoCompra> | null;
  /** Por qué no hay veredicto, para declararlo. */
  veredictoNota: string | null;
}

/** ¿Pasa la fila por el filtro? null = el filtro no se puede servir (no medido). */
export function pasa(f: FilaUniverso, filtro: FiltroDetallado, m: Medido): boolean | null {
  const n = num(f.n_codigos) ?? 0;
  switch (filtro) {
    case 'todos': return true;
    case 'varios_codigos': return n >= 2;
    case 'sin_codigo': return n === 0;
    case 'sin_precio': return m.conPrecio ? f.sin_precio === true : null;
    case 'sin_proveedor': return f.sin_proveedor;
    case 'lideres_pendiente': return m.cuidado ? m.cuidado.lideresPendiente.has(f.id) : null;
    case 'no_se_venden': return m.cuidado ? m.cuidado.noSeVenden.has(f.id) : null;
    case 'caducidad': return m.cuidado ? m.cuidado.caducidad.has(f.id) : null;
    case 'nuevos': return m.nuevos ? m.nuevos.has(f.id) : null;
    default: return m.veredicto ? m.veredicto.get(f.id) === filtro : null;
  }
}

/** Los conteos de todas las opciones sobre la búsqueda entera, con la nota de lo que no se midió o cubre parcial. */
export function contarDetallado(universo: FilaUniverso[], m: Medido): { conteos: ConteosDetallado; notas: Partial<Record<FiltroDetallado, string>> } {
  const conteos = {} as ConteosDetallado;
  for (const f of FILTROS_DETALLADO) {
    let n = 0;
    let medible = true;
    for (const x of universo) {
      const r = pasa(x, f, m);
      if (r === null) { medible = false; break; }
      if (r) n++;
    }
    conteos[f] = medible ? n : null;
  }
  const notas: Partial<Record<FiltroDetallado, string>> = {};
  if (!m.conPrecio) notas.sin_precio = 'No se puede medir: esta base no tiene el precio por sucursal';
  if (!m.veredicto) for (const f of FILTROS_VEREDICTO) notas[f] = m.veredictoNota ?? 'No se pudo calcular';
  if (!m.cuidado) {
    for (const f of ['lideres_pendiente', 'no_se_venden', 'caducidad'] as const) notas[f] = 'No se pudo cargar «Para cuidar hoy»';
  } else if (m.cuidado.noSeVendenTotal > m.cuidado.noSeVenden.size) {
    notas.no_se_venden = `Los ${m.cuidado.noSeVenden.size} de más dinero detenido, de ${m.cuidado.noSeVendenTotal} en la red`;
  }
  if (!m.nuevos) notas.nuevos = 'Productos nuevos no está calculado todavía';
  return { conteos, notas };
}

const colador = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Ordena por nombre o por la venta del mes; empate por nombre y luego por id (estable entre páginas). */
export function ordenarDetallado(
  xs: FilaUniverso[],
  orden: OrdenDetallado,
  dir: DireccionOrden,
  venta: Map<string, VentaMes> | null,
): FilaUniverso[] {
  const s = dir === 'asc' ? 1 : -1;
  const porNombre = (a: FilaUniverso, b: FilaUniverso) => colador.compare(a.nombre ?? '', b.nombre ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (orden === 'producto' || !venta) return [...xs].sort((a, b) => s * porNombre(a, b));
  const mes = (x: FilaUniverso) => venta.get(x.id)?.mes ?? 0;
  return [...xs].sort((a, b) => s * (mes(a) - mes(b)) || porNombre(a, b));
}

/** El renglón de Sencillo + lo de Detallado. */
export function filaDetallada(base: CatalogoFila, m: Medido): FilaDetallada {
  const v = m.venta ? m.venta.get(base.id) ?? { mes: 0, ant: 0, variacion: null } : null;
  return {
    ...base,
    mes: v ? v.mes : null,
    mesAnterior: v ? v.ant : null,
    variacion: v ? v.variacion : null,
    lider: m.cuidado?.lideres.get(base.id) ?? null,
    nuevo: m.nuevos?.get(base.id) ?? null,
    caducidad: m.cuidado?.caducidad.get(base.id) ?? null,
  };
}

/** Los conteos de las 4 opciones de Sencillo, en la forma de `armarConteos` (para no contar dos veces). */
export function conteosSencillo(c: ConteosDetallado): ConteosCatalogo {
  return { todos: c.todos ?? 0, variosCodigos: c.varios_codigos ?? 0, sinCodigo: c.sin_codigo ?? 0, sinPrecio: c.sin_precio };
}

// ─────────────────────────────── Compras de 90 días (la ficha) ───────────────────────────────

export interface Compras90 {
  /** Primer día de la ventana (incluido). */
  desde: string;
  dias: number;
  /** Entradas de mercancía (documentos XA20) en la ventana. */
  entradas: number;
  /** Lo comprado en la ventana, por la unidad en que se capturó (Kepler la escribe en cada renglón). */
  comprado: Array<{ unidad: string; cantidad: number }>;
  /** La primera entrada de la ventana. */
  primera: string | null;
  /** La última entrada (de cualquier fecha). */
  ultima: { fecha: string; sucursal: string; nombreSucursal: string | null; cantidad: number; unidad: string; costo: number | null } | null;
  costo_visible: boolean;
}

export function armarCompras90(
  desde: string,
  dias: number,
  filas: Array<{ docs: number | string; unidad: string; cantidad: number | string; primera: string | null }>,
  ultima: { sucursal: string; fecha: string; unidad: string; cantidad: number | string; costo: number | string | null } | null,
  nombreSucursal: string | null,
  puedeVerCosto: boolean,
): Compras90 {
  const conCantidad = filas.filter((f) => (num(f.cantidad) ?? 0) > 0);
  const primeras = conCantidad.map((f) => f.primera).filter((x): x is string => !!x).sort();
  return {
    desde,
    dias,
    // `docs` es el conteo de documentos DISTINTOS de toda la ventana (el SQL lo repite en cada renglón).
    entradas: conCantidad.length ? num(conCantidad[0].docs) ?? 0 : 0,
    comprado: conCantidad
      .map((f) => ({ unidad: f.unidad, cantidad: Math.round((num(f.cantidad) ?? 0) * 1000) / 1000 }))
      .sort((a, b) => b.cantidad - a.cantidad),
    primera: primeras[0] ?? null,
    ultima: ultima
      ? {
          fecha: ultima.fecha, sucursal: ultima.sucursal, nombreSucursal,
          cantidad: num(ultima.cantidad) ?? 0, unidad: ultima.unidad,
          costo: puedeVerCosto ? num(ultima.costo) : null,
        }
      : null,
    costo_visible: puedeVerCosto,
  };
}
