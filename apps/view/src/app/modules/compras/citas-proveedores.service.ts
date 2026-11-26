import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  AgendaCitas, AgendarReunionDto, DetalleReunion, OpcionesCitas, ProveedoresCitas, ReunionGuardada,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[PQ.3.8]` Compras › Proveedores › Citas: `/api/compras/proveedores/citas`. Leer pide `COMPRAS_CITAS_VER` o
 * `COMPRAS_CITAS_AGENDAR`; todo lo demás (opciones, buscador y escrituras), sólo `COMPRAS_CITAS_AGENDAR` (DC41).
 */
@Injectable({ providedIn: 'root' })
export class CitasProveedoresService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/compras/proveedores/citas`;

  /** La semana que contiene `semana` (AAAA-MM-DD; sin ella, la de hoy) y las que pasaron sin minuta. */
  agenda(semana?: string | null): Observable<AgendaCitas> {
    return this.http.get<AgendaCitas>(this.base, { params: semana ? { semana } : {} });
  }

  detalle(id: string): Observable<DetalleReunion> {
    return this.http.get<DetalleReunion>(`${this.base}/${encodeURIComponent(id)}`);
  }

  opciones(): Observable<OpcionesCitas> {
    return this.http.get<OpcionesCitas>(`${this.base}/opciones`);
  }

  proveedores(q: string): Observable<ProveedoresCitas> {
    return this.http.get<ProveedoresCitas>(`${this.base}/proveedores`, { params: { q } });
  }

  agendar(dto: AgendarReunionDto): Observable<ReunionGuardada> {
    return this.http.post<ReunionGuardada>(this.base, dto);
  }

  editar(id: string, dto: AgendarReunionDto): Observable<ReunionGuardada> {
    return this.http.post<ReunionGuardada>(`${this.base}/${encodeURIComponent(id)}/editar`, dto);
  }

  confirmar(id: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/${encodeURIComponent(id)}/confirmar`, {});
  }

  minuta(id: string, minutes: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/${encodeURIComponent(id)}/minuta`, { minutes });
  }

  cancelar(id: string, reason: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/${encodeURIComponent(id)}/cancelar`, { reason });
  }
}
