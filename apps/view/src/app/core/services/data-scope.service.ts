import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map, of, shareReplay } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[ID.2]` — Alcance de datos del usuario en sesión (Fase ID / ADR-050).
 *
 * El permiso dice QUÉ ACCIÓN; el alcance dice SOBRE QUÉ FILAS. Son ejes
 * distintos y se invalidan distinto: el permiso viaja en el JWT (cambiarlo
 * exige re-login), el alcance se lee de DB con TTL — por eso NO está en
 * `auth.user()` y hay que preguntarlo.
 *
 * `GET /users/me/scope` no pide permiso (preguntar qué podés ver sería
 * circular). Se cachea con `shareReplay(1)` para toda la sesión: alimenta
 * selectores, no decide seguridad — el backend recorta igual.
 */
export type ScopeMode = 'none' | 'own' | 'listed' | 'all';

export interface ScopeOption { value: string; label: string }

export interface ScopeDim {
  mode: ScopeMode;
  modeWrite: ScopeMode;
  source: string;
  nota?: string | null;
  options: ScopeOption[];
}

export interface MyScope {
  user_id: string;
  role_name: string;
  dimensions: Record<string, ScopeDim>;
}

@Injectable({ providedIn: 'root' })
export class DataScopeService {
  private readonly http = inject(HttpClient);
  private cache$?: Observable<MyScope | null>;

  /** Alcance completo del usuario en sesión (cacheado). `null` si el back no respondió. */
  mine(): Observable<MyScope | null> {
    if (!this.cache$) {
      this.cache$ = this.http.get<MyScope>(`${environment.apiUrl}/users/me/scope`).pipe(
        // Sin alcance no se rompe la pantalla: el backend ya recorta lo que devuelve.
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.cache$;
  }

  /** Una dimensión suelta (`warehouse`, `zone`, …). */
  dim(dimension: string): Observable<ScopeDim | null> {
    return this.mine().pipe(map((s) => s?.dimensions?.[dimension] ?? null));
  }

  /**
   * Sucursales que el usuario puede elegir, ya resueltas:
   *   `all`    → todas las opciones (rol global);
   *   `own`/`listed` → exactamente las suyas;
   *   `none`   → vacío (no tiene sucursal asignada).
   */
  warehouses(): Observable<ScopeOption[]> {
    return this.dim('warehouse').pipe(map((d) => d?.options ?? []));
  }

  /** Se llama tras un cambio de sesión: el alcance del próximo usuario es otro. */
  reset(): void { this.cache$ = undefined; }
}
