import { HttpClient } from '@angular/common/http';
import { Injectable, Signal, inject, signal } from '@angular/core';
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
  /**
   * `[ID.26]`/`[SN.3]` `false` = el modo es `own` pero la ficha no trae con qué resolverlo
   * (78 de 122 usuarios sin `warehouse_code`): el backend emite el mismo WHERE que `none` y lo
   * DECLARA. El front lo muestra como "sin determinar", nunca como "sin alcance".
   */
  resolvable?: boolean;
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

  /**
   * `[ZN.2]` — Las mismas sucursales, pero como **signal** y con el tercer estado.
   *
   * ── Por qué existe además de `warehouses()` ─────────────────────────────────
   * Los componentes que arman un desplegable no quieren un Observable: quieren un
   * valor que puedan leer dentro de un `computed`. Sin esto, cada pantalla se
   * escribe su propio `subscribe` + `signal` — y ya estaba pasando: el apartado
   * Tienda tenía el suyo, y compras rellenaba con el array del bundle. Un
   * primitivo copiado a mano en cuatro lugares se desincroniza (ADR-056).
   *
   * ── `null` NO es «ninguna» ──────────────────────────────────────────────────
   * `null` = todavía no contestó `me/scope`. `[]` = contestó y **no te toca
   * ninguna**. Son cosas distintas y se ven igual en pantalla si se colapsan: es
   * exactamente el defecto que tenía compras, donde `null` significaba a la vez
   * «alcance global» y «no cargó», y por las dudas se ofrecían las 9.
   *
   * La carga es perezosa y una sola vez por sesión (`mine()` ya cachea con
   * `shareReplay`), así que llamarlo desde N componentes no son N requests.
   */
  private readonly _warehouses = signal<ScopeOption[] | null>(null);
  private pedidas = false;
  misSucursales(): Signal<ScopeOption[] | null> {
    if (!this.pedidas) {
      this.pedidas = true;
      this.warehouses().subscribe({
        next: (o) => this._warehouses.set(o),
        // Si el alcance no contesta, se declara «ninguna»: el backend recorta
        // igual lo que devuelve, así que lo único que se pierde es filtrar a
        // mano. Rellenar con la red completa sería el fail-open que esto cierra.
        error: () => this._warehouses.set([]),
      });
    }
    return this._warehouses.asReadonly();
  }

  /** Se llama tras un cambio de sesión: el alcance del próximo usuario es otro. */
  reset(): void {
    this.cache$ = undefined;
    this.pedidas = false;
    this._warehouses.set(null);
  }
}
