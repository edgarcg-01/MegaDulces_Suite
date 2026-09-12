import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { tap, timeout } from 'rxjs/operators';
import { Observable, firstValueFrom } from 'rxjs';
import { Permission } from '../constants/permissions';
import { DataScopeService } from './data-scope.service';
import { PermissionsService } from './permissions.service';

export interface JwtPayload {
  sub: string;
  username: string;
  rol?: string;
  role_name?: string;
  zona?: string;
  /** Sucursal Kepler asignada ('00'..'05'). Seteada = scopeado a esa sucursal (monitor Tienda). */
  warehouse_code?: string;
  permissions?: Record<string, boolean>;
  exp: number;
  iat: number;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

const STORAGE_KEY = 'auth_token';

/**
 * `[ID.30]` Techo duro para el initializer de permisos. Es lo que separa
 * «arrancar con el mapa fresco» de «la app no abre porque el API no contesta».
 * 3 s es más que el p99 de `me/access` (un SELECT con cache de 30 s) y menos
 * que la paciencia de alguien que abre una pantalla en el piso de tienda.
 */
const TIMEOUT_ACCESO_MS = 3000;

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private apiUrl = environment.apiUrl;

  public token = signal<string | null>(null);
  public user = signal<JwtPayload | null>(null);

  constructor(
    private http: HttpClient,
    private perms: PermissionsService,
    private scope: DataScopeService,
  ) {
    this.restoreSession();
  }

  private restoreSession() {
    // El JWT supera los 4 KB que un cookie soporta
    // en la mayoría de navegadores (Chrome/Edge silently drop >4096 bytes).
    // Usamos localStorage que permite hasta 5 MB y no se trunca silenciosamente.
    let stored: string | null = null;
    try {
      stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    } catch {
      stored = null;
    }
    if (!stored) {
      // Fallback retro-compatibilidad: leer cookie si quedó alguno de antes.
      const m = typeof document !== 'undefined'
        ? document.cookie.match(/(^|;)\s*auth_token\s*=\s*([^;]+)/)
        : null;
      stored = m?.[2] ?? null;
    }
    if (stored) {
      this.setSession(stored, false);
    }
  }

  public get isAuthenticated(): boolean {
    return !!this.token();
  }

  /**
   * `[ID.21]` — Re-lee los permisos VIGENTES del backend y reemplaza el snapshot
   * del JWT.
   *
   * Por qué existe: los permisos viajan en el token (ADR-050). El backend aplica
   * un cambio en ≤30s, pero el MENÚ seguía mostrando lo de antes hasta que la
   * persona volvía a entrar. Con permisos por usuario eso se vuelve la queja
   * principal — "le di el permiso y no le aparece". Con esto basta recargar.
   *
   * No toca el token: sólo el mapa de permisos en memoria. Si falla, se
   * queda lo que traía el JWT (fail-open al comportamiento anterior, nunca a
   * cero permisos).
   */
  refreshAccess(): void {
    if (!this.token()) return;
    this.http
      .get<{ permissions: Record<string, boolean> }>(`${this.apiUrl}/users/me/access`)
      .subscribe({
        next: (res) => this.aplicarAcceso(res),
        error: () => { /* se queda el snapshot del JWT */ },
      });
  }

  /**
   * `[ID.30]` — Resuelve el mapa de permisos ANTES de la primera navegación.
   *
   * Por qué hace falta y no alcanza con `refreshAccess()`: ése se dispara
   * fire-and-forget desde el `ngOnInit` del componente raíz, que corre **después**
   * de que el router resolvió la primera ruta. O sea que los guards ya decidieron
   * con lo que trajera el token. Mientras el mapa viaja en el JWT eso da igual
   * —está ahí desde el primer instante—, pero es exactamente la ventana que hace
   * imposible sacarlo: sin este initializer, quitar `permissions` del token
   * mandaría a todo no-admin a `/sin-acceso` en la primera carga.
   *
   * Contrato: **siempre resuelve, nunca rechaza, y nunca cuelga el arranque.**
   * Si el backend tarda o falla, se sigue con lo que haya (hoy: el snapshot del
   * token). Un initializer que puede colgar la app es peor que el problema que
   * viene a resolver.
   */
  async resolverAccesoInicial(): Promise<void> {
    if (!this.token()) return;
    try {
      const res = await firstValueFrom(
        this.http
          .get<{ permissions: Record<string, boolean> }>(`${this.apiUrl}/users/me/access`)
          .pipe(timeout(TIMEOUT_ACCESO_MS)),
      );
      this.aplicarAcceso(res);
    } catch {
      /* se arranca con el snapshot del JWT; `perms.estado()` sigue diciendo 'jwt' */
    }
  }

  /**
   * Un mapa VACÍO no se aplica nunca. Si el backend contesta `{}` por cualquier
   * motivo (token legacy sin tenant, cache frío, error tragado), reemplazar el
   * snapshot dejaría al usuario sin menú — un fail-closed en el camino de
   * arranque. Ante la duda, gana el JWT.
   */
  private aplicarAcceso(res: { permissions?: Record<string, boolean> } | null): void {
    if (!res?.permissions || Object.keys(res.permissions).length === 0) return;
    const actual = this.user();
    if (actual) {
      this.user.set({ ...actual, permissions: res.permissions });
    }
    this.perms.load(res.permissions, actual?.role_name ?? null, 'servidor');
  }

  login(credentials: {
    username: string;
    password: string;
  }): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>(`${this.apiUrl}/auth/login`, credentials)
      .pipe(
        tap((response) => {
          this.setSession(response.access_token);
        }),
      );
  }

  /**
   * Auth multi-tenant para Portal B2B y nuevo flujo customer_b2b.
   * El backend valida tenant_slug + username + password contra `commercial.users`
   * filtrado por tenant. JWT incluye `tenant_id` además del estándar.
   */
  loginMt(payload: {
    tenant_slug: string;
    username: string;
    password: string;
  }): Observable<{ access_token: string; user: any }> {
    return this.http
      .post<{ access_token: string; user: any }>(`${this.apiUrl}/auth-mt/login`, payload)
      .pipe(
        tap((response) => {
          this.setSession(response.access_token);
        }),
      );
  }

  logout(): void {
    this.token.set(null);
    this.user.set(null);
    this.perms.clear();
    // El ALCANCE también es de la sesión que se va. `DataScopeService` cachea con
    // `shareReplay` para toda la vida del SPA y su `reset()` estaba escrito pero sin llamador:
    // al cambiar de usuario SIN recargar la página, los selectores de sucursal seguían
    // ofreciendo las del usuario anterior. El backend recorta igual (ADR-050), así que no se
    // filtraban filas — pero la pantalla mentía: un usuario de una sucursal veía nueve,
    // elegía una ajena y la tabla volvía vacía sin decir por qué.
    this.scope.reset();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
    // Limpiar cookie legacy si quedó alguno
    if (typeof document !== 'undefined') {
      document.cookie = 'auth_token=; max-age=0; path=/; SameSite=Lax;';
    }
  }

  private setSession(token: string, persist: boolean = true): void {
    try {
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64)) as JwtPayload & { rol?: string; role_name?: string; permissions?: Record<string, boolean> };

      payload.role_name = payload.rol || payload.role_name;

      this.token.set(token);
      this.user.set(payload);

      this.perms.load(payload.permissions, payload.role_name);
      // Sesión nueva ⇒ alcance nuevo. Se limpia también acá y no sólo en logout: el login
      // desde una sesión ya abierta (cambio de usuario) no pasa por logout.
      this.scope.reset();

      if (persist) {
        try { localStorage.setItem(STORAGE_KEY, token); } catch { /* quota / privacy mode */ }
      }
    } catch (error) {
      console.error('Invalid token format', error);
      this.logout();
    }
  }
}
