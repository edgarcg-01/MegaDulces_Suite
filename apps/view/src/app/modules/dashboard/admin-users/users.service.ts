import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface User {
  id: string;
  username: string;
  nombre?: string;
  zona?: string;
  role_name: string;
  activo: boolean;
  supervisor_id?: string;
  created_at?: string;
}

@Injectable({
  providedIn: 'root',
})
export class UsersService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/users`;

  findAll(zona?: string, activo?: boolean): Observable<User[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    if (activo !== undefined) params = params.set('activo', activo.toString());

    return this.http.get<User[]>(this.apiUrl, { params });
  }

  findOne(id: string): Observable<User> {
    return this.http.get<User>(`${this.apiUrl}/${id}`);
  }

  create(user: any): Observable<User> {
    return this.http.post<User>(this.apiUrl, user);
  }

  update(id: string, user: any): Observable<User> {
    return this.http.put<User>(`${this.apiUrl}/${id}`, user);
  }

  remove(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`);
  }

  getRoles(): Observable<{ role_name: string }[]> {
    return this.http.get<{ role_name: string }[]>(`${this.apiUrl}/roles`);
  }

  getSupervisors(zona?: string): Observable<any[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    return this.http.get<any[]>(`${this.apiUrl}/supervisors`, { params });
  }

  getTeam(supervisorId: string): Observable<any[]> {
    return this.http.get<any[]>(
      `${this.apiUrl}/supervisor/${supervisorId}/team`,
    );
  }
}
