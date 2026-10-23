import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  FIRMA_RUTA_PC_API, FIRMA_RUTA_PUBLICA_API,
  type ContextoFirma, type FalloFirmaSolicitud, type FirmaSolicitudAbierta, type FirmaSolicitudEstado,
  type FirmaSolicitudTelefono,
} from '@megadulces/contracts';

/**
 * ⭐⭐ `[CG.201]` **La firma por teléfono, por HTTP.** La PC pide, repasa y cancela; el teléfono ve
 * y firma. Reemplaza al emparejamiento por socket, que perdía el pedido con cada despliegue.
 *
 * Toda llamada devuelve un resultado, nunca lanza: `{ ok: false, fallo }` con la causa que mandó
 * el servidor, o `red` si no hubo respuesta. Así quien la usa decide qué decir sin `try`.
 */
export type ResultadoFirma<T> =
  | { readonly ok: true; readonly v: T }
  | { readonly ok: false; readonly fallo: FalloFirmaSolicitud | 'red' | 'desconocido' };

/** Cuánto espera cada llamada antes de darla por perdida. El reintento lo decide quien llama. */
const PLAZO_MS = 10_000;

@Injectable({ providedIn: 'root' })
export class CajaFirmaApiService {
  private readonly http = inject(HttpClient);
  private readonly pc = `${environment.apiUrl}/${FIRMA_RUTA_PC_API}`;
  private readonly publica = `${environment.apiUrl}/${FIRMA_RUTA_PUBLICA_API}`;

  abrir(ctx: ContextoFirma): Promise<ResultadoFirma<FirmaSolicitudAbierta>> {
    return this.pedir(this.http.post<FirmaSolicitudAbierta>(this.pc, ctx));
  }

  estado(id: string): Promise<ResultadoFirma<FirmaSolicitudEstado>> {
    return this.pedir(this.http.get<FirmaSolicitudEstado>(`${this.pc}/${encodeURIComponent(id)}`));
  }

  cancelar(id: string): Promise<ResultadoFirma<{ ok: true }>> {
    return this.pedir(this.http.post<{ ok: true }>(`${this.pc}/${encodeURIComponent(id)}/cancelar`, {}));
  }

  ver(token: string, telefono: string): Promise<ResultadoFirma<FirmaSolicitudTelefono>> {
    return this.pedir(this.http.post<FirmaSolicitudTelefono>(`${this.publica}/${encodeURIComponent(token)}/ver`, { telefono }));
  }

  firmar(token: string, telefono: string, png: string, nombre: string | null): Promise<ResultadoFirma<{ ok: true; repetida: boolean }>> {
    return this.pedir(this.http.post<{ ok: true; repetida: boolean }>(
      `${this.publica}/${encodeURIComponent(token)}/firmar`, { telefono, png, nombre }));
  }

  private async pedir<T>(obs: Observable<T>): Promise<ResultadoFirma<T>> {
    try {
      return { ok: true, v: await firstValueFrom(obs.pipe(timeout(PLAZO_MS))) };
    } catch (e) {
      return { ok: false, fallo: falloDe(e) };
    }
  }
}

/**
 * La causa de un error HTTP. ⚠️ «No hubo respuesta» (status 0, timeout, 5xx) es `red`: se puede
 * reintentar. Un 4xx con `fallo` es una respuesta del servidor: reintentar no la cambia.
 */
export function falloDe(e: unknown): FalloFirmaSolicitud | 'red' | 'desconocido' {
  if (e instanceof HttpErrorResponse) {
    if (e.status === 0 || e.status >= 500) return 'red';
    const f = (e.error as { fallo?: string } | null)?.fallo;
    return (f as FalloFirmaSolicitud) || 'desconocido';
  }
  // `TimeoutError` de rxjs y cualquier otro: no hubo respuesta.
  return 'red';
}
