import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface AssignableVendor {
  id: string;
  username: string;
  role_name: string;
}
export interface RouteCatalogRow {
  route_id: string;
  route: string;
  zone: string | null;
}
export interface DailyAssignment {
  id: string;
  user_id: string;
  route_id: string;
  day_of_week: number; // 1=lun .. 7=dom
  status?: string;
}

/**
 * Panel de supervisor (vendor app): asignar rutas a vendedores. Escribe en
 * `daily_assignments` (vía /daily-assignments) — que es lo que la cartera del
 * vendedor realmente lee para mostrar "Mi ruta". Gateado TRADE_ROUTE_PLAN_GESTIONAR.
 */
@Injectable({ providedIn: 'root' })
export class SupervisorRoutesService {
  private readonly http = inject(HttpClient);
  private readonly vr = environment.apiUrl + '/commercial/vendor-routes';
  private readonly da = environment.apiUrl + '/daily-assignments';

  vendors(): Observable<AssignableVendor[]> {
    return this.http.get<AssignableVendor[]>(`${this.vr}/vendors`);
  }
  routeCatalog(): Observable<RouteCatalogRow[]> {
    return this.http.get<RouteCatalogRow[]>(`${this.vr}/route-catalog`);
  }
  assignmentsFor(userId: string): Observable<DailyAssignment[]> {
    return this.http.get<DailyAssignment[]>(this.da, {
      params: new HttpParams().set('user_id', userId),
    });
  }
  createAssignment(user_id: string, route_id: string, day_of_week: number) {
    return this.http.post<DailyAssignment>(this.da, { user_id, route_id, day_of_week });
  }
  deleteAssignment(id: string) {
    return this.http.delete(`${this.da}/${id}`);
  }
}
