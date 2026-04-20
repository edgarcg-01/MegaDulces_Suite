import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/**
 * Interfaz para los datos de reportes
 */
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
  productStats?: Record<string, { total: number; exhibidores: Record<string, number> }>;
  productMap?: Record<string, { name: string; brandName: string }>;
  exhibidoresHealth?: { optimo: number; regular: number; critico: number };
}

@Injectable({
  providedIn: 'root'
})
/**
 * Servicio para obtener datos de reportes y estadísticas
 */
export class ReportsService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/reports`;

  /**
   * Obtiene los datos de reportes aplicando filtros
   * @param filters Filtros para la consulta (startDate, endDate, userId, supervisorId, sellerIds, userIds, zone)
   * @returns Observable con los datos de reportes
   */
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

  /**
   * Exporta los datos de reportes a formato CSV
   * @param filters Filtros para la consulta
   * @returns Observable con el archivo CSV como Blob
   */
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

  /**
   * Obtiene la lista de usuarios
   * @returns Observable con la lista de usuarios
   */
  getUsers(): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiUrl}/users`);
  }

  /**
   * Obtiene la lista de zonas
   * @returns Observable con la lista de zonas
   */
  getZones(): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiUrl}/users/zones`);
  }

  /**
   * Obtiene la lista de supervisores
   * @param zona Zona opcional para filtrar
   * @returns Observable con la lista de supervisores
   */
  getSupervisors(zona?: string): Observable<any[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    return this.http.get<any[]>(`${environment.apiUrl}/users/supervisors`, { params });
  }

  /**
   * Obtiene la lista de vendedores
   * @param zona Zona opcional para filtrar
   * @param supervisorId ID del supervisor opcional para filtrar
   * @returns Observable con la lista de vendedores
   */
  getSellers(zona?: string, supervisorId?: string): Observable<any[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    if (supervisorId) params = params.set('supervisor_id', supervisorId);
    return this.http.get<any[]>(`${environment.apiUrl}/users/sellers`, { params });
  }

  /**
   * Obtiene un resumen de estadísticas
   * @returns Observable con el resumen de estadísticas
   */
  getSummary(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/summary`);
  }

  /**
   * Elimina un reporte por su ID
   * @param id ID del reporte a eliminar
   * @returns Observable con el resultado de la eliminación
   */
  deleteReport(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`);
  }
}
