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

/**
 * Un turno de caja que Kepler abrió a nombre del usuario. Es lo que habilita la
 * captura: sin turno no hay arqueo. **No trae montos** — dice qué contar, no
 * cuánto debería haber.
 */
export interface Turno {
  warehouse_code: string;
  warehouse_name: string | null;
  caja: string;
  folio: string;
  business_date: string;
  hora_apertura: string | null;
  hora_cierre: string | null;
  cajero_code: string | null;
  turno: string | null;
  abierto: boolean;
  /** Minutos desde que Kepler cerró el turno. `null` = sigue abierto. */
  cerrado_hace_min?: number | null;
}

export interface ArqueoDto {
  warehouse_code?: string; // ignorado si el usuario está scopeado a una sucursal
  /** Folio del turno de Kepler. Obligatorio para la cajera: la caja y la fecha salen de ahí. */
  cash_cut_folio?: string;
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
  cash_cut_folio?: string | null; caja_kepler?: string | null; turno_abierto_at?: string | null;
  /** `validado_at` nulo = pendiente de que la encargada lo firme presencialmente. */
  validado_por?: string | null; validado_at?: string | null; validado_nota?: string | null;
  /**
   * Los tres números de la validación, solo para quien valida:
   *   `esperado`        — lo que Kepler dice que debería haber
   *   `kepler_contado`  — lo que Kepler declara que se contó (casi siempre == esperado)
   *   `total_contado`   — nuestro conteo ciego: **el que vale**
   * `kepler_enmascaro` = Kepler dio el corte por cuadrado y el conteo real dice otra cosa.
   */
  esperado?: number | null; kepler_contado?: number | null; kepler_diff?: number | null;
  kepler_enmascaro?: boolean; diff_real?: number | null;
}

/**
 * Acumulado por cajera. Los campos de diferencia solo llegan a quien valida —
 * el agregado también revela: un `faltante_total` sobre un único arqueo ES la
 * diferencia de ese arqueo.
 */
export interface ArqueoPorCajera {
  cajero_code: string | null; cajero_nombre: string | null; warehouse_code: string;
  arqueos: number; total_contado: number; sin_validar: number; ultima_fecha: string | null;
  con_diferencia?: number; faltante_total?: number; sobrante_total?: number;
}

export interface ArqueoHistorial {
  arqueos: ArqueoRow[];
  por_cajera: ArqueoPorCajera[];
  totales: { arqueos: number; sin_validar: number; faltante_total?: number; sobrante_total?: number };
}

@Injectable({ providedIn: 'root' })
export class ArqueoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/arqueo`;

  /** Turnos que Kepler abrió a nombre del usuario y todavía no arqueó. */
  turnos(dias?: number): Observable<Turno[]> {
    return this.http.get<Turno[]>(`${this.base}/turnos${dias ? '?dias=' + dias : ''}`);
  }

  submit(dto: ArqueoDto): Observable<ArqueoResult> {
    return this.http.post<ArqueoResult>(this.base, dto);
  }

  /** Historial con el acumulado por cajera. */
  historial(q?: { from?: string; to?: string; cajero?: string; sin_validar?: boolean; limit?: number }): Observable<ArqueoHistorial> {
    const p = new URLSearchParams();
    if (q?.from) p.set('from', q.from);
    if (q?.to) p.set('to', q.to);
    if (q?.cajero) p.set('cajero', q.cajero);
    if (q?.sin_validar) p.set('sin_validar', 'true');
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<ArqueoHistorial>(`${this.base}/historial${qs ? '?' + qs : ''}`);
  }

  /** La encargada firma el arqueo tras contarlo en el lugar. */
  validar(id: string, nota?: string): Observable<unknown> {
    return this.http.post(`${this.base}/${id}/validar`, { nota });
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
