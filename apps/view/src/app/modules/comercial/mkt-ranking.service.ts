import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { coincideBusqueda } from '@megadulces/ui-web';
import { environment } from '../../../environments/environment';

/**
 * `[MKT.11]` — Ranking de promociones e incentivos de Marketing (reemplaza el Excel «RANKING SEMANA NN»).
 * Espejo de `libs/commercial/src/lib/mkt-ranking/mkt-ranking.service.ts`.
 *
 * ⚠️ `null` NO es cero: `objetivo: null` = sin objetivo capturado (no se puede medir) y
 * `cubrimiento: null` lo mismo; `puntaje: null` = ningún objetivo, sin lugar en el ranking.
 */

export type Canal = 'mostrador' | 'preventa' | 'ruta' | 'mayoreo';
export const CANALES: Canal[] = ['mostrador', 'preventa', 'ruta', 'mayoreo'];
export const CANAL_CORTO: Record<Canal, string> = {
  mostrador: 'Sucursales', preventa: 'Vecinal', ruta: 'Rutas', mayoreo: 'Telemarketing',
};
export const CANAL_LARGO: Record<Canal, string> = {
  mostrador: 'Sucursales (mostrador)', preventa: 'Vecinal (preventa)', ruta: 'Rutas', mayoreo: 'Telemarketing (mayoreo)',
};

/** [MKT.15] Cómo se supo el producto de la promo: Kepler no guarda la liga, se deriva del ticket. */
export type MetodoProducto = 'mismo_codigo' | 'ticket_y_nombre' | 'sin_identificar' | 'pocos_tickets';
export interface ProductoIdentificado { sku: string; nombre: string | null; tickets: number; pct: number | null }
export interface ProductosDePromo { metodo: MetodoProducto; tickets: number; productos: ProductoIdentificado[]; nota: string }
export interface VentaProductoPromo { sku: string; nombre: string | null; unidades: number; cajas: number | null }

const fmt = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 2 });
/** «LECHE ENTERA 1L (99891): 120 pz · 10 cj» — sin factor de caja se dice, no se inventa. */
export function textoVentaProducto(p: VentaProductoPromo): string {
  const cajas = p.cajas === null ? 'sin factor de caja' : `${fmt(p.cajas)} cj`;
  return `${p.nombre ?? p.sku} (${p.sku}): ${fmt(p.unidades)} pz · ${cajas}`;
}
/** El producto en una línea, para el listado y el PDF. Sin producto, lo dice. */
export function textoProductos(metodo: MetodoProducto, nombres: string[]): string {
  if (nombres.length) return nombres.join(' · ');
  return metodo === 'pocos_tickets' ? 'Producto: aún sin tickets suficientes' : 'Producto sin identificar';
}

export interface Semana { lunes: string; domingo: string; numero: number; hasta: string; en_curso: boolean }

export interface RenglonRanking {
  promo_id: string;
  code: string;
  mecanica: string;
  objetivo: number | null;
  /** [MKT.17] fijo = lo fijó Marketing · dinamico = promedio de las 4 semanas previas, recalculado cada semana. */
  objetivo_fuente: 'fijo' | 'dinamico' | null;
  venta: number;
  cubrimiento: number | null;
  existencia: number | null;
  descripcion_distinta: boolean;
  /** [MKT.15] El producto que activa la promo (derivado del ticket) y su venta de la semana. */
  productos: VentaProductoPromo[];
  productos_metodo: MetodoProducto;
  productos_nota: string;
}

export interface ParticipanteRanking {
  clave: string;
  warehouse_code: string;
  warehouse_name: string;
  vendor_code: string;
  nombre: string;
  lugar: number | null;
  puntaje: number | null;
  con_objetivo: number;
  sin_objetivo: number;
  cumplidas: number;
  sin_venta: number;
  promos: RenglonRanking[];
  /**
   * [MKT.28]/[MKT.29] De dónde sale `nombre` fuera de mostrador: el chofer de la comisión, la persona
   * asignada en la Suite, el nombre de Kepler, o nadie (`sin_dato`: el nombre es «Ruta N»).
   */
  vendedor_fuente?: 'comision' | 'asignacion' | 'kepler' | 'sin_dato' | null;
  /** [MKT.28] Clave de la ruta (Kepler `1V001`, camioneta `501`). */
  ruta?: string | null;
  /** [MKT.28] Otras personas asignadas a la ruta en la Suite, además de `nombre`. */
  otros_vendedores?: string[];
}

export interface VendedoraEnRanking {
  lugar: number; warehouse_code: string; warehouse_name: string; person_code: string; nombre: string;
  tickets: number; aplicaciones: number; promos: Array<{ code: string; mecanica: string; cantidad: number }>;
}
export interface VendedorasSemana {
  tickets_con_promo: number;
  tickets_con_vendedora: number;
  personas: VendedoraEnRanking[];
  por_sucursal: Array<{ warehouse_code: string; tickets_con_promo: number; tickets_con_vendedora: number }>;
}

/** [MKT.24] Un proveedor de catalog.suppliers (la promo lo trae si Mercadotecnia se lo asignó). */
export interface ProveedorPromo { id: string; code: string; name: string }
/** [MKT.24] Valor del filtro «sin proveedor asignado». */
export const SIN_PROVEEDOR = 'sin';
/** [MKT.24] De dónde salió el proveedor: asignado por Mercadotecnia o derivado del producto que activa la promo. */
export type FuenteProveedor = 'asignado' | 'producto' | null;
/** [MKT.24] «HERSHEY» o «HERSHEY (del producto)»: lo derivado nunca se lee como capturado. */
export const nombreProveedor = (p: ProveedorPromo | null | undefined, fuente: FuenteProveedor | undefined): string =>
  (p ? p.name + (fuente === 'producto' ? ' (del producto)' : '') : 'Sin proveedor asignado');

export interface PromoEnRanking {
  promo_id: string; code: string; nombre: string;
  /** [MKT.24] null = ni asignado ni derivable del producto. */
  proveedor: ProveedorPromo | null;
  proveedor_fuente: FuenteProveedor;
  productos: string[]; productos_metodo: MetodoProducto;
  participantes: number; venta_total: number; objetivo_total: number;
  lugar: number | null; puntaje: number | null;
  con_objetivo: number; sin_objetivo: number; cumplidas: number; sin_venta: number;
}

/** [MKT.16] Estado de un renglón promo × participante, para el filtro «venta». */
export type EstadoVenta = 'todas' | 'cumplida' | 'no_cumplida' | 'sin_venta';
export function estadoDe(x: { venta: number; cubrimiento: number | null }): Exclude<EstadoVenta, 'todas'> | 'sin_objetivo' {
  if (!(x.venta > 0)) return 'sin_venta';
  if (x.cubrimiento === null) return 'sin_objetivo';
  return x.cubrimiento >= 1 ? 'cumplida' : 'no_cumplida';
}

export interface RankingSemana {
  semana: Semana;
  canal: Canal;
  canal_texto: string;
  promos_vigentes: number;
  /** [MKT.16] Todas las promos vigentes del canal, para el filtro. */
  promos_lista: Array<{ id: string; code: string; mecanica: string; proveedor_id: string | null }>;
  promo_filtrada: string | null;
  /** [MKT.24] Proveedores de las promos del canal con cuántas tiene cada uno; id null = sin asignar (al final). */
  proveedores_lista: Array<{ id: string | null; code: string | null; name: string; promos: number }>;
  proveedor_filtrado: string | null;
  promedio_general: number | null;
  participantes: ParticipanteRanking[];
  /** [MKT.16] El ranking de promociones (misma regla que el de participantes). */
  promos_ranking: PromoEnRanking[];
  /** [MKT.18] Quién vendió en mostrador (lo escriben las cajeras en su arqueo); null en otros canales. */
  vendedoras: VendedorasSemana | null;
  /**
   * [MKT.27] Códigos de barras de cada producto de las promos (`sku → códigos`), para la pistola.
   * null = el servidor no pudo leerlos; opcional porque una API anterior no lo manda.
   */
  codigos_barras?: Record<string, string[]> | null;
  criterio: string;
  consultado_at: string;
}

/**
 * [MKT.27] ¿El renglón del detalle coincide con lo buscado? Por promoción (mecánica y código),
 * producto (nombre y SKU), código de barras de sus productos (pistola o tecleado) y proveedor.
 * Palabra por palabra, sin acentos ni mayúsculas (`coincideBusqueda`).
 */
export function coincideRenglon(
  q: string,
  x: Pick<RenglonRanking, 'code' | 'mecanica' | 'productos'>,
  proveedor: string,
  codigos: Record<string, string[]> | null | undefined,
): boolean {
  const deProductos = x.productos.flatMap((p) => [p.sku, p.nombre, ...(codigos?.[p.sku] ?? [])]);
  return coincideBusqueda(q, x.mecanica, x.code, proveedor, ...deProductos);
}

export interface PromoMkt {
  id: string;
  code: string;
  descripcion_kepler: string | null;
  mecanica: string;
  vigencia_desde: string;
  vigencia_hasta: string | null;
  canales: Canal[];
  warehouse_codes: string[] | null;
  activo: boolean;
  notas: string | null;
  objetivos: number;
  updated_at: string;
  updated_by_username: string | null;
  productos?: ProductosDePromo;
  /** [MKT.24] El que asignó Mercadotecnia o, si no, el del producto que activa la promo (ver proveedor_fuente). */
  proveedor?: ProveedorPromo | null;
  proveedor_fuente?: FuenteProveedor;
}

export interface Objetivo {
  warehouse_code: string;
  canal: Canal;
  vendor_code: string;
  objetivo_semanal: number | null;
  fuente?: 'sugerido' | 'manual';
  updated_by_username?: string | null;
}

export interface Sugerido {
  promo_id: string;
  warehouse_code: string;
  canal: Canal;
  vendor_code: string;
  vendor_name: string;
  sugerido: number | null;
  semanas_historia: number;
}

export type TipoIncentivo = 'por_caja' | 'por_unidad' | 'por_monto' | 'por_cliente' | 'por_captura';
export const TIPO_INCENTIVO: Record<TipoIncentivo, string> = {
  por_caja: 'Por caja vendida',
  por_unidad: 'Por unidad vendida',
  por_monto: 'Por cada monto vendido',
  por_cliente: 'Por cliente distinto (semana)',
  por_captura: 'Por exhibidor colocado (captura)',
};

export interface Incentivo {
  id: string;
  nombre: string;
  tipo: TipoIncentivo;
  regla: string;
  pago: number;
  base_monto: number | null;
  redondeo: 'proporcional' | 'completo';
  skus: string[];
  productos: Array<{ sku: string; nombre: string | null }>;
  vigencia_desde: string;
  vigencia_hasta: string | null;
  canales: Canal[];
  warehouse_codes: string[] | null;
  activo: boolean;
  notas: string | null;
}

export interface ResultadoIncentivo {
  warehouse_code: string;
  warehouse_name: string;
  vendor_code: string;
  vendor_name: string;
  canal: Canal | null;
  semana_cantidad: number;
  acumulado_cantidad: number;
  acumulado_unidades: number;
  acumulado_pago: number;
  semana_pago: number;
  sin_resolver: number;
}

export interface IncentivoConResultado extends Incentivo {
  resultados: ResultadoIncentivo[];
  total_semana: number;
  total_acumulado: number;
  medido: boolean;
  nota_medicion: string | null;
}

export interface IncentivoDto {
  nombre?: string;
  tipo?: TipoIncentivo;
  pago?: number;
  base_monto?: number | null;
  redondeo?: 'proporcional' | 'completo';
  skus?: string[];
  vigencia_desde?: string;
  vigencia_hasta?: string | null;
  canales?: Canal[];
  warehouse_codes?: string[] | null;
  activo?: boolean;
  notas?: string | null;
}

// ─────────── [MKT.30]/[MKT.31] los dos rankings: promociones (toda la venta) y vendedores (lo cargado) ───────────

/** Cómo le dice Mercadotecnia a cada canal en el ranking de la semana (2026-11-18). */
export const CANAL_VENTA: Record<Canal, string> = {
  mostrador: 'Sucursales', preventa: 'Ruta vecinal', ruta: 'Ruta directa', mayoreo: 'Telemarketing',
};
/** El filtro de zona para las sucursales sin zona (nunca se adivina). */
export const SIN_ZONA = 'Sin zona';

/** `dinero: null` = la promoción no tiene producto identificado («sin dato»), NO cero. */
export interface DesglosePromo { paquetes: number; dinero: number | null }
export interface ObjetivoSucursal { fijo: number | null; mixto: boolean; automatico: number | null; sucursales: string[] }
export interface PromoVenta extends DesglosePromo {
  promo_id: string;
  code: string;
  nombre: string;
  objetivo: number | null;
  avance: number | null;
  por_canal: Array<DesglosePromo & { canal: Canal }>;
  por_sucursal: Array<DesglosePromo & { warehouse_code: string; nombre: string; zona: string; objetivo: number | null }>;
  productos_nombres: string[];
  /** [MKT.27] Los SKU del producto: la pistola lee un código de barras y se resuelve a uno de éstos. */
  productos_skus: string[];
  productos_metodo: MetodoProducto;
  /** [MKT.24] El proveedor (asignado o del producto), para buscarlo; null = ninguno. */
  proveedor: string | null;
  objetivo_sucursal: ObjetivoSucursal;
}

/**
 * [MKT.27] ¿La promo coincide con lo buscado? Nombre, código, proveedor, producto o SKU, y si lo
 * buscado es un código de barras (pistola), el de cualquiera de sus productos.
 */
export function coincidePromoVenta(q: string, p: PromoVenta, codigos: Record<string, string[]> | null): boolean {
  if (coincideBusqueda(q, p.nombre, p.code, p.proveedor ?? '', ...p.productos_nombres, ...p.productos_skus)) return true;
  const c = q.trim();
  return /^\d{8,14}$/.test(c) && !!codigos && p.productos_skus.some((s) => (codigos[s] ?? []).includes(c));
}
export interface PromoDeVendedor { code: string; nombre: string; paquetes: number; precio: number | null; total: number | null }
export interface VendedorVenta {
  clave: string;
  canal: Canal;
  warehouse_code: string;
  warehouse_name: string;
  vendedor: string;
  nombre: string;
  detalle: string;
  fuente: 'cajera' | 'comision' | 'asignacion' | 'kepler' | 'sin_dato';
  paquetes: number;
  tickets: number;
  total: number;
  promos_sin_dato: number;
  promos: PromoDeVendedor[];
}
export interface VentaSemana {
  semana: Semana;
  filtro: { canal: Canal | null; sucursal: string | null; zona: string | null };
  sucursales_lista: Array<{ code: string; nombre: string; zona: string }>;
  zonas_lista: string[];
  totales: { paquetes: number; objetivo: number | null; dinero: number; promos: number; promos_sin_dato: number };
  sucursal_top: { warehouse_code: string; nombre: string; zona: string; paquetes: number } | null;
  promos: PromoVenta[];
  /** [MKT.27] `sku → códigos de barras`; null = no se pudieron leer (la pantalla lo dice). */
  codigos_barras: Record<string, string[]> | null;
  vendedores: VendedorVenta[];
  mostrador: { tickets_con_promo: number; tickets_asignados: number } | null;
  dinero_contrastado: Record<Canal, boolean>;
  criterio: string;
  consultado_at: string;
}
export interface FiltroVenta { canal: Canal | null; sucursal: string | null; zona: string | null }

/**
 * Los canales cuyo dinero todavía no se contrastó contra Kepler, dentro del filtro. La pantalla lo
 * dice junto a la cifra (ADR-056): no se presenta como medido lo que no se midió.
 */
export function canalesSinContrastar(d: Pick<VentaSemana, 'dinero_contrastado'>, canal: Canal | null): Canal[] {
  return (canal ? [canal] : CANALES).filter((c) => !d.dinero_contrastado[c]);
}

/** «$1,234.50»; `null` → «sin dato» (no hay producto identificado), nunca $0. */
export const dinero = (v: number | null | undefined) =>
  v === null || v === undefined ? 'sin dato' : v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });

@Injectable({ providedIn: 'root' })
export class MktRankingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/mkt-ranking`;

  /** [MKT.30] Los dos rankings de la semana; los filtros los aplica el SERVIDOR (el total no repite renglones). */
  venta(semana: string | null, f: FiltroVenta): Observable<VentaSemana> {
    let p = new HttpParams();
    if (semana) p = p.set('semana', semana);
    if (f.canal) p = p.set('canal', f.canal);
    if (f.sucursal) p = p.set('sucursal', f.sucursal);
    if (f.zona) p = p.set('zona', f.zona);
    return this.http.get<VentaSemana>(`${this.base}/venta`, { params: p });
  }

  ranking(semana: string | null, canal: Canal, promo: string | null = null, sucursales: string[] = [], proveedor: string | null = null): Observable<RankingSemana> {
    let p = new HttpParams().set('canal', canal);
    if (semana) p = p.set('semana', semana);
    if (promo) p = p.set('promo', promo);
    if (proveedor) p = p.set('proveedor', proveedor);
    if (sucursales.length) p = p.set('sucursales', sucursales.join(','));
    return this.http.get<RankingSemana>(this.base, { params: p });
  }

  promos(todas = false): Observable<PromoMkt[]> {
    return this.http.get<PromoMkt[]>(`${this.base}/promos`, { params: todas ? { todas: '1' } : {} });
  }

  /** [MKT.24] Los proveedores activos, para asignarle uno a una promo. */
  proveedores(): Observable<ProveedorPromo[]> {
    return this.http.get<ProveedorPromo[]>(`${this.base}/proveedores`);
  }

  /** [MKT.24] Asigna (o quita con null) el proveedor de una promo. */
  asignarProveedor(id: string, supplierId: string | null): Observable<{ proveedor: ProveedorPromo | null }> {
    return this.http.put<{ proveedor: ProveedorPromo | null }>(`${this.base}/promos/${id}/proveedor`, { supplier_id: supplierId });
  }

  objetivos(id: string): Observable<Objetivo[]> {
    return this.http.get<Objetivo[]>(`${this.base}/promos/${id}/objetivos`);
  }

  guardarObjetivos(id: string, items: Objetivo[]): Observable<{ guardados: number; quitados: number }> {
    return this.http.put<{ guardados: number; quitados: number }>(`${this.base}/promos/${id}/objetivos`, { items });
  }

  sugerir(semana: string | null, aplicar: boolean, canal?: Canal): Observable<{ semana: Semana; sugeridos: Sugerido[]; aplicados: number }> {
    return this.http.post<{ semana: Semana; sugeridos: Sugerido[]; aplicados: number }>(
      `${this.base}/objetivos/sugerir`, { semana: semana ?? undefined, aplicar, canal });
  }

  incentivos(semana: string | null, todos = false): Observable<{ semana: Semana; incentivos: IncentivoConResultado[]; consultado_at: string }> {
    let p = new HttpParams();
    if (semana) p = p.set('semana', semana);
    if (todos) p = p.set('todos', '1');
    return this.http.get<{ semana: Semana; incentivos: IncentivoConResultado[]; consultado_at: string }>(`${this.base}/incentivos`, { params: p });
  }

  crearIncentivo(dto: IncentivoDto): Observable<Incentivo> {
    return this.http.post<Incentivo>(`${this.base}/incentivos`, dto);
  }

  editarIncentivo(id: string, dto: IncentivoDto): Observable<Incentivo> {
    return this.http.patch<Incentivo>(`${this.base}/incentivos/${id}`, dto);
  }

  borrarIncentivo(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.base}/incentivos/${id}`);
  }

  guardarCapturas(id: string, semana: string, items: Array<{ warehouse_code: string; vendor_code: string; cantidad: number }>): Observable<{ guardadas: number }> {
    return this.http.put<{ guardadas: number }>(`${this.base}/incentivos/${id}/capturas`, { semana, items });
  }
}

/** «95 %» con tope visual; `null` → guion (no se pudo medir). */
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);

/** «Semana 45 · 2 al 8 de nov» */
export function textoSemana(s: Semana): string {
  const fmt = (d: string, mes: boolean) => new Intl.DateTimeFormat('es-MX', { day: 'numeric', ...(mes ? { month: 'short' } : {}), timeZone: 'UTC' })
    .format(new Date(`${d}T00:00:00Z`)).replace('.', '');
  const mismoMes = s.lunes.slice(0, 7) === s.domingo.slice(0, 7);
  return `Semana ${s.numero} · ${fmt(s.lunes, !mismoMes)} al ${fmt(s.domingo, true)}${s.en_curso ? ' (en curso)' : ''}`;
}

/** Lunes de la semana anterior / siguiente. */
export const moverSemana = (lunes: string, semanas: number) =>
  new Date(Date.parse(`${lunes}T00:00:00Z`) + semanas * 7 * 86400000).toISOString().slice(0, 10);
