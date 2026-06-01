import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface User {
  id: string;
  username: string;
  nombre?: string;
  zona?: string;
  zona_id?: string;
  role_name: string;
  activo: boolean;
  supervisor_id?: string;
  created_at?: string;
  has_route_today?: boolean;
  route_name_today?: string;
  /** ISO timestamp del último login exitoso. NULL si nunca se logueó. */
  last_login_at?: string | null;
  /** IP del último login (truncada a 45 chars). */
  last_login_ip?: string | null;
}

export interface UserCreatePayload {
  username: string;
  password: string;
  nombre?: string;
  zona?: string;
  zona_id?: string | null;
  role_name: string;
  supervisor_id?: string | null;
}

export interface UserUpdatePayload {
  username?: string;
  password?: string;
  nombre?: string;
  zona?: string;
  zona_id?: string | null;
  role_name?: string;
  supervisor_id?: string | null;
  activo?: boolean;
}

export interface SupervisorOption {
  id: string;
  nombre?: string;
  username: string;
  zona?: string;
}

export interface ZoneOption {
  id: string;
  value: string;
  orden?: number;
}

@Injectable({ providedIn: 'root' })
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

  create(user: UserCreatePayload): Observable<User> {
    return this.http.post<User>(this.apiUrl, user);
  }

  update(id: string, user: UserUpdatePayload): Observable<User> {
    return this.http.put<User>(`${this.apiUrl}/${id}`, user);
  }

  remove(id: string): Observable<{ message: string; orphans_cleared: number }> {
    return this.http.delete<{ message: string; orphans_cleared: number }>(
      `${this.apiUrl}/${id}`,
    );
  }

  getRoles(): Observable<{ role_name: string }[]> {
    return this.http.get<{ role_name: string }[]>(`${this.apiUrl}/roles`);
  }

  getSupervisors(zona?: string): Observable<SupervisorOption[]> {
    let params = new HttpParams();
    if (zona) params = params.set('zona', zona);
    return this.http.get<SupervisorOption[]>(`${this.apiUrl}/supervisors`, {
      params,
    });
  }

  getTeam(supervisorId: string): Observable<User[]> {
    return this.http.get<User[]>(
      `${this.apiUrl}/supervisor/${supervisorId}/team`,
    );
  }

  getZones(): Observable<ZoneOption[]> {
    return this.http.get<ZoneOption[]>(`${this.apiUrl}/zones`);
  }
}
