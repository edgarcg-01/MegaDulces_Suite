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
  /** Sucursal Kepler asignada ('00'..'05'). NULL = ve todas (rol global). */
  warehouse_code?: string | null;
  /** Departamento del organigrama (Fase UN). NULL = sin asignar. */
  department_code?: string | null;
  department_name?: string | null;
  /** Puesto canonicalizado del ORGANIGRAMA 2026. NULL = sin asignar. */
  position_code?: string | null;
  position_name?: string | null;
  created_at?: string;
  has_route_today?: boolean;
  route_name_today?: string;
  /** ISO timestamp del último login exitoso. NULL si nunca se logueó. */
  last_login_at?: string | null;
  /** IP del último login (truncada a 45 chars). */
  last_login_ip?: string | null;
  /** Áreas de gasto visibles (GX.8). Vacío/NULL = ninguna salvo FINANCE_EXPENSES_VER_ALL. */
  finance_expense_area_ids?: string[] | null;
}

/** Área de gasto (dimensión canónica finance.expense_areas) para el selector. */
export interface FinanceAreaOption {
  id: string;
  name: string;
  sucursal?: string | null;
}

export interface UserCreatePayload {
  username: string;
  password: string;
  nombre?: string;
  /** `[ID.7]` canónico. El backend sigue aceptando `zona`/`zona_id` deprecados. */
  zone_id?: string | null;
  role_name: string;
  supervisor_id?: string | null;
  warehouse_code?: string | null;
  department_code?: string | null;
  position_code?: string | null;
}

export interface UserUpdatePayload {
  username?: string;
  password?: string;
  nombre?: string;
  /** `[ID.7]` canónico. El backend sigue aceptando `zona`/`zona_id` deprecados. */
  zone_id?: string | null;
  role_name?: string;
  supervisor_id?: string | null;
  activo?: boolean;
  warehouse_code?: string | null;
  department_code?: string | null;
  position_code?: string | null;
  finance_expense_area_ids?: string[] | null;
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

/** Departamento del organigrama (identity.departments). Eje ORGANIZACIONAL. */
export interface DepartmentOption {
  code: string;
  name: string;
  orden?: number;
}

/** Puesto canonicalizado del ORGANIGRAMA 2026 (identity.positions). */
export interface PositionOption {
  code: string;
  name: string;
  /** Etiquetas literales del PDF que se colapsaron en este puesto. */
  org_labels?: string[];
  orden?: number;
  /** `[ID.15]` Departamento del puesto. El alta lo propone. */
  department_code?: string | null;
  /**
   * `[ID.15]` Perfil base que el puesto propone. NULL = todavía no hay un perfil
   * que le quede (20 de los 43 puestos están así) y hay que elegirlo a mano.
   */
  default_role?: string | null;
}

/** `[ID.13]` Un rol del usuario: el perfil base o un complemento. */
export interface UserRoleRow {
  role_name: string;
  is_primary: boolean;
  nota?: string | null;
  /** Permisos otorgados por ese rol — hace legible "cajero (3) + captura_gastos (1)". */
  permisos: number;
  created_at?: string;
}

export interface UserRolesResponse {
  user_id: string;
  username: string;
  perfil_base: string;
  roles: UserRoleRow[];
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

  /** Catálogo canónico de áreas de gasto (GX.8) para asignar "áreas visibles" al usuario. */
  financeAreas(): Observable<FinanceAreaOption[]> {
    return this.http.get<FinanceAreaOption[]>(`${environment.apiUrl}/finance/expenses/comprobaciones/areas`);
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

  getDepartments(): Observable<DepartmentOption[]> {
    return this.http.get<DepartmentOption[]>(`${this.apiUrl}/departments`);
  }

  getPositions(): Observable<PositionOption[]> {
    return this.http.get<PositionOption[]>(`${this.apiUrl}/positions`);
  }

  /** `[ID.13]` Perfil base + complementos de un usuario. */
  getUserRoles(id: string): Observable<UserRolesResponse> {
    return this.http.get<UserRolesResponse>(`${this.apiUrl}/${id}/roles`);
  }

  /**
   * `[ID.13]` Fija los COMPLEMENTOS del usuario. Semántica de PUT: la lista que
   * se manda es la lista final; lo que no venga se quita. El perfil base no se
   * toca acá (es `role_name` del formulario).
   */
  setUserRoles(
    id: string,
    roles: string[],
  ): Observable<{ user_id: string; complementos: string[]; agregados: string[]; quitados: string[] }> {
    return this.http.put<{ user_id: string; complementos: string[]; agregados: string[]; quitados: string[] }>(
      `${this.apiUrl}/${id}/roles`,
      { roles },
    );
  }
}
