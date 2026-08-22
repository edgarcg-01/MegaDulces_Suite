import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** AX.2 — Documentos de venta al cliente. Lee las vistas en vivo de kepler_ods (frescura de segundos). */

export interface SalesDocRow {
  folio_digital: string; sucursal: string; warehouse_id: string | null;
  doc_prefix: string; doc_tipo: 'telemarketing' | 'credito'; doc_label: string; folio: string;
  fecha: string; vencimiento: string; dias_credito: number; limite_credito: string;
  cliente_code: string; cliente_nombre: string; cliente_rfc: string | null;
  vendedor_code: string | null; vendedor_nombre: string | null;
  canal: string | null; referencia: string | null;
  total: string; ieps: string; descuento: string; descuento_pct: string; subtotal: string;
  vencida: boolean; dias_vencida: number;
}
export interface SalesDocLine {
  linea: number; sku: string; descripcion: string; unidad: string;
  cantidad: string; precio_unitario: string; importe: string;
  factor_caja: string | null; product_id: string | null;
  descuento: number; neto: number;
  precio_con_descuento: number; precio_caja: number | null;
  precio_caja_con_descuento: number | null; cajas_equivalentes: number | null;
}
export interface SalesDocDetail extends SalesDocRow {
  cliente_domicilio: string | null; cliente_colonia: string | null;
  cliente_estado: string | null; cliente_cp: string | null; doc_origen: string | null;
  importe_bruto: number; lineas: SalesDocLine[];
}
export interface SalesDocsKpis {
  documentos: number; clientes: number; importe: string; descuento: string; vencidas: number;
}
export interface SalesDocsReport {
  rows: SalesDocRow[]; kpis: SalesDocsKpis;
  page: number; pageSize: number; range: { from: string; to: string };
}
export interface SalesDocsFiltros {
  vendedores: { vendedor_code: string; vendedor_nombre: string }[];
  sucursales: { warehouse_id: string; sucursal: string }[];
  doc_tipos: string[];
}
export interface SalesDocsQuery {
  from?: string; to?: string; warehouse_ids?: string; doc_tipo?: string;
  cliente_code?: string; vendedor_code?: string; search?: string;
  vencidas?: string; min?: string; page?: number; pageSize?: number;
}

@Injectable({ providedIn: 'root' })
export class SalesDocumentsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/sales-documents`;

  private params(q: SalesDocsQuery): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    }
    return p;
  }

  list(q: SalesDocsQuery): Observable<SalesDocsReport> {
    return this.http.get<SalesDocsReport>(this.base, { params: this.params(q) });
  }

  filtros(q: SalesDocsQuery): Observable<SalesDocsFiltros> {
    return this.http.get<SalesDocsFiltros>(`${this.base}/filtros`, { params: this.params(q) });
  }

  detail(folio: string): Observable<SalesDocDetail> {
    return this.http.get<SalesDocDetail>(`${this.base}/${encodeURIComponent(folio)}`);
  }

  /** URL del PDF. Se abre en pestaña nueva (Content-Disposition: inline) para ver o imprimir. */
  anexoUrl(folio: string, conPagare = false): string {
    return `${this.base}/${encodeURIComponent(folio)}/anexo.pdf${conPagare ? '?pagare=true' : ''}`;
  }

  /** Descarga el PDF como blob — necesario para imprimir: el <iframe> tiene que llevar el JWT. */
  anexoBlob(folio: string, conPagare = false): Observable<Blob> {
    return this.http.get(this.anexoUrl(folio, conPagare), { responseType: 'blob' });
  }
}
