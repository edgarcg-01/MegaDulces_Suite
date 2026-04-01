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
  };
  trendData: Array<{
    date: string;
    visits: number;
    avgScore: number;
  }>;
  rows: any[];
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
    if (filters.userIds && filters.userIds.length > 0) {
      filters.userIds.forEach((id: string) => {
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

  getSummary(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/summary`);
  }
}
