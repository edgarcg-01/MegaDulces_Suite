import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AdminCatalogsService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/catalogs`;

  getCatalog(type: string, parentId?: string): Observable<any[]> {
    let url = `${this.apiUrl}/${type}`;
    if (parentId) {
      url += `?parent=${parentId}`;
    }
    return this.http.get<any[]>(url);
  }

  getRoutesByZone(zoneId: string): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/rutas?parent=${zoneId}`);
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
