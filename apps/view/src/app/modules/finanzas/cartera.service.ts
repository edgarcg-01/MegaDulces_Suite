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
  saldo: number; vencido: number; n_partidas: number; aging: AgingBucket;
}
export interface CarteraFiltros { sucursales: string[]; grupos: string[]; zonas: string[]; vendedores: string[] }
export interface CarteraResumen {
  hoy: string; saldo_total: number; vencido_total: number; pct_vencido: number; dso: number | null; ventas_90d: number; n_clientes: number;
  concentracion: { top10_pct: number; top10: { cliente_code: string; saldo: number }[] };
  por_vendedor: { vendedor: string; saldo: number; vencido: number; n_clientes: number }[];
  por_zona: { zona: string; saldo: number; vencido: number }[];
}
export interface CarteraResp {
  hoy: string;
  kpi: { total_saldo: number; total_vencido: number; n_clientes: number; n_partidas: number; n_sobre_linea: number; aging: AgingBucket };
  clientes: CarteraCliente[]; total_clientes: number;
}

export interface Aplicacion { tipo: string; label: string; folio: string; fecha: string | null; monto: number }
export interface Partida {
  doc_tipo: string; doc_label: string; folio: string; folio_digital: string;
  fecha: string | null; vencimiento: string | null; importe: number; saldo_documento: number;
  dias_vencido: number | null; vencida: boolean; referencia: string | null;
  aplicaciones: Aplicacion[];
}
export interface CarteraDetalle {
  hoy: string;
  cliente: { sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null; grupo: string | null; zona: string | null; telefono: string | null; limite_credito: number | null; dias_credito: number | null };
  saldo: number; vencido: number;
  partidas: Partida[]; pagadas: number;
  abonos: { doc_label: string; folio: string; fecha: string | null; importe: number }[];
  cobranza: { n: number; monto: number; ultimo: string | null; con_ficha: number; validados: number } | null;
}

export interface CarteraQuery {
  sucursal?: string; cliente?: string; vendedor?: string; grupo?: string; zona?: string; from?: string; to?: string;
  incluir_saldados?: string; search?: string; limit?: number;
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
  resumen(q: { sucursal?: string; grupo?: string; zona?: string } = {}): Observable<CarteraResumen> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<CarteraResumen>(`${this.base}/resumen${qs ? '?' + qs : ''}`);
  }
  detalle(sucursal: string, cliente: string): Observable<CarteraDetalle> {
    return this.http.get<CarteraDetalle>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(cliente)}`);
  }
}
