import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
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
  mostrador: 'Sucursales', preventa: 'Vecinal', ruta: 'Rutas', mayoreo: 'Televenta',
};
export const CANAL_LARGO: Record<Canal, string> = {
  mostrador: 'Sucursales (mostrador)', preventa: 'Vecinal (preventa)', ruta: 'Rutas', mayoreo: 'Televenta (mayoreo)',
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
  objetivo_fuente: 'sugerido' | 'manual' | null;
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
}

export interface RankingSemana {
  semana: Semana;
  canal: Canal;
  canal_texto: string;
  promos_vigentes: number;
  promedio_general: number | null;
  participantes: ParticipanteRanking[];
  criterio: string;
  consultado_at: string;
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
}

export interface PromoDto {
  code?: string;
  descripcion_kepler?: string | null;
  mecanica?: string;
  vigencia_desde?: string;
  vigencia_hasta?: string | null;
  canales?: Canal[];
  warehouse_codes?: string[] | null;
  activo?: boolean;
  notas?: string | null;
}

export interface CodigoKepler {
  code: string;
  descripcion: string;
  sucursales: string[];
  ultima_venta: string | null;
  ya_registrada: boolean;
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

@Injectable({ providedIn: 'root' })
export class MktRankingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/mkt-ranking`;

  ranking(semana: string | null, canal: Canal): Observable<RankingSemana> {
    let p = new HttpParams().set('canal', canal);
    if (semana) p = p.set('semana', semana);
    return this.http.get<RankingSemana>(this.base, { params: p });
  }

  promos(todas = false): Observable<PromoMkt[]> {
    return this.http.get<PromoMkt[]>(`${this.base}/promos`, { params: todas ? { todas: '1' } : {} });
  }

  codigosKepler(q: string): Observable<CodigoKepler[]> {
    return this.http.get<CodigoKepler[]>(`${this.base}/codigos-kepler`, { params: { q } });
  }

  crearPromo(dto: PromoDto): Observable<PromoMkt> {
    return this.http.post<PromoMkt>(`${this.base}/promos`, dto);
  }

  editarPromo(id: string, dto: PromoDto): Observable<PromoMkt> {
    return this.http.patch<PromoMkt>(`${this.base}/promos/${id}`, dto);
  }

  borrarPromo(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.base}/promos/${id}`);
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
