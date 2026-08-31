import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** CXC (ADR-048) — cliente de Cartera de clientes / Partidas vivas (CxC). */

export interface AgingBucket { por_vencer: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number }
export interface CarteraCliente {
  sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null;
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
export interface CarteraFiltros { sucursales: string[]; grupos: string[]; zonas: string[]; vendedores: string[] }
export interface CarteraResumen {
  hoy: string; saldo_total: number; vencido_total: number; pct_vencido: number; dso: number | null; ventas_90d: number; n_clientes: number;
  pago: { n: number; promedio: number; mediana: number; tarde_30d: number } | null;
  concentracion: { top10_pct: number; top10: { cliente_code: string; saldo: number }[] };
  proyeccion: { vencido: number; d0_7: number; d8_15: number; d16_30: number; d30_plus: number; sin_fecha: number };
  por_vendedor: { vendedor: string; saldo: number; vencido: number; n_clientes: number }[];
  por_zona: { zona: string; saldo: number; vencido: number }[];
}
export interface CarteraTendencia { fecha: string; saldo_total: number; vencido_total: number; n_clientes: number; pct_vencido: number }
export interface CarteraResp {
  hoy: string;
  kpi: { total_saldo: number; total_vencido: number; n_clientes: number; n_partidas: number; n_sobre_linea: number; total_a_favor: number; n_a_favor: number; aging: AgingBucket };
  clientes: CarteraCliente[]; total_clientes: number;
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
  cliente: { sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null; grupo: string | null; zona: string | null; telefono: string | null; limite_credito: number | null; dias_credito: number | null };
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
  resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada'): Observable<{ id: string; estado: string }> {
    return this.http.post<{ id: string; estado: string }>(`${this.base}/promise/${encodeURIComponent(id)}/resolve`, { estado });
  }
}
