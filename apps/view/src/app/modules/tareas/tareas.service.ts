import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AvanceDelEquipo, DetalleEntrega, GuardarPunto, MisTareas, NormaTarea, NuevaVersionNorma, SubirEvidencia,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MDT.3]` Tareas por puesto: el manual de cada puesto, entregado con evidencia (`/checklists`). */
@Injectable({ providedIn: 'root' })
export class TareasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/checklists`;

  private fecha(date?: string | null): HttpParams | undefined {
    return date ? new HttpParams().set('date', date) : undefined;
  }

  mias(date?: string | null): Observable<MisTareas> {
    return this.http.get<MisTareas>(`${this.base}/mine`, { params: this.fecha(date) });
  }

  abrir(templateId: string, periodDate: string): Observable<DetalleEntrega> {
    return this.http.post<DetalleEntrega>(`${this.base}/runs`, { template_id: templateId, period_date: periodDate });
  }

  detalle(id: string): Observable<DetalleEntrega> {
    return this.http.get<DetalleEntrega>(`${this.base}/runs/${encodeURIComponent(id)}`);
  }

  guardarPunto(id: string, itemId: string, body: GuardarPunto): Observable<DetalleEntrega> {
    return this.http.patch<DetalleEntrega>(`${this.base}/runs/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, body);
  }

  subir(id: string, itemId: string, body: SubirEvidencia): Observable<DetalleEntrega> {
    return this.http.post<DetalleEntrega>(`${this.base}/runs/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/files`, body);
  }

  retirar(id: string, fileId: string): Observable<DetalleEntrega> {
    return this.http.delete<DetalleEntrega>(`${this.base}/runs/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`);
  }

  entregar(id: string, employeeNote: string | null): Observable<DetalleEntrega> {
    return this.http.post<DetalleEntrega>(`${this.base}/runs/${encodeURIComponent(id)}/submit`, { employee_note: employeeNote });
  }

  equipo(date?: string | null): Observable<AvanceDelEquipo> {
    return this.http.get<AvanceDelEquipo>(`${this.base}/team`, { params: this.fecha(date) });
  }

  /** `[MDT.3.2b]` Versión nueva de una tarea del manual (puntos, hora límite, desde cuándo, motivo). */
  nuevaVersion(templateId: string, body: NuevaVersionNorma): Observable<NormaTarea> {
    return this.http.post<NormaTarea>(`${this.base}/norms/${encodeURIComponent(templateId)}/versions`, body);
  }

  normas(positionCode?: string | null): Observable<NormaTarea[]> {
    return this.http.get<NormaTarea[]>(`${this.base}/norms`, {
      params: positionCode ? new HttpParams().set('position_code', positionCode) : undefined,
    });
  }
}
