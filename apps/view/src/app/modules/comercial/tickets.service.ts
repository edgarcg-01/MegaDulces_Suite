import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { TicketVenta } from './ticket-venta';

/**
 * Fase TK.2 — Cliente de `/commercial/tickets`.
 *
 * Servicio propio y no un método más en `ComercialService` (que ya pasa de 850 líneas): esta
 * pantalla habla con un solo controller y su tipo de retorno —`TicketVenta`— es el mismo que
 * consume el generador del ticket térmico, así que conviene que vivan juntos.
 */

export interface TicketCandidato {
  /** Identidad COMPLETA del documento: `03UD1001-0018665` o `PD-2026-00012`. */
  id: string;
  origen: 'mostrador' | 'telemarketing' | 'credito' | 'pedido';
  origen_label: string;
  sucursal: string | null;
  sucursal_nombre: string | null;
  caja: number | null;
  folio: string;
  fecha: string | null;
  cliente_nombre: string | null;
  total: string | null;
}

export interface TicketBusqueda {
  termino: string;
  candidatos: TicketCandidato[];
  /** true ⇒ había más de los que caben: hay que afinar el folio, no scrollear. */
  truncado: boolean;
  /**
   * `[TK.perf]` El documento YA RESUELTO cuando la búsqueda encontró **uno solo**.
   *
   * Existe para ahorrar un viaje de red: con un único candidato la pantalla abre el documento
   * sola, y pedirlo aparte costaba una ida y vuelta entera para ~5 ms de consulta. Viene `null`
   * con cero o con dos o más candidatos — y también si el servidor no pudo resolverlo, en cuyo
   * caso la pantalla lo pide como siempre. **Nunca se asume que está.**
   */
  documento?: TicketVenta | null;
}

/**
 * TK.8 — Un cliente del buscador: UNO por clave, no uno por plaza.
 *
 * ⚠️ La clave de Kepler es GLOBAL: el catálogo está replicado en las nueve sucursales (medido:
 * 1,862 de 2,395 claves existen en las nueve). Por eso la sucursal es un filtro posterior y no
 * parte de la identidad del cliente.
 */
export interface ClienteCandidato {
  cliente_code: string;
  nombre: string | null;
  ciudad: string | null;
  zona: string | null;
  /** En cuántas sucursales existe la clave, de las que alcanza quien pregunta. */
  plazas: number;
  /** La MISMA clave trae nombres distintos según la plaza: puede ser otra persona. */
  clave_ambigua: boolean;
  /** 1 = el nombre es idéntico a lo tecleado. Ordena la lista, no es alfabética. */
  score: number;
}

export interface ReporteDocumento {
  id: string;
  origen: 'mostrador' | 'telemarketing' | 'credito' | 'abono';
  origen_label: string;
  sucursal: string;
  sucursal_nombre: string | null;
  caja: number | null;
  folio: string;
  fecha: string | null;
  atendio: string | null;
  /** `[TK.d3]` El descuento **de cliente** (cabecera del documento), no la suma de las rebajas
   *  por renglón: ésas sólo salen con «Detalle por producto», en `lineas[].descuento_linea`. */
  descuento: number;
  /** `[TK.d3]` El % que declara el ERP. `null` cuando el documento no lo trae — nunca 0. */
  descuento_pct?: number | null;
  /** NEGATIVO en las notas de crédito. */
  total: number;
  /** ⚠️ `null` = no se pidió el detalle · `[]` = se pidió y el documento no tiene partidas. */
  lineas?: ReporteLinea[] | null;
}

/** [TK.11] Una partida, con las mismas cinco columnas de dinero que el ticket en carta. */
export interface ReporteLinea {
  linea: number;
  sku: string | null;
  descripcion: string | null;
  unidad: string | null;
  cantidad: number;
  precio_lista: number;
  lista_conocida: boolean;
  precio_pagado: number;
  descuento_unitario: number;
  descuento_linea: number;
  importe: number;
}

export interface ReporteCliente {
  cliente: ClienteCandidato;
  documentos: ReporteDocumento[];
  resumen: {
    documentos: number; importe: number; descuento: number; promedio: number;
    abonos: number; plazas_con_compra: number;
  };
  /** Lo que los filtros no dicen por sí solos. `null` = no hay nada que declarar. */
  aviso: string | null;
}

export interface ReporteFiltrosUI {
  date_from?: string;
  date_to?: string;
  /** Folio o parte de él: es "contiene", el folio no identifica un documento. */
  folio?: string;
  min?: string;
  max?: string;
  /** ⚠️ Viaja como `warehouse_codes`: ScopeService lo interseca con el alcance del usuario. */
  warehouse_codes?: string;
  caja?: string;
  atendio?: string;
  brand_id?: string;
  supplier_id?: string;
  solo_con_descuento?: boolean;
  /** [TK.11] Trae las partidas de cada compra. Alarga el papel: se declara en pantalla. */
  detalle?: boolean;
}

@Injectable({ providedIn: 'root' })
export class TicketsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/tickets`;

  buscar(q: string): Observable<TicketBusqueda> {
    return this.http.get<TicketBusqueda>(this.base, { params: { q } });
  }

  detalle(id: string): Observable<TicketVenta> {
    return this.http.get<TicketVenta>(`${this.base}/${encodeURIComponent(id)}`);
  }

  /**
   * El PDF se pide como **blob** y no abriendo la URL en una pestaña: la ruta va con `Bearer`
   * y una pestaña nueva no lleva el token (mismo patrón que la Guía de Cobranza en AX).
   */
  /** TK.8 — clientes del MAESTRO de Kepler. Excluye CONTADO: el mostrador es anónimo. */
  clientes(q: string): Observable<{ candidatos: ClienteCandidato[]; topado: boolean }> {
    return this.http.get<{ candidatos: ClienteCandidato[]; topado: boolean }>(
      `${this.base}/clientes`, { params: { q } });
  }

  /**
   * Los documentos de UN cliente, en todas las plazas que alcanza quien pregunta.
   * Los vacíos no viajan como cadena vacía: un `''` en el query se lee como un filtro puesto.
   */
  reporte(code: string, f: ReporteFiltrosUI): Observable<ReporteCliente> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(f)) {
      if (v !== undefined && v !== null && v !== '' && v !== false) params = params.set(k, String(v));
    }
    return this.http.get<ReporteCliente>(
      `${this.base}/clientes/${encodeURIComponent(code)}/reporte`, { params });
  }

  cartaPdf(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/${encodeURIComponent(id)}/carta.pdf`, { responseType: 'blob' });
  }
}
