import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AdminCatalogsService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/catalogs`;

  getCatalog(
    type: string,
    parentId?: string,
    includeInactive = false,
  ): Observable<any[]> {
    let params = new HttpParams();
    if (parentId) params = params.set('parent', parentId);
    if (includeInactive) params = params.set('includeInactive', 'true');
    return this.http.get<any[]>(`${this.apiUrl}/${type}`, { params });
  }

  getRoutesByZone(zoneId: string): Observable<any[]> {
    let params = new HttpParams();
    if (zoneId) {
      params = params.set('parent', zoneId);
    }
    return this.http.get<any[]>(`${this.apiUrl}/rutas`, { params });
  }

  addItem(type: string, data: { value: string; orden?: number; puntuacion?: number; icono?: string; parent_id?: string }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/${type}`, data);
  }

  deleteItem(type: string, id: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/${type}/${id}`);
  }

  updateItem(type: string, id: string, data: any): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/${type}/${id}`, data);
  }

  getRolePermissions(roleName: string): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/permissions/${roleName}`);
  }

  updateRolePermissions(roleName: string, permissions: any): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/permissions/${roleName}`, permissions);
  }
}
