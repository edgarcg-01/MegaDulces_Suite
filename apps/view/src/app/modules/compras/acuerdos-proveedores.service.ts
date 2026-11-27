import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AcuerdoGuardado, AcuerdosDeReunion, CapturarAcuerdoDto, ListaAcuerdos } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos: `/api/compras/proveedores/acuerdos`. Con las llaves de Citas (DC44): leer
 * pide `COMPRAS_CITAS_VER` o `COMPRAS_CITAS_AGENDAR`; capturar, editar, iniciar, cumplir y cancelar, sólo agendar.
 * Quién puede ser responsable sale de `CitasProveedoresService.opciones()` (quien ve la agenda).
 */
@Injectable({ providedIn: 'root' })
export class AcuerdosProveedoresService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/compras/proveedores/acuerdos`;

  lista(): Observable<ListaAcuerdos> {
    return this.http.get<ListaAcuerdos>(this.base);
  }

  deReunion(meetingId: string): Observable<AcuerdosDeReunion> {
    return this.http.get<AcuerdosDeReunion>(`${this.base}/reunion/${encodeURIComponent(meetingId)}`);
  }

  capturar(meetingId: string, dto: CapturarAcuerdoDto): Observable<AcuerdoGuardado> {
    return this.http.post<AcuerdoGuardado>(`${this.base}/reunion/${encodeURIComponent(meetingId)}`, dto);
  }

  editar(id: string, dto: CapturarAcuerdoDto): Observable<AcuerdoGuardado> {
    return this.http.post<AcuerdoGuardado>(`${this.base}/${encodeURIComponent(id)}/editar`, dto);
  }

  iniciar(id: string): Observable<AcuerdoGuardado> {
    return this.http.post<AcuerdoGuardado>(`${this.base}/${encodeURIComponent(id)}/iniciar`, {});
  }

  cumplir(id: string, note: string): Observable<AcuerdoGuardado> {
    return this.http.post<AcuerdoGuardado>(`${this.base}/${encodeURIComponent(id)}/cumplir`, { note });
  }

  cancelar(id: string, note: string): Observable<AcuerdoGuardado> {
    return this.http.post<AcuerdoGuardado>(`${this.base}/${encodeURIComponent(id)}/cancelar`, { note });
  }
}
