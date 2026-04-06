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

  getCatalog(type: string): Observable<any[]> {
    return this.http.get<any[]>(`${this.apiUrl}/${type}`);
  }

  addItem(type: string, data: { value: string; orden?: number; puntuacion?: number; icono?: string }): Observable<any> {
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
