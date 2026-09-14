import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  Coherencia,
  HistoriaDePuesto,
  PadronPagina,
  PersonaFila,
  PropuestaDePuesto,
  PuestoDetalle,
  PuestoFila,
  PuestoQueResponde,
  ResponsabilidadDePuesto,
  ResponsabilidadFila,
  ResponsabilidadesDePersona,
} from '@megadulces/contracts';

/**
 * `[AU.2]` — El cliente de `/admin/*`.
 *
 * Los tipos vienen de `@megadulces/contracts`: un cambio de forma en el backend
 * es un error de compilación de este lado y no un `undefined` en pantalla.
 */

/** Lo que se puede pedir al listar el padrón. Todo opcional. */
export interface PadronQuery {
  search?: string;
  page?: number;
  pageSize?: number;
  department_code?: string;
  position_code?: string;
  kind?: string;
  activo?: boolean;
  zona?: string;
}

export interface OpcionCatalogo {
  code: string;
  name: string;
  orden?: number;
  scope_axis?: string | null;
  department_code?: string | null;
  default_role?: string | null;
}

/** Las tres capas de `GET /users/:id/permissions`. */
export interface PermisosDePersona {
  del_puesto: string[];
  overrides: Array<{ permission_key: string; allow: boolean; nota: string | null }>;
  efectivos: string[];
  de_mas: string[];
  de_menos: string[];
  platform_admin: boolean;
}

export interface EventoDePersona {
  id: string;
  event: string;
  detalle: Record<string, unknown> | null;
  actor_username: string | null;
  created_at: string;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private http = inject(HttpClient);
  private users = `${environment.apiUrl}/users`;
  private org = `${environment.apiUrl}/org`;

  // ── El padrón ────────────────────────────────────────────────────────────

  /**
   * ⚠️ La búsqueda y el filtrado van al SERVIDOR. La del navegador no tolera
   * acentos ni typos: `applySmartSearch` resuelve las dos cosas y además busca
   * por nombre de puesto, de departamento y **de sucursal** — medido, buscar
   * «padre hidalgo» antes devolvía 3 kioscos y ahora devuelve las 13 personas.
   */
  padron(q: PadronQuery = {}): Observable<PadronPagina<PersonaFila>> {
    let p = new HttpParams();
    if (q.search) p = p.set('search', q.search);
    if (q.page) p = p.set('page', String(q.page));
    if (q.pageSize) p = p.set('page_size', String(q.pageSize));
    if (q.department_code) p = p.set('department_code', q.department_code);
    if (q.position_code) p = p.set('position_code', q.position_code);
    if (q.kind) p = p.set('kind', q.kind);
    if (q.zona) p = p.set('zona', q.zona);
    if (q.activo !== undefined) p = p.set('activo', String(q.activo));
    return this.http.get<PadronPagina<PersonaFila>>(this.users, { params: p });
  }

  persona(id: string): Observable<PersonaFila> {
    return this.http.get<PersonaFila>(`${this.users}/${id}`);
  }

  crearPersona(body: Record<string, unknown>): Observable<PersonaFila> {
    return this.http.post<PersonaFila>(this.users, body);
  }

  editarPersona(id: string, body: Record<string, unknown>): Observable<PersonaFila> {
    return this.http.put<PersonaFila>(`${this.users}/${id}`, body);
  }

  bajaPersona(id: string): Observable<unknown> {
    return this.http.delete(`${this.users}/${id}`);
  }

  // ── Catálogos que el alta necesita ───────────────────────────────────────

  departamentos(): Observable<OpcionCatalogo[]> {
    return this.http.get<OpcionCatalogo[]>(`${this.users}/departments`);
  }

  puestosSimples(): Observable<OpcionCatalogo[]> {
    return this.http.get<OpcionCatalogo[]>(`${this.users}/positions`);
  }

  sucursales(): Observable<Array<{ code: string; name: string; zone_id: string | null; zone_name: string | null }>> {
    return this.http.get<Array<{ code: string; name: string; zone_id: string | null; zone_name: string | null }>>(
      `${this.users}/branches`,
    );
  }

  rutas(): Observable<Array<{ id: string; name: string; tiendas: number; zone_id: string | null; zone_name: string | null }>> {
    return this.http.get<Array<{ id: string; name: string; tiendas: number; zone_id: string | null; zone_name: string | null }>>(
      `${this.users}/routes`,
    );
  }

  zonas(): Observable<Array<{ id: string; value: string; orden: number }>> {
    return this.http.get<Array<{ id: string; value: string; orden: number }>>(`${this.users}/zones`);
  }

  supervisores(): Observable<Array<{ id: string; nombre: string | null; username: string; zona: string | null }>> {
    return this.http.get<Array<{ id: string; nombre: string | null; username: string; zona: string | null }>>(
      `${this.users}/supervisors`,
    );
  }

  /** El catálogo de perfiles. `GET /users/roles` no exige permiso: lo consumen varios selects. */
  roles(): Observable<Array<{ role_name: string }>> {
    return this.http.get<Array<{ role_name: string }>>(`${this.users}/roles`);
  }

  /**
   * ⭐ **Lo que el puesto propone.** Rol, complementos, jefe (con quién lo ocupa)
   * y de qué responde. La pantalla vieja no lo llamaba nunca.
   */
  propuesta(positionCode: string): Observable<PropuestaDePuesto> {
    return this.http.get<PropuestaDePuesto>(
      `${this.users}/positions/${encodeURIComponent(positionCode)}/propuesta`,
    );
  }

  // ── Acceso de una persona ────────────────────────────────────────────────

  rolesDe(id: string): Observable<{ user_id: string; username: string; perfil_base: string | null; roles: Array<{ role_name: string; is_primary: boolean; permisos: number }> }> {
    return this.http.get<{ user_id: string; username: string; perfil_base: string | null; roles: Array<{ role_name: string; is_primary: boolean; permisos: number }> }>(
      `${this.users}/${id}/roles`,
    );
  }

  setRoles(id: string, roles: string[]): Observable<unknown> {
    return this.http.put(`${this.users}/${id}/roles`, { roles });
  }

  permisosDe(id: string): Observable<PermisosDePersona> {
    return this.http.get<PermisosDePersona>(`${this.users}/${id}/permissions`);
  }

  setPermisos(
    id: string,
    overrides: Array<{ permission_key: string; allow: boolean; nota?: string }>,
  ): Observable<unknown> {
    return this.http.put(`${this.users}/${id}/permissions`, { overrides });
  }

  alcanceDe(id: string): Observable<{ user_id: string; role_name: string; dimensions: Record<string, unknown> }> {
    return this.http.get<{ user_id: string; role_name: string; dimensions: Record<string, unknown> }>(
      `${this.users}/${id}/scope`,
    );
  }

  setAlcance(
    id: string,
    dimension: string,
    body: { mode: string | null; values?: string[]; mode_write?: string | null; nota?: string },
  ): Observable<unknown> {
    return this.http.put(`${this.users}/${id}/scope/${dimension}`, body);
  }

  /** La bitácora. 106 eventos de puesto y 72 de alcance que nunca se vieron. */
  eventosDe(id: string, limit = 50): Observable<EventoDePersona[]> {
    return this.http.get<EventoDePersona[]>(`${this.users}/${id}/events`, {
      params: new HttpParams().set('limit', String(limit)),
    });
  }

  // ── La organización (`/org`) ─────────────────────────────────────────────

  puestos(): Observable<PuestoFila[]> {
    return this.http.get<PuestoFila[]>(`${this.org}/positions`);
  }

  puesto(code: string): Observable<PuestoDetalle> {
    return this.http.get<PuestoDetalle>(`${this.org}/positions/${encodeURIComponent(code)}`);
  }

  crearPuesto(body: Record<string, unknown>): Observable<PuestoFila> {
    return this.http.post<PuestoFila>(`${this.org}/positions`, body);
  }

  editarPuesto(code: string, body: Record<string, unknown>): Observable<PuestoFila> {
    return this.http.put<PuestoFila>(`${this.org}/positions/${encodeURIComponent(code)}`, body);
  }

  bajaPuesto(code: string): Observable<unknown> {
    return this.http.delete(`${this.org}/positions/${encodeURIComponent(code)}`);
  }

  /** La arista de mando. Un ciclo vuelve como 400 nombrando los dos puestos. */
  setJefeDePuesto(code: string, jefe: string | null): Observable<unknown> {
    return this.http.put(`${this.org}/positions/${encodeURIComponent(code)}/reports-to`, {
      reports_to_position_code: jefe,
    });
  }

  responsabilidades(): Observable<ResponsabilidadFila[]> {
    return this.http.get<ResponsabilidadFila[]>(`${this.org}/responsibilities`);
  }

  /** El inverso. Antes la pantalla lo armaba con un GET por puesto: once por drawer. */
  puestosQueResponden(key: string): Observable<PuestoQueResponde[]> {
    return this.http.get<PuestoQueResponde[]>(
      `${this.org}/responsibilities/${encodeURIComponent(key)}/positions`,
    );
  }

  responsabilidadesDePuesto(code: string): Observable<ResponsabilidadDePuesto[]> {
    return this.http.get<ResponsabilidadDePuesto[]>(
      `${this.org}/positions/${encodeURIComponent(code)}/responsibilities`,
    );
  }

  asignarAPuesto(code: string, key: string, esPrincipal: boolean): Observable<ResponsabilidadDePuesto[]> {
    return this.http.post<ResponsabilidadDePuesto[]>(
      `${this.org}/positions/${encodeURIComponent(code)}/responsibilities`,
      { responsibility_key: key, es_principal: esPrincipal },
    );
  }

  quitarDePuesto(code: string, key: string): Observable<ResponsabilidadDePuesto[]> {
    return this.http.delete<ResponsabilidadDePuesto[]>(
      `${this.org}/positions/${encodeURIComponent(code)}/responsibilities/${encodeURIComponent(key)}`,
    );
  }

  responsabilidadesDePersona(id: string): Observable<ResponsabilidadesDePersona> {
    return this.http.get<ResponsabilidadesDePersona>(`${this.org}/users/${id}/responsibilities`);
  }

  /** ⚠️ `nota` es obligatoria: la rechaza el DTO y además el CHECK de la base. */
  asignarAPersona(
    id: string,
    body: { responsibility_key: string; accion?: string; nota: string; valid_from?: string; valid_to?: string | null },
  ): Observable<ResponsabilidadesDePersona> {
    return this.http.post<ResponsabilidadesDePersona>(`${this.org}/users/${id}/responsibilities`, body);
  }

  quitarDePersona(id: string, rowId: string): Observable<ResponsabilidadesDePersona> {
    return this.http.delete<ResponsabilidadesDePersona>(
      `${this.org}/users/${id}/responsibilities/${rowId}`,
    );
  }

  historiaDePuesto(id: string): Observable<HistoriaDePuesto> {
    return this.http.get<HistoriaDePuesto>(`${this.org}/users/${id}/position-history`);
  }

  coherencia(): Observable<Coherencia> {
    return this.http.get<Coherencia>(`${this.org}/coherencia`);
  }
}
