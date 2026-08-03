import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface UserScore {
  fecha: string;
  /** Promedio del score del día (compat histórico — `AVG` por día). */
  puntuacion: number;
  /** Suma REAL de puntos del día (`SUM` por día, no avg). Habilita modo Volumen. */
  total?: number;
  /** Conteo de visitas del día. Habilita modos Adherencia y Eficiencia. */
  visitas?: number;
}

export interface UserScores {
  nombre: string;
  scores: UserScore[];
  metaDiaria: number;
}

export interface DailyScoresResponse {
  users: UserScores[];
}

export interface ZoneOption {
  id: string;
  name: string;
}

export interface SeguimientoFilters {
  startDate?: string;
  endDate?: string;
  zone?: string;
  supervisorId?: string;
  userIds?: string[];
  sellerIds?: string[];
}

/** Estado de revisión de Horus derivado por visita. */
export type HorusStatus =
  | 'no_revisada'
  | 'valida'
  | 'requiere_supervision'
  | 'fraude'
  | 'confirmada'
  | 'descartada';

export interface VendorVisit {
  id: string;
  folio: string;
  user_id: string;
  vendedor: string;
  zona: string | null;
  fecha: string | null;
  hora_inicio: string;
  store_name: string | null;
  skip_scoring: boolean;
  score: number | null;
  score_pct: number | null;
  horus_status: HorusStatus;
  photos_analyzed: number;
  photos_total: number;
  flags: number;
  mismatch: number;
  out_of_stock: number;
  not_shelf: number;
  open_findings: number;
  fraud_findings: number;
  max_severity: number;
}

export interface VendorAgg {
  user_id: string;
  nombre: string;
  total_visitas: number;
  sin_visitas: boolean;
  avg_score: number | null;
  pct_validas: number;
  por_supervisar: number;
  fraud_flag: boolean;
  counts: Record<HorusStatus, number>;
}

export interface VendorReviewResponse {
  horus_available: boolean;
  total: number;
  by_vendor: VendorAgg[];
  visits: VendorVisit[];
}

export interface VendorReviewFilters {
  startDate?: string;
  endDate?: string;
  zone?: string;
  supervisorId?: string;
  userId?: string;
  horusStatus?: string;
  /** Solo PDF: vendedor cuyo detalle de visitas se incluye. */
  focusUserId?: string;
}

@Injectable({ providedIn: 'root' })
export class SeguimientoService {
  private http = inject(HttpClient);

  getDailyScores(params?: SeguimientoFilters): Observable<DailyScoresResponse> {
    return this.http.get<DailyScoresResponse>(
      `${environment.apiUrl}/reports/daily-scores/per-user`,
      { params: params as Record<string, string | string[]> },
    );
  }

  getZones(): Observable<ZoneOption[]> {
    return this.http.get<ZoneOption[]>(`${environment.apiUrl}/users/zones`);
  }

  getSupervisors(): Observable<unknown[]> {
    return this.http.get<unknown[]>(`${environment.apiUrl}/users/supervisors`);
  }

  /**
   * Elimina una visita por ID o folio. El backend valida ownership +
   * permiso `REPORTES_GESTIONAR` y registra audit log.
   */
  deleteVisit(idOrFolio: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(
      `${environment.apiUrl}/daily-captures/${idOrFolio}`,
    );
  }

  /**
   * Reporte por vendedor con revisión Horus: visitas + calificación + estado
   * de revisión derivado (valida / requiere_supervision / fraude / no_revisada).
   */
  getVendorVisitsReview(
    params?: VendorReviewFilters,
  ): Observable<VendorReviewResponse> {
    return this.http.get<VendorReviewResponse>(
      `${environment.apiUrl}/reports/vendor-visits-review`,
      { params: params as Record<string, string> },
    );
  }

  /**
   * Dispara el análisis de visión de Horus (acotado por corrida) sobre las
   * fotos aún no revisadas del tenant. Requiere `SUPERVISOR_AI_VER`.
   */
  scanHorusVision(max = 24): Observable<unknown> {
    return this.http.post(
      `${environment.apiUrl}/supervisor-ai/vision/scan`,
      { max },
    );
  }

  /** Descarga el PDF del reporte por vendedor (resumen + detalle del focus). */
  downloadVendorReviewPdf(params?: VendorReviewFilters): Observable<Blob> {
    return this.http.get(
      `${environment.apiUrl}/reports/vendor-visits-review/pdf`,
      { params: params as Record<string, string>, responseType: 'blob' },
    );
  }
}
