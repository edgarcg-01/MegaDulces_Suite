import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Freshness } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** CXC (ADR-048) — cliente de Cartera de clientes / Partidas vivas (CxC). */

export interface AgingBucket { por_vencer: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number }
export interface CarteraCliente {
  sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null;
  /** `[CXC.20]` Nombre del vendedor resuelto por (sucursal, código) contra `kduv`. */
  vendedor_nombre: string | null;
  grupo: string | null; zona: string | null; telefono: string | null;
  limite_credito: number | null; dias_credito: number | null; uso_linea: number | null; sobre_linea: boolean;
  saldo: number; vencido: number; n_partidas: number; n_saldadas: number; aging: AgingBucket;
  /** Parte del saldo que ningún documento explica (kdm5 aplicó más de lo que kdue justifica). */
  sin_documento: number;
  /** Saldo a favor del cliente (pagó de más / anticipo sin aplicar). */
  saldo_a_favor: number;
  /** Días promedio que tarda en pagar, medido sobre sus facturas ya saldadas. */
  dias_pago_prom: number | null; n_pagos: number;
}
/**
 * ⭐ `[CXC.20]` Opciones de filtro **derivadas del servidor**. La pantalla ya NO trae su propia
 * lista de sucursales: la que tenía se quedó en `01`..`06` y dejaba fuera de todo filtro la `00`
 * ($44.4M), la `07` y la `08` — el 78.5% de la cartera, sólo alcanzable eligiendo «Todas».
 */
export interface SucursalOpt {
  code: string;
  /** `código · nombre`, con el nombre de `commercial.warehouses`. */
  label: string;
  /** El código existe en la cartera pero no en el catálogo de almacenes: se muestra pelado. */
  sin_catalogo: boolean;
}
export interface VendedorOpt { code: string; sucursal: string; label: string }
export interface CarteraFiltros { sucursales: SucursalOpt[]; grupos: string[]; zonas: string[]; vendedores: VendedorOpt[] }

/** Lo que el desglose por documento no alcanza a explicar. Ver `CarteraResumen.sin_documento`. */
export interface SinDocumento { monto: number; clientes: number }

export interface CarteraResumen {
  hoy: string; saldo_total: number; vencido_total: number; pct_vencido: number; dso: number | null; ventas_90d: number; n_clientes: number;
  pago: { n: number; promedio: number; mediana: number; tarde_30d: number } | null;
  concentracion: { top10_pct: number; top10: { cliente_code: string; saldo: number }[] };
  proyeccion: { vencido: number; d0_7: number; d8_15: number; d16_30: number; d30_plus: number; sin_fecha: number };
  por_vendedor: { sucursal: string; vendedor: string; vendedor_nombre: string | null; saldo: number; vencido: number; n_clientes: number }[];
  por_zona: { zona: string; saldo: number; vencido: number }[];
  /** Los dos rollups reparten por DOCUMENTO: suman `saldo_total − sin_documento`, no `saldo_total`. */
  base_rollups: 'documento';
  sin_documento: SinDocumento;
}
export interface CarteraTendencia { fecha: string; saldo_total: number; vencido_total: number; n_clientes: number; pct_vencido: number }
export interface CarteraResp {
  hoy: string;
  /** Edad real del dato (carriles del ODS), no la hora en que respondió el servidor. ADR-056. */
  freshness: Freshness;
  kpi: {
    total_saldo: number; total_vencido: number; n_clientes: number; n_partidas: number;
    n_sobre_linea: number; total_a_favor: number; n_a_favor: number; aging: AgingBucket;
    sin_documento: SinDocumento;
  };
  clientes: CarteraCliente[]; total_clientes: number;
  /** `[CXC.20]` Viajan en la MISMA respuesta: una sola pasada, imposible que se contradigan. */
  resumen: CarteraResumen;
  filtros: CarteraFiltros;
}

export interface Aplicacion { tipo: string; label: string; folio: string; fecha: string | null; monto: number }
export interface Partida {
  doc_tipo: string; doc_label: string; doc_code: string; folio: string; folio_digital: string;
  fecha: string | null; vencimiento: string | null; importe: number; saldo_documento: number;
  /** Lo que dicen las aplicaciones de kdm5; difiere de `saldo_documento` si hubo abono sin ubicar. */
  saldo_kdm5: number;
  dias_vencido: number | null; vencida: boolean; estatus: string | null;
  /** Saldada = ya cobrada por completo; `pagada_el` = fecha de la última aplicación. */
  saldada: boolean; pagada_el: string | null; dias_pago: number | null;
  aplicaciones: Aplicacion[];
}
export interface CarteraDetalle {
  hoy: string;
  freshness: Freshness;
  cliente: { sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null; vendedor_nombre: string | null; grupo: string | null; zona: string | null; telefono: string | null; limite_credito: number | null; dias_credito: number | null };
  saldo: number; vencido: number;
  saldo_a_favor: number; sin_documento: number; dias_pago_prom: number | null; n_pagos: number;
  partidas: Partida[]; pagadas: number; importe_pagado: number;
  abonos: { doc_label: string; folio: string; fecha: string | null; importe: number }[];
  cobranza: { n: number; monto: number; ultimo: string | null; con_ficha: number; validados: number } | null;
  compromisos: Compromiso[];
}
export interface Compromiso { id: string; monto_prometido: number; fecha_promesa: string; estado: string; nota: string | null; created_by: string | null; created_at: string }

export interface CarteraQuery {
  sucursal?: string; cliente?: string; vendedor?: string; grupo?: string; zona?: string; from?: string; to?: string;
  incluir_saldados?: string; search?: string; sort?: 'saldo' | 'vencido'; limit?: number;
}

/** `[CXC.SKU.1]` Un renglón de documento que tocó el producto buscado. */
export interface RenglonProducto {
  folio_digital: string; sucursal: string; folio: string; doc_prefix: string;
  linea: number; sku: string; descripcion: string | null; unidad: string | null;
  cantidad: number; importe: number;
  /** `cargo` = factura · `abono` = nota de crédito o devolución. */
  naturaleza: 'cargo' | 'abono';
  fecha: string | null;
}

export interface BusquedaProducto {
  texto: string;
  skus: string[];
  renglones: RenglonProducto[];
  /** Se cortó en el límite: hay más, no es que no haya. */
  truncado: boolean;
  /** Lo que la búsqueda NO cubre. La pantalla DEBE decirlo. */
  excluye: { doctypes: string[]; motivo: string };
}

@Injectable({ providedIn: 'root' })
export class CarteraService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/receivables`;

  cartera(q: CarteraQuery = {}): Observable<CarteraResp> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<CarteraResp>(`${this.base}${qs ? '?' + qs : ''}`);
  }
  filtros(): Observable<CarteraFiltros> {
    return this.http.get<CarteraFiltros>(`${this.base}/filtros`);
  }
  resumen(q: { sucursal?: string; grupo?: string; zona?: string; vendedor?: string; search?: string } = {}): Observable<CarteraResumen> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<CarteraResumen>(`${this.base}/resumen${qs ? '?' + qs : ''}`);
  }
  tendencia(q: { sucursal?: string; dias?: number } = {}): Observable<CarteraTendencia[]> {
    const p = new URLSearchParams();
    if (q.sucursal) p.set('sucursal', q.sucursal);
    if (q.dias) p.set('dias', String(q.dias));
    const qs = p.toString();
    return this.http.get<CarteraTendencia[]>(`${this.base}/tendencia${qs ? '?' + qs : ''}`);
  }
  detalle(sucursal: string, cliente: string): Observable<CarteraDetalle> {
    return this.http.get<CarteraDetalle>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(cliente)}`);
  }
  createPromise(sucursal: string, cliente: string, body: { monto: number; fecha: string; nota?: string }): Observable<{ id: string; estado: string }> {
    return this.http.post<{ id: string; estado: string }>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(cliente)}/promise`, body);
  }
  /**
   * `[CXC.SKU.1]` Documentos que tocaron un producto: facturas Y notas de crédito o
   * devoluciones. `excluye` viaja a propósito — la pantalla tiene que DECIR que los
   * tickets de mostrador quedan fuera, o un resultado vacío se lee como "no se vendió".
   */
  buscarProducto(q: string, limit = 200): Observable<BusquedaProducto> {
    const params = new HttpParams().set('q', q).set('limit', String(limit));
    return this.http.get<BusquedaProducto>(`${this.base}/producto`, { params });
  }

  resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada'): Observable<{ id: string; estado: string }> {
    return this.http.post<{ id: string; estado: string }>(`${this.base}/promise/${encodeURIComponent(id)}/resolve`, { estado });
  }
}
