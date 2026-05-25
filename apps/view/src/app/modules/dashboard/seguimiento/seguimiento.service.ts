import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface UserScore {
  fecha: string;
  puntuacion: number;
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
}
