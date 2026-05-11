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

@Injectable({ providedIn: 'root' })
export class SeguimientoService {
  private http = inject(HttpClient);

  getDailyScores(params?: {
    startDate?: string;
    endDate?: string;
    zone?: string;
    supervisorId?: string;
    userIds?: string[];
  }): Observable<DailyScoresResponse> {
    return this.http.get<DailyScoresResponse>(`${environment.apiUrl}/reports/daily-scores/per-user`, { params: params as any });
  }

  getZones(): Observable<ZoneOption[]> {
    return this.http.get<ZoneOption[]>(`${environment.apiUrl}/users/zones`);
  }

  getSupervisors(): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiUrl}/users/supervisors`);
  }
}
