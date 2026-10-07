import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
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
  /** Productos movidos por cada usuario { userId: { productId: count } } */
  sellerProductStats?: Record<string, Record<string, number>>;
}

@Injectable({
  providedIn: 'root'
})
/**
 * Servicio para obtener datos de reportes y estadísticas
 */
export class ReportsService {
  private http = inject(HttpClient);
  public readonly baseUrl = environment.apiUrl;
  private apiUrl = `${environment.apiUrl}/reports`;

  /**
   * Obtiene los datos de reportes aplicando filtros
   * @param filters Filtros para la consulta (startDate, endDate, userId, supervisorId, sellerIds, userIds, zone)
   * @returns Observable con los datos de reportes
   */
  getReportsData(filters: any, page?: number, pageSize?: number, include?: string): Observable<ReportsData> {
    let params = new HttpParams();
    if (filters.startDate) params = params.set('startDate', filters.startDate);
    if (filters.endDate) params = params.set('endDate', filters.endDate);
    if (filters.userId) params = params.set('userId', filters.userId);
    if (filters.supervisorId) params = params.set('supervisorId', filters.supervisorId);
    if (page != null) params = params.set('page', page.toString());
    if (pageSize != null) params = params.set('pageSize', pageSize.toString());
    if (include) params = params.set('include', include);

    // Prioridad: sellerIds > userIds > legacy userIds
    const idsToSend = filters.sellerIds?.length > 0
      ? filters.sellerIds
      : (filters.userIds?.length > 0 ? filters.userIds : []);

    if (idsToSend.length > 0) {
      idsToSend.forEach((id: string) => {
        params = params.append('userIds', id);
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
        params = params.append('userIds', id);
      });
    }
    if (filters.zone) params = params.set('zone', filters.zone);

    return this.http.get(`${this.apiUrl}/export`, {
      params,
      responseType: 'blob'
    });
  }

  // Cache de catalogos (usuarios/zonas/supervisores/vendedores). Estos
  // datos cambian pocas veces al dia; cachearlos elimina decenas de HTTP
  // redundantes cuando el usuario navega entre /reports, /seguimiento, etc.
  // Para invalidar tras editar usuarios desde admin, llamar `invalidateCaches()`.
  private _usersCache$?: Observable<any[]>;
  private _zonesCache$?: Observable<any[]>;
  private _supervisorsCache = new Map<string, Observable<any[]>>();
  private _sellersCache = new Map<string, Observable<any[]>>();

  /**
   * Obtiene la lista de usuarios. Cacheado tras la primera llamada.
   * @returns Observable con la lista de usuarios
   */
  getUsers(): Observable<any[]> {
    if (!this._usersCache$) {
      this._usersCache$ = this.http
        .get<any[]>(`${environment.apiUrl}/users`)
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    }
    return this._usersCache$;
  }

  /**
   * Obtiene la lista de zonas. Cacheado tras la primera llamada.
   * @returns Observable con la lista de zonas
   */
  getZones(): Observable<any[]> {
    if (!this._zonesCache$) {
      this._zonesCache$ = this.http
        .get<any[]>(`${environment.apiUrl}/users/zones`)
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    }
    return this._zonesCache$;
  }

  /**
   * Obtiene la lista de supervisores. Cacheado por valor de `zona`.
   * @param zona Zona opcional para filtrar
   * @returns Observable con la lista de supervisores
   */
  getSupervisors(zona?: string): Observable<any[]> {
    const key = zona ?? '_all_';
    const cached = this._supervisorsCache.get(key);
    if (cached) return cached;

    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    const obs$ = this.http
      .get<any[]>(`${environment.apiUrl}/users/supervisors`, { params })
      .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this._supervisorsCache.set(key, obs$);
    return obs$;
  }

  /**
   * Obtiene la lista de vendedores. Cacheado por combinacion (zona, supervisorId).
   * @param zona Zona opcional para filtrar
   * @param supervisorId ID del supervisor opcional para filtrar
   * @returns Observable con la lista de vendedores
   */
  getSellers(zona?: string, supervisorId?: string): Observable<any[]> {
    const key = `${zona ?? '_'}|${supervisorId ?? '_'}`;
    const cached = this._sellersCache.get(key);
    if (cached) return cached;

    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    if (supervisorId) params = params.set('supervisor_id', supervisorId);
    const obs$ = this.http
      .get<any[]>(`${environment.apiUrl}/users/sellers`, { params })
      .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    this._sellersCache.set(key, obs$);
    return obs$;
  }

  /**
   * Invalida los caches de catalogos. Llamar tras editar usuarios/zonas
   * desde admin para que la proxima navegacion vuelva a pegarle al backend.
   */
  invalidateCaches() {
    this._usersCache$ = undefined;
    this._zonesCache$ = undefined;
    this._supervisorsCache.clear();
    this._sellersCache.clear();
  }

  /**
   * Obtiene un resumen de estadísticas
   * @param filters Filtros opcionales para la consulta
   * @returns Observable con el resumen de estadísticas
   */
  getSummary(filters?: any): Observable<any> {
    let params = new HttpParams();
    if (filters) {
      if (filters.startDate) params = params.set('startDate', filters.startDate);
      if (filters.endDate) params = params.set('endDate', filters.endDate);
      if (filters.zone) params = params.set('zone', filters.zone);
      if (filters.supervisorId) params = params.set('supervisorId', filters.supervisorId);
      
      // Enviar sellerIds si existen
      if (filters.sellerIds && filters.sellerIds.length > 0) {
        filters.sellerIds.forEach((id: string) => {
          params = params.append('userIds', id);
        });
      }
    }
    return this.http.get<any>(`${this.apiUrl}/summary`, { params });
  }

  /**
   * Obtiene métricas de cumplimiento diario filtradas por fecha
   * @param filters Filtros para la consulta
   * @returns Observable con métricas diarias
   */
  getDailyCompliance(filters?: any): Observable<any> {
    let params = new HttpParams();
    if (filters) {
      if (filters.startDate) params = params.set('startDate', filters.startDate);
      if (filters.endDate) params = params.set('endDate', filters.endDate);
      if (filters.zone) params = params.set('zone', filters.zone);
      if (filters.supervisorId) params = params.set('supervisorId', filters.supervisorId);

      if (filters.sellerIds && filters.sellerIds.length > 0) {
        filters.sellerIds.forEach((id: string) => {
          params = params.append('userIds', id);
        });
      }
    }
    return this.http.get<any>(`${this.apiUrl}/daily-compliance`, { params });
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
