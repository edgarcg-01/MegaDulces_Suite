import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  BulkAssignmentsBody,
  BulkAssignmentsPreview,
  BulkAssignmentsResult,
  CreateAssignmentBody,
  ProductAssignment,
  ProductLocationDetail,
  ProductLocationFilter,
  ProductLocationOrder,
  ProductLocationsList,
  UpdateAssignmentBody,
  BulkLocationsBody,
  BulkLocationsPreview,
  BulkLocationsResult,
  CreateWarehouseLocationBody,
  LocationCaptureBatch,
  UndoLocationBatchResult,
  WarehouseLocationRow,
  WarehouseLocationsResponse,
  CroquisResponse,
  CrearPiezaBody,
  DerivarPiezasResult,
  LocationZone,
  WarehouseFixture,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[UB.1]`/`[UB.2]` Cliente del catálogo de ubicaciones (`/almacen/ubicaciones`, Fase UB). */
@Injectable({ providedIn: 'root' })
export class AlmacenUbicacionesCatalogoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/locations`;

  list(warehouseId?: string | null): Observable<WarehouseLocationsResponse> {
    let p = new HttpParams();
    if (warehouseId) p = p.set('warehouse_id', warehouseId);
    return this.http.get<WarehouseLocationsResponse>(this.base, { params: p });
  }

  create(body: CreateWarehouseLocationBody): Observable<WarehouseLocationRow> {
    return this.http.post<WarehouseLocationRow>(this.base, body);
  }

  // ── [UB.2] captura masiva ──
  preview(body: BulkLocationsBody): Observable<BulkLocationsPreview> {
    return this.http.post<BulkLocationsPreview>(`${this.base}/bulk/preview`, body);
  }

  apply(body: BulkLocationsBody): Observable<BulkLocationsResult> {
    return this.http.post<BulkLocationsResult>(`${this.base}/bulk`, body);
  }

  batches(warehouseId: string): Observable<LocationCaptureBatch[]> {
    return this.http.get<LocationCaptureBatch[]>(`${this.base}/batches`, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }

  undo(batchId: string): Observable<UndoLocationBatchResult> {
    return this.http.post<UndoLocationBatchResult>(`${this.base}/batches/${batchId}/undo`, {});
  }

  // ── [UB.PL] el croquis de la sucursal ──

  /** Las piezas de un almacén y zona, y cuántas ubicaciones todavía no cuelgan de ninguna. */
  croquis(warehouseId: string, zona: LocationZone): Observable<CroquisResponse> {
    return this.http.get<CroquisResponse>(`${this.base}/fixtures`, {
      params: new HttpParams().set('warehouse_id', warehouseId).set('zona', zona),
    });
  }

  /** `[UB.PL.2]` Deriva las piezas del catálogo que ya existe. No crea ni borra ubicaciones. */
  derivarPiezas(warehouseId: string): Observable<DerivarPiezasResult> {
    return this.http.post<DerivarPiezasResult>(`${this.base}/fixtures/derivar`, { warehouse_id: warehouseId });
  }

  crearPieza(body: CrearPiezaBody): Observable<WarehouseFixture> {
    return this.http.post<WarehouseFixture>(`${this.base}/fixtures`, body);
  }

  /** Mueve una pieza en el croquis o la renombra. No toca ninguna ubicación ni ningún código. */
  moverPieza(id: string, body: { fila?: number | null; columna?: number | null; label?: string | null }): Observable<WarehouseFixture> {
    return this.http.patch<WarehouseFixture>(`${this.base}/fixtures/${id}`, body);
  }

  // ── [UB.3] asignación por producto y presentación ──
  /** Una página de productos: `limit` va SIEMPRE (la pantalla pagina contra `total`, no acepta el default del servidor). */
  products(warehouseId: string, opts: { q: string; filtro: ProductLocationFilter; limit: number; offset: number; orden?: ProductLocationOrder }): Observable<ProductLocationsList> {
    const { q, filtro, limit, offset, orden } = opts;
    let p = new HttpParams().set('warehouse_id', warehouseId).set('filtro', filtro).set('limit', limit).set('offset', offset);
    if (q) p = p.set('q', q);
    if (orden) p = p.set('orden', orden); // [UB.RF.11] `venta`: lo más vendido primero
    return this.http.get<ProductLocationsList>(`${this.base}/products`, { params: p });
  }

  productDetail(warehouseId: string, productId: string): Observable<ProductLocationDetail> {
    return this.http.get<ProductLocationDetail>(`${this.base}/products/${productId}`, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }

  createAssignment(body: CreateAssignmentBody): Observable<ProductAssignment> {
    return this.http.post<ProductAssignment>(`${this.base}/assignments`, body);
  }

  updateAssignment(id: string, body: UpdateAssignmentBody): Observable<ProductAssignment> {
    return this.http.patch<ProductAssignment>(`${this.base}/assignments/${id}`, body);
  }

  removeAssignment(id: string): Observable<{ id: string; quitada: true }> {
    return this.http.delete<{ id: string; quitada: true }>(`${this.base}/assignments/${id}`);
  }

  assignmentsPreview(body: BulkAssignmentsBody): Observable<BulkAssignmentsPreview> {
    return this.http.post<BulkAssignmentsPreview>(`${this.base}/assignments/bulk/preview`, body);
  }

  assignmentsApply(body: BulkAssignmentsBody): Observable<BulkAssignmentsResult> {
    return this.http.post<BulkAssignmentsResult>(`${this.base}/assignments/bulk`, body);
  }
}
