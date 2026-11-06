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
import { costoSinImpuestos, type CatalogoFila, type ConteosCatalogo, type EntradaCruda, type ImpuestoEntrada, type MostrarCatalogo } from './catalogo-ficha';
import type { Estado as EstadoNuevo, NewProductRow, Veredicto as VeredictoNuevo } from './new-products';

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

/**
 * `[NP.22]` `lanzamiento` = el orden de Productos nuevos (lo que pide atención primero: sacar, revisar, agotado…; y
 * dentro, lo más reciente). Sólo se sirve con su foto; sin ella cae a «producto».
 */
export type OrdenDetallado = 'producto' | 'mes' | 'lanzamiento';
export type DireccionOrden = 'asc' | 'desc';

/**
 * `[NP.22]` Lo que dice Productos nuevos de UN producto, para el renglón del catálogo: «¿funcionó?» y el día.
 * Sale de la MISMA respuesta que la pantalla de Productos nuevos (`NewProductsService.list`), sin recalcular nada.
 */
export interface Lanzamiento {
  estado: EstadoNuevo;
  etapa: string;
  /** Días desde el lanzamiento; null = todavía no entra ni se vende. */
  dia: number | null;
  /** El resultado del lanzamiento; null = no está en seguimiento (sin movimiento, no medible, excluido). */
  veredicto: VeredictoNuevo | null;
  /** La razón principal (el primer motivo del resultado, o por qué no se sigue). */
  motivo: string | null;
  /** Otro producto dado de alta antes tiene el mismo código de barras (y nadie lo clasificó). */
  posible_recodificacion: boolean;
  sin_venta_30: boolean;
  /** Su lugar en el orden de Productos nuevos (0 = lo que más pide atención). */
  orden: number;
  /** «Nuevo · día N» / «Nuevo · sin movimiento» (la etiqueta del renglón, `etiquetaNuevo`). */
  etiqueta: string | null;
}

/**
 * `[NP.22]` Los sub-filtros de «Mostrar › Productos nuevos»: los de la pantalla que se unió a Productos, con su
 * mismo significado (`pasaFiltro` de aquella pantalla). `seguimiento` es el de entrada: el universo del resumen.
 */
export const SUBFILTROS_LANZAMIENTO = [
  'seguimiento', 'sacar', 'revisar', 'agotado', 'se_queda', 'pronto',
  'sin_venta_30', 'sin_movimiento', 'no_medible', 'excluido',
] as const;
export type SubfiltroLanzamiento = (typeof SUBFILTROS_LANZAMIENTO)[number];
export type ConteosLanzamiento = Record<SubfiltroLanzamiento, number>;

export function subfiltroValido(s: string | null | undefined): SubfiltroLanzamiento {
  const t = (s ?? '').trim() as SubfiltroLanzamiento;
  return SUBFILTROS_LANZAMIENTO.includes(t) ? t : 'seguimiento';
}

/** ¿El producto entra en el sub-filtro? Sin lanzamiento (no es nuevo) nunca entra. */
export function pasaLanzamiento(l: Lanzamiento | null | undefined, sub: SubfiltroLanzamiento): boolean {
  if (!l) return false;
  switch (sub) {
    case 'seguimiento': return l.estado === 'seguimiento';
    case 'sin_venta_30': return l.estado === 'seguimiento' && l.sin_venta_30;
    case 'sin_movimiento': case 'no_medible': case 'excluido': return l.estado === sub;
    default: return l.estado === 'seguimiento' && l.veredicto === sub;
  }
}

/** Cuántos de la BÚSQUEDA caen en cada sub-filtro (no dependen del elegido). */
export function contarLanzamiento(universo: ReadonlyArray<Pick<FilaUniverso, 'id'>>, nuevos: Map<string, Lanzamiento>): ConteosLanzamiento {
  const c = Object.fromEntries(SUBFILTROS_LANZAMIENTO.map((s) => [s, 0])) as ConteosLanzamiento;
  for (const f of universo) {
    const l = nuevos.get(f.id);
    if (!l) continue;
    for (const s of SUBFILTROS_LANZAMIENTO) if (pasaLanzamiento(l, s)) c[s]++;
  }
  return c;
}

/** De un renglón de Productos nuevos (en su orden) a lo que pinta el catálogo. */
export function lanzamientoDe(
  f: Pick<NewProductRow, 'estado' | 'etapa' | 'dia' | 'recomendacion' | 'motivo' | 'posible_recodificacion' | 'clasificacion' | 'sin_venta_30'>,
  orden: number,
): Lanzamiento {
  const rec = f.estado === 'seguimiento' ? f.recomendacion : null;
  return {
    estado: f.estado,
    etapa: f.etapa,
    dia: f.dia,
    veredicto: rec?.veredicto ?? null,
    motivo: rec?.motivos?.[0] ?? f.motivo ?? null,
    posible_recodificacion: !!f.posible_recodificacion && !f.clasificacion,
    sin_venta_30: !!f.sin_venta_30,
    orden,
    etiqueta: etiquetaNuevo(f),
  };
}

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
  /** `[NP.22]` Lo que dice Productos nuevos del producto; null = no es nuevo (o no se midió: ver `etiquetas.nuevo`). */
  lanzamiento: Lanzamiento | null;
}

/** Conteo de una opción: número, o null = no se pudo medir (con su porqué en `notas`). */
export type ConteosDetallado = Record<FiltroDetallado, number | null>;

export interface CatalogoListaDetallada {
  vista: 'detallado';
  sucursal: string;
  /** `[PF.21]` Las sucursales de su alcance, para elegir de cuál es el PRECIO (lo pone el controlador). */
  sucursales?: { codigo: string; nombre: string }[];
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
  /** `[NP.22]` El sub-filtro de «Productos nuevos» que se APLICÓ; null = no se está mostrando «Productos nuevos». */
  resultado: SubfiltroLanzamiento | null;
  /** `[NP.22]` Cuántos de la búsqueda van en cada sub-filtro de «Productos nuevos»; null = Productos nuevos sin calcular. */
  conteos_lanzamiento: ConteosLanzamiento | null;
  /** Por qué un conteo es null, o qué parte cubre (p. ej. «los 300 de más dinero detenido»). */
  notas: Partial<Record<FiltroDetallado, string>>;
  /** La venta del mes: periodo, edad y si se pudo medir. Sin medir, la columna dice «Sin dato» y no se ordena por ella. */
  venta: { medida: boolean; calculado_al: string | null; periodos: Pick<Periodos, 'hoy' | 'mesIni' | 'prevIni' | 'prevFin' | 'dias'> | null };
  /** Si cada familia de etiquetas se pudo medir: si no, el renglón sin etiqueta NO quiere decir «no es». */
  etiquetas: { lider: boolean; caducidad: boolean; nuevo: boolean };
  /** De dónde salió «Para cuidar hoy». */
  cuidar: { fuente: 'foto' | 'en_vivo'; calculado_at: string } | null;
  /** `[PF.12.3]` Si los renglones traen `ultimoCosto` (la misma regla que Sencillo: `puedeVerCostoCatalogo`). */
  costo_visible: boolean;
  /** `[PF.12.3]` `false` = no se pudo leer ahora («Sin dato», no «Sin compras»); `null` = no se pidió. */
  costo_medido: boolean | null;
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
  return s === 'producto' || s === 'lanzamiento' ? s : 'mes';
}
export function direccionValida(s: string | null | undefined, orden: OrdenDetallado): DireccionOrden {
  if (s === 'asc' || s === 'desc') return s;
  return orden === 'mes' ? 'desc' : 'asc';
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
  /** `[PF.UI.3]` El dinero detenido de esos N, a costo. NULL = sin permiso de costo o no medido. */
  noSeVendenValor: number | null;
  /** `[PF.UI.3]` La consulta llegó a su tope: el total y el dinero son un MÍNIMO («N o más»). */
  noSeVendenMinimo: boolean;
  /** `[PF.15]` Los que se sacaron porque su sucursal los cargó a camioneta (su venta no está en Kepler). */
  noSeVendenCamioneta: number;
  caducidad: Map<string, EtiquetaCaducidad>;
}

/** Saca de la respuesta de «Para cuidar hoy» los conjuntos que filtran y las etiquetas. */
export function cuidadoDe(c: {
  lideres: { lista: Array<{ motivos?: unknown[] | null; resumen: { product_id: string; lider: { rank: number } | null } }> };
  no_se_venden: {
    total: number; productos: Array<{ product_id: string }>;
    valor_total?: number | null; total_es_minimo?: boolean; por_camioneta?: number;
  };
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
    noSeVendenValor: c.no_se_venden.valor_total ?? null,
    noSeVendenMinimo: c.no_se_venden.total_es_minimo === true,
    noSeVendenCamioneta: c.no_se_venden.por_camioneta ?? 0,
    caducidad,
  };
}

/** Lo medido para filtrar: cada pieza puede faltar (null = no se pudo medir). */
export interface Medido {
  conPrecio: boolean;
  venta: Map<string, VentaMes> | null;
  cuidado: Cuidado | null;
  /** `[NP.22]` Productos nuevos por producto (TODOS sus estados); null = no está calculado. */
  nuevos: Map<string, Lanzamiento> | null;
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
    // [NP.22] El universo del resumen de Productos nuevos: los que están en seguimiento (antes: los que llevaban la
    // etiqueta, que juntaba los de 90 días o menos con los que no se mueven y dejaba fuera los de 90 a 180 días).
    case 'nuevos': return m.nuevos ? pasaLanzamiento(m.nuevos.get(f.id), 'seguimiento') : null;
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
  } else {
    const nota = notaNoSeVenden(m.cuidado);
    if (nota) notas.no_se_venden = nota;
  }
  if (!m.nuevos) notas.nuevos = 'Productos nuevos no está calculado todavía';
  return { conteos, notas };
}

/**
 * `[PF.UI.3]` La nota de «No se venden»: cuántos de cuántos, si el total es un mínimo, el dinero detenido a
 * costo (sólo con permiso) y los que se sacaron porque salen por camioneta. NULL = no hay nada que aclarar.
 * «Los 300 de más dinero detenido, de 957 o más en la red ($1,234,567 a costo); fuera 12 que salen por camioneta».
 */
export function notaNoSeVenden(c: Pick<Cuidado, 'noSeVenden' | 'noSeVendenTotal' | 'noSeVendenValor' | 'noSeVendenMinimo' | 'noSeVendenCamioneta'>): string | null {
  const n = (v: number) => v.toLocaleString('es-MX');
  const valor = c.noSeVendenValor !== null
    ? ` (${new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(c.noSeVendenValor)} a costo)`
    : '';
  const red = `${n(c.noSeVendenTotal)}${c.noSeVendenMinimo ? ' o más' : ''} en la red${valor}`;
  const partes: string[] = [];
  if (c.noSeVendenTotal > c.noSeVenden.size) partes.push(`Los ${n(c.noSeVenden.size)} de más dinero detenido, de ${red}`);
  else if (c.noSeVendenMinimo || valor) partes.push(`Son ${red}`);
  if (c.noSeVendenCamioneta > 0) {
    partes.push(`fuera ${n(c.noSeVendenCamioneta)} que sale${c.noSeVendenCamioneta === 1 ? '' : 'n'} por camioneta`);
  }
  if (!partes.length) return null;
  const s = partes.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const colador = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/**
 * Ordena por nombre, por la venta del mes o (`[NP.22]`) por el orden de Productos nuevos; empate por nombre y luego por
 * id (estable entre páginas). Sin con qué ordenar (venta sin medir, o no es nuevo) va por nombre, o al final.
 */
export function ordenarDetallado(
  xs: FilaUniverso[],
  orden: OrdenDetallado,
  dir: DireccionOrden,
  venta: Map<string, VentaMes> | null,
  nuevos: Map<string, Lanzamiento> | null = null,
): FilaUniverso[] {
  const s = dir === 'asc' ? 1 : -1;
  const porNombre = (a: FilaUniverso, b: FilaUniverso) => colador.compare(a.nombre ?? '', b.nombre ?? '') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (orden === 'lanzamiento' && nuevos) {
    const lugar = (x: FilaUniverso) => nuevos.get(x.id)?.orden ?? Number.MAX_SAFE_INTEGER;
    return [...xs].sort((a, b) => s * (lugar(a) - lugar(b)) || porNombre(a, b));
  }
  if (orden !== 'mes' || !venta) return [...xs].sort((a, b) => s * porNombre(a, b));
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
    nuevo: m.nuevos?.get(base.id)?.etiqueta ?? null,
    caducidad: m.cuidado?.caducidad.get(base.id) ?? null,
    lanzamiento: m.nuevos?.get(base.id) ?? null,
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
  /**
   * La última entrada (de cualquier fecha). `[PF.12.3]` `costo` por `unidad`, SIN IVA ni IEPS (`costoSinImpuestos`,
   * el mismo número que el catálogo Sencillo); null si no se ve o si la entrada no trae costo.
   */
  ultima: {
    fecha: string; sucursal: string; nombreSucursal: string | null; cantidad: number; unidad: string; costo: number | null;
    impuesto: ImpuestoEntrada;
  } | null;
  /** `[PF.12.3]` La regla del catálogo (`puedeVerCostoCatalogo`), NO la del margen. */
  costo_visible: boolean;
  /** `[PF.23]` Último día de la ventana (incluido). */
  hasta?: string;
  /**
   * `[PF.23]` Sucursales cuyas compras del periodo NO están completas en Kepler: su corte cae dentro del periodo
   * (antes compraban en Wincaja) o no tienen corte. Se DICE: lo comprado no las cuenta enteras.
   */
  incompletas?: Array<{ codigo: string; nombre: string | null; corte: string | null }>;
}

/** `[PF.12.3]` La entrada llega de `ULTIMAS_ENTRADAS_SQL`: la misma consulta que Sencillo. */
export function armarCompras90(
  desde: string,
  dias: number,
  filas: Array<{ docs: number | string; unidad: string; cantidad: number | string; primera: string | null }>,
  ultima: EntradaCruda | null,
  nombreSucursal: string | null,
  puedeVerCosto: boolean,
): Compras90 {
  const sinImp = ultima ? costoSinImpuestos(ultima.costo, ultima.iva, ultima.ieps) : null;
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
    ultima: ultima && sinImp
      ? {
          fecha: ultima.fecha, sucursal: ultima.sucursal, nombreSucursal,
          cantidad: num(ultima.cantidad) ?? 0, unidad: ultima.unidad,
          costo: puedeVerCosto ? sinImp.costo : null,
          impuesto: sinImp.impuesto,
        }
      : null,
    costo_visible: puedeVerCosto,
  };
}
