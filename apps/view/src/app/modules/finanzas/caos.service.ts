import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** CS.2 — Cliente del reporte de CAOS (`/finance/caos`). */

export interface CaosMovimiento {
  id: string;
  device: string;
  external_id: number;
  type_id: number;
  type_label: string;
  occurred_at: string;
  accounting_date: string | null;
  user_external: string | null;
  total: number;
  currency: string;
  ref: string | null;
  shift_id: string | null;
}

export interface CaosKpi {
  movimientos: number;
  depositos: number;
  dispensado: number;
  balance: number;
  datos_al: string | null;
}

export interface CaosMovimientosResponse {
  rows: CaosMovimiento[];
  kpi: CaosKpi;
  desde: string;
  limit: number;
  has_more: boolean;
}

export interface CaosDenominacion { denom: number; pieza_tipo: string; quantity: number }

export interface CaosDetalle extends CaosMovimiento {
  cheques: unknown[];
  tickets: unknown[];
  denominaciones: CaosDenominacion[];
}

@Injectable({ providedIn: 'root' })
export class CaosService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/finance/caos`;

  movimientos(f: { from?: string; to?: string; tipo?: string; usuario?: string; ref?: string; limit?: number }): Observable<CaosMovimientosResponse> {
    let p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosMovimientosResponse>(`${this.base}/movimientos`, { params: p });
  }

  detalle(id: string): Observable<CaosDetalle> {
    return this.http.get<CaosDetalle>(`${this.base}/movimientos/${id}`);
  }

  resumen(f: { from?: string; to?: string }): Observable<CaosResumen> {
    let p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosResumen>(`${this.base}/resumen`, { params: p });
  }

  conciliacion(f: { from?: string; to?: string }): Observable<CaosConciliacion> {
    let p: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p[k] = String(v);
    return this.http.get<CaosConciliacion>(`${this.base}/conciliacion`, { params: p });
  }
}

export interface CaosCuadreDia { dia: string; caos_dep: number; kepler_ing: number; caos_dis: number; kepler_egr: number }
export interface CaosConciliacion {
  dias: CaosCuadreDia[];
  totales: { caos_dep: number; kepler_ing: number; caos_dis: number; kepler_egr: number };
  cobertura: { depositos: number | null; dispensado: number | null };
  desde: string; hasta: string;
}

export interface CaosPorRuta { ruta: string | null; movimientos: number; total: number }
export interface CaosPorOperador {
  user_external: string | null;
  depositos_n: number; depositos_total: number;
  dispensado_n: number; dispensado_total: number;
}
export interface CaosResumen { porRuta: CaosPorRuta[]; porOperador: CaosPorOperador[]; desde: string }
