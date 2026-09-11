import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';
import type { MeContext, MeWork } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

/**
 * `[SN.3]` — Contexto de la persona en sesión (`GET /users/me/context`): nombre, rol, puesto,
 * departamento, sucursal y zona de la FICHA. Alimenta el bloque "Mi contexto" de la landing.
 *
 * No está en `auth.user()` porque el JWT no lo trae (`nombre`, puesto y departamento viven en
 * `identity.users` y sus catálogos) y no se quiere engordar el token por un dato de pantalla.
 * Es self-scoped y sin permiso, igual que `me/scope`.
 *
 * Cache por sesión, ATADO al `sub` del usuario: si cambia la persona (logout/login en la misma
 * pestaña) el cache se invalida solo — no hace falta que `AuthService.logout()` conozca a este
 * servicio. Los errores HTTP NO se tragan acá: la pantalla los muestra como error, que es
 * distinto de "sin datos" (DESIGN pre-vuelo 6).
 */
@Injectable({ providedIn: 'root' })
export class MeContextService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private cache$?: Observable<MeContext>;
  private cachedFor: string | null = null;

  mine(): Observable<MeContext> {
    const sub = this.auth.user()?.sub ?? null;
    if (!this.cache$ || this.cachedFor !== sub) {
      this.cachedFor = sub;
      this.cache$ = this.http
        .get<MeContext>(`${environment.apiUrl}/users/me/context`)
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    }
    return this.cache$;
  }

  /**
   * `[SN.7]` — Trabajo pendiente de la persona (`GET /users/me/work`).
   *
   * SIN cache, a propósito: un conteo de pendientes es un número que cambia mientras la persona
   * trabaja, y servirlo de un `shareReplay` mostraría "12 por revisar" después de haber revisado
   * los 12. La landing lo pide cada vez que se abre, y el botón "Actualizar" lo vuelve a pedir.
   */
  work(): Observable<MeWork> {
    return this.http.get<MeWork>(`${environment.apiUrl}/users/me/work`);
  }

  reset(): void {
    this.cache$ = undefined;
    this.cachedFor = null;
  }
}
