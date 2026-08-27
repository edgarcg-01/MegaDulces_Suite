import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Arqueo ciego de caja (proyecto Tienda). Pega a `/store/arqueo` — la variante
 * acotada para cajeras del arqueo del Supervisor de Movimientos.
 *
 * El backend recorta en los dos ejes y ESTE service no puede aflojarlos:
 *  - **filas**: solo las sucursales asignadas al usuario (`ScopeService`, ADR-050);
 *  - **campos**: a la cajera no le llegan `esperado` ni `diff_real` (ni los
 *    `kepler_*`). Por eso ambos son opcionales acá: `undefined` = "no te toca
 *    verlo", y la UI esconde la columna en vez de pintar un cero mentiroso.
 *    Solo `RECONCILIATION_VER` (supervisor) los recibe.
 */
export type ArqueoTipo = 'cierre' | 'relevo';

export interface ArqueoDto {
  warehouse_code?: string; // ignorado si el usuario está scopeado a una sucursal
  caja: string;
  business_date: string; // 'YYYY-MM-DD'
  tipo?: ArqueoTipo;
  cajero_code?: string;
  cajero_entrante?: string;
  denominations: Record<string, number>;
  nota?: string;
  incidencia_tipo?: string; // SM.9: motivo cualitativo del descuadre (opcional)
}

export interface ArqueoResult {
  tipo: ArqueoTipo;
  total_contado: number;
  /** ¿El backend reveló la comparación? false para la cajera. */
  reveal: boolean;
  matched?: boolean;
  ambiguous?: boolean; // varios cortes en la caja/día y no se especificó cajero → no se comparó
  folio?: string;
  esperado?: number | null;
  diff_real?: number | null; // + faltante / − sobrante
}

export interface ArqueoRow {
  id: string; tipo: ArqueoTipo; warehouse_code: string; caja: string; business_date: string; turno: string | null;
  cajero_code: string | null; cajero_entrante: string | null; cajero_nombre: string | null; total_contado: number;
  captured_by: string | null; captured_at: string; nota: string | null; incidencia_tipo: string | null;
  esperado?: number | null; diff_real?: number | null;
}

@Injectable({ providedIn: 'root' })
export class ArqueoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/arqueo`;

  submit(dto: ArqueoDto): Observable<ArqueoResult> {
    return this.http.post<ArqueoResult>(this.base, dto);
  }

  list(q?: { from?: string; to?: string; limit?: number; warehouse_codes?: string[] }): Observable<ArqueoRow[]> {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.limit) p.set('limit', String(q.limit));
    // Filtro opcional DENTRO del alcance: el backend lo intersecta, pedir de más no suma.
    if (q?.warehouse_codes?.length) p.set('warehouse_codes', q.warehouse_codes.join(','));
    const qs = p.toString();
    return this.http.get<ArqueoRow[]>(`${this.base}${qs ? '?' + qs : ''}`);
  }
}
