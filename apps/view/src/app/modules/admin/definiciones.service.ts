import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  ActualizarDefinicion, ContestarDefinicion, DefinicionVista, PersonaAsignable,
} from '@megadulces/contracts';

/**
 * `[DP.3.1]` — El cliente de `/definitions` (Fase DP). Los tipos vienen de `@megadulces/contracts`:
 * un cambio de forma en el backend es un error de compilación de este lado, no un `undefined`.
 */
@Injectable({ providedIn: 'root' })
export class DefinicionesService {
  private http = inject(HttpClient);
  private base = `${environment.apiUrl}/definitions`;

  /** Todas (DEFINICIONES_VER). */
  todas(consumer?: string): Observable<DefinicionVista[]> {
    const params = consumer ? new HttpParams().set('consumer', consumer) : undefined;
    return this.http.get<DefinicionVista[]>(this.base, { params });
  }

  /** Las mías (DEFINICIONES_CONTESTAR). */
  mias(): Observable<DefinicionVista[]> {
    return this.http.get<DefinicionVista[]>(`${this.base}/mine`);
  }

  asignables(): Observable<PersonaAsignable[]> {
    return this.http.get<PersonaAsignable[]>(`${this.base}/assignable`);
  }

  contestar(id: string, body: ContestarDefinicion): Observable<DefinicionVista> {
    return this.http.post<DefinicionVista>(`${this.base}/${id}/answers`, body);
  }

  actualizar(id: string, body: ActualizarDefinicion): Observable<DefinicionVista> {
    return this.http.patch<DefinicionVista>(`${this.base}/${id}`, body);
  }
}
