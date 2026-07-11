import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Arqueo ciego de caja (proyecto Tienda). Pega a `/store/arqueo` — la variante
 * acotada para cajeras del arqueo del Supervisor de Movimientos. El backend scopea
 * a la sucursal del usuario y NO devuelve la inteligencia de enmascaramiento de
 * Kepler (`kepler_*`): la cajera ve SU diferencia, no el flag de "Kepler enmascaró".
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
}

export interface ArqueoResult {
  tipo: ArqueoTipo;
  total_contado: number;
  matched: boolean;
  folio?: string;
  esperado: number | null;
  diff_real: number | null; // + faltante / − sobrante
}

export interface ArqueoRow {
  id: string; tipo: ArqueoTipo; warehouse_code: string; caja: string; business_date: string; turno: string | null;
  cajero_code: string | null; cajero_entrante: string | null; cajero_nombre: string | null; total_contado: number;
  captured_by: string | null; captured_at: string; nota: string | null;
  esperado: number | null; diff_real: number | null;
}

@Injectable({ providedIn: 'root' })
export class ArqueoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/arqueo`;

  submit(dto: ArqueoDto): Observable<ArqueoResult> {
    return this.http.post<ArqueoResult>(this.base, dto);
  }

  list(q?: { from?: string; to?: string; limit?: number }): Observable<ArqueoRow[]> {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<ArqueoRow[]>(`${this.base}${qs ? '?' + qs : ''}`);
  }
}
