import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface ReportsData {
  metrics: {
    totalVisitas: number;
    avgScore: number;
    totalVentas: number;
    count: number;
    // Propiedades opcionales usadas por KPI cards
    totalExhibiciones?: number;
    gpsPct?: number;
    // Permitir propiedades dinámicas prev_* para comparativos
    [key: string]: number | string | undefined;
  };
  trendData: Array<{
    date: string;
    visits: number;
    avgScore: number;
  }>;
  rows: any[];
  // Propiedades opcionales para gráficos adicionales
  zoneStats?: Array<{
    zone: string;
    avgScore: number;
    totalVisitas?: number;
  }>;
  sellerStats?: Array<{
    username: string;
    totalVisitas: number;
    avgScore?: number;
  }>;
  furniture?: Record<string, number>;
}

@Injectable({
  providedIn: 'root'
})
export class ReportsService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/reports`;

  getReportsData(filters: any): Observable<ReportsData> {
    let params = new HttpParams();
    if (filters.startDate) params = params.set('startDate', filters.startDate);
    if (filters.endDate) params = params.set('endDate', filters.endDate);
    if (filters.userId) params = params.set('userId', filters.userId);
    if (filters.supervisorId) params = params.set('supervisorId', filters.supervisorId);

    // Prioridad: sellerIds > userIds > legacy userIds
    const idsToSend = filters.sellerIds?.length > 0
      ? filters.sellerIds
      : (filters.userIds?.length > 0 ? filters.userIds : []);

    if (idsToSend.length > 0) {
      idsToSend.forEach((id: string) => {
        params = params.append('userIds[]', id);
      });
    }

    if (filters.zone) params = params.set('zone', filters.zone);

    return this.http.get<ReportsData>(`${this.apiUrl}/data`, { params });
  }

  exportCsv(filters: any): Observable<Blob> {
    let params = new HttpParams();
    if (filters.startDate) params = params.set('startDate', filters.startDate);
    if (filters.endDate) params = params.set('endDate', filters.endDate);
    if (filters.userId) params = params.set('userId', filters.userId);
    if (filters.userIds && filters.userIds.length > 0) {
      filters.userIds.forEach((id: string) => {
        params = params.append('userIds[]', id);
      });
    }
    if (filters.zone) params = params.set('zone', filters.zone);

    return this.http.get(`${this.apiUrl}/export`, { 
      params, 
      responseType: 'blob' 
    });
  }

  getUsers(): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiUrl}/users`);
  }

  getZones(): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiUrl}/users/zones`);
  }

  getSupervisors(zona?: string): Observable<any[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    return this.http.get<any[]>(`${environment.apiUrl}/users/supervisors`, { params });
  }

  getSellers(zona?: string, supervisorId?: string): Observable<any[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    if (supervisorId) params = params.set('supervisor_id', supervisorId);
    return this.http.get<any[]>(`${environment.apiUrl}/users/sellers`, { params });
  }

  getSummary(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/summary`);
  }
}
