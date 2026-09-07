import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';

export interface SalesRouteRow {
  sales_route: string;
  customer_count: number;
  assigned_to: { id: string; user_id: string; username: string }[];
}
export interface VendorOption {
  id: string;
  username: string;
  role_name: string;
}
export interface RouteCustomer {
  id: string;
  code: string;
  name: string;
  visit_sequence: number | null;
  phone?: string | null;
  whatsapp?: string | null;
}
export interface Assignment {
  id: string;
  user_id: string;
  username: string;
  sales_route: string;
  created_at: string;
}
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}
export interface RouteWarehouseRow {
  route_id: string;
  route: string;
  zone: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  suggested_id: string | null;
  suggested_name: string | null;
}

/** V.0 — gestión de cartera de ventas (vendedor → rutas) y orden de visita. */
@Injectable({ providedIn: 'root' })
export class CarteraService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/vendor-routes`;

  listSalesRoutes() {
    return this.http.get<SalesRouteRow[]>(`${this.base}/sales-routes`);
  }
  listVendors() {
    return this.http.get<VendorOption[]>(`${this.base}/vendors`);
  }
  listAssignments(userId?: string) {
    let params = new HttpParams();
    if (userId) params = params.set('user_id', userId);
    return this.http.get<Assignment[]>(this.base, { params });
  }
  assign(user_id: string, sales_route: string) {
    return this.http.post(this.base, { user_id, sales_route });
  }
  unassign(id: string) {
    return this.http.delete(`${this.base}/${id}`);
  }
  customersByRoute(salesRoute: string) {
    return this.http.get<RouteCustomer[]>(`${this.base}/customers`, {
      params: new HttpParams().set('sales_route', salesRoute),
    });
  }
  setOrder(sales_route: string, customer_ids: string[]) {
    return this.http.put<{ ordered: number }>(`${this.base}/order`, { sales_route, customer_ids });
  }
  /** Rutas del catálogo con su sucursal de surtido + almacenes asignables + sugerencia por zona. */
  routesWarehouses() {
    return this.http.get<{ warehouses: WarehouseOption[]; routes: RouteWarehouseRow[] }>(
      `${this.base}/routes-warehouses`,
    );
  }
  /** Asigna/cambia la sucursal de surtido de una ruta. */
  setRouteWarehouse(routeId: string, warehouse_id: string) {
    return this.http.put(`${this.base}/routes/${routeId}/warehouse`, { warehouse_id });
  }
  /** Renombra una sucursal (warehouse). Gateado COMMERCIAL_WAREHOUSES_GESTIONAR. */
  renameWarehouse(id: string, name: string) {
    return this.http.patch(`${environment.apiUrl}/commercial/warehouses/${id}`, { name });
  }
}
