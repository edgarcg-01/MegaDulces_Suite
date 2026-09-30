import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[MKT.6]` — Resultado de la activación: ¿la promoción movió la aguja?
 *
 * Servicio **propio** y no un bloque en `promo-agreements.service.ts`: aquél gobierna el
 * expediente (lo que se pactó y la evidencia de que se ejecutó) y éste lee una **vista derivada
 * del ERP** que no escribe nada. Además se están escribiendo en paralelo en el mismo checkout.
 *
 * ⚠️ **Los nulos de acá no son "cero", y la pantalla los tiene que dibujar distinto.** `null` en
 * `monto_ventana` con `medicion='sin_alcance'` significa *no se pudo mirar*; con `'sin_venta'`
 * significa *se miró y no hubo venta*. Son conclusiones opuestas: colapsarlas a "$0" haría que un
 * acuerdo a medio capturar se lea como un fracaso comercial (ADR-056).
 */

/** Los cuatro estados que declara la vista. No es un booleano a propósito. */
export type EstadoMedicion = 'medida' | 'sin_baseline' | 'sin_venta' | 'sin_alcance';
export type EstadoUnidad = 'unica' | 'mixta' | 'sin_dato';

/** El resultado de UN canal (una plaza dentro de un acuerdo). */
export interface ResultadoCanal {
  channel_id: string;
  agreement_id: string;
  folio: string | null;
  empresa: string;
  proveedor: string;
  agreement_status: string;
  warehouse_code: string;
  warehouse_name: string | null;
  desde: string;
  hasta: string;
  dias_ventana: number;
  /** "HASTA AGOTAR": la ventana se corta hoy, así que la cifra es provisional. */
  ventana_abierta: boolean;
  monto_negociado: number | null;
  codigos_total: number;
  /** Cuántos de esos códigos están ligados al catálogo. Sin liga no hay nada que mirar. */
  codigos_ligados: number;
  evidence_required: number;
  evidence_count: number;
  dias_con_venta: number;
  monto_ventana: number | null;
  monto_baseline: number | null;
  uplift_monto: number | null;
  /** NULL cuando la base es 0: no es "+infinito%", es "no había base". */
  uplift_pct: number | null;
  units_ventana: number | null;
  units_baseline: number | null;
  unidad_estado: EstadoUnidad;
  medicion: EstadoMedicion;
}

/** Rollup de un acuerdo. Agrega SÓLO los canales medidos y nombra el resto. */
export interface ResumenAcuerdo {
  agreement_id: string;
  folio: string | null;
  proveedor: string;
  canales_total: number;
  canales_medidos: number;
  no_medidos: { sin_baseline: number; sin_venta: number; sin_alcance: number };
  codigos_total: number;
  codigos_ligados: number;
  monto_ventana: number | null;
  monto_baseline: number | null;
  uplift_monto: number | null;
  uplift_pct: number | null;
  monto_negociado: number | null;
  evidencia_requerida: number;
  evidencia_subida: number;
  ventana_abierta: boolean;
}

/** Diagnóstico de captura. NO liga nada: sólo dice si el arreglo está a un clic. */
export interface CoberturaCodigos {
  codigos_total: number;
  ligados: number;
  sin_ligar_resolubles: number;
  sin_ligar_sin_match: number;
}

/** Lo negociado contra lo que el proveedor de verdad acreditó (notas de crédito del ERP). */
export interface Conciliacion {
  agreement_id: string;
  folio: string | null;
  proveedor: string;
  monto_negociado: number | null;
  /** NULL cuando no se pudo medir. Nunca 0: un cero dice "no acreditó nada". */
  monto_acreditado: number | null;
  documentos: number;
  metodo: 'codigo_proveedor' | 'nombre_exacto' | 'sin_liga';
  estado: 'conciliado' | 'sin_acreditacion' | 'fuente_vacia' | 'sin_liga' | 'sin_monto';
  nota: string;
}

@Injectable({ providedIn: 'root' })
export class PromoSelloutService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/promo-sellout`;

  listar(filtros: { folio?: string; medicion?: string } = {}): Observable<ResultadoCanal[]> {
    const p: string[] = [];
    if (filtros.folio) p.push(`folio=${encodeURIComponent(filtros.folio)}`);
    if (filtros.medicion) p.push(`medicion=${encodeURIComponent(filtros.medicion)}`);
    return this.http.get<ResultadoCanal[]>(`${this.base}${p.length ? '?' + p.join('&') : ''}`);
  }

  porAcuerdo(id: string): Observable<{ resumen: ResumenAcuerdo; canales: ResultadoCanal[] }> {
    return this.http.get<{ resumen: ResumenAcuerdo; canales: ResultadoCanal[] }>(
      `${this.base}/acuerdo/${id}`,
    );
  }

  cobertura(id: string): Observable<CoberturaCodigos> {
    return this.http.get<CoberturaCodigos>(`${this.base}/acuerdo/${id}/cobertura`);
  }

  conciliacion(id: string): Observable<Conciliacion> {
    return this.http.get<Conciliacion>(`${this.base}/acuerdo/${id}/conciliacion`);
  }

  porSucursal(code: string): Observable<ResultadoCanal[]> {
    return this.http.get<ResultadoCanal[]>(`${this.base}/sucursal/${encodeURIComponent(code)}`);
  }
}
