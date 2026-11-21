import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CalendarioCompras, FueraDeCicloDto, GuardarReglaDto, GuardarReglaRespuesta, MarcarRevisionDto, PropuestasCalendario,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[PQ.3.5]` Compras › Calendario de compras: `/api/compras/calendario` (PQ.3.4). Los GET piden VER, GESTIONAR
 * o CICLO; marcar el día pide GESTIONAR; definir, sacar del ciclo y dar de baja piden CICLO (DC7, DC8).
 */
@Injectable({ providedIn: 'root' })
export class CalendarioComprasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/compras/calendario`;

  calendario(): Observable<CalendarioCompras> {
    return this.http.get<CalendarioCompras>(this.base);
  }

  /** Lo que propone Kepler (vista PQ.3.1) para los proveedores con compra y sin regla. */
  propuestas(): Observable<PropuestasCalendario> {
    return this.http.get<PropuestasCalendario>(`${this.base}/propuestas`);
  }

  /** Si ya hay una regla viva de ese proveedor en ese alcance, la API la REEMPLAZA (`accion: 'actualizada'`). */
  guardarRegla(dto: GuardarReglaDto): Observable<GuardarReglaRespuesta> {
    return this.http.post<GuardarReglaRespuesta>(`${this.base}/reglas`, dto);
  }

  darDeBaja(id: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/reglas/${encodeURIComponent(id)}/baja`, {});
  }

  fueraDeCiclo(id: string, dto: FueraDeCicloDto): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/reglas/${encodeURIComponent(id)}/fuera-de-ciclo`, dto);
  }

  /** La MISMA fecha otra vez corrige la marca (`accion: 'corregida'`). */
  marcar(id: string, dto: MarcarRevisionDto): Observable<{ id: string; accion: 'creada' | 'corregida' }> {
    return this.http.post<{ id: string; accion: 'creada' | 'corregida' }>(`${this.base}/reglas/${encodeURIComponent(id)}/marcas`, dto);
  }
}
