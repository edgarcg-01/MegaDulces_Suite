import { Injectable, Injector, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { tap, timeout } from 'rxjs/operators';
import { Observable, firstValueFrom } from 'rxjs';
import { Permission } from '../constants/permissions';
import { DataScopeService } from './data-scope.service';
import { PermissionsService } from './permissions.service';
import { limpiarRastroDeSesion } from '@megadulces/ui-web';
import type { RastroLimpiado } from '@megadulces/ui-web';
// `[BND.1]` ⚠️ `import type`, NO un import normal: este archivo es EAGER (lo usan el login, los
// guards y el shell), y `offline-database.service` arrastra Dexie — 94.7 KB medidos dentro del
// `main` de producción. Un `import type` se borra al compilar y no empaqueta nada; la clase real
// llega por `await import()` allá abajo, que es lo único que de verdad la saca del arranque.
import type { OfflineDatabaseService } from './offline-database.service';
import { decidirBorradoOffline } from './offline-wipe';

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
    /** `[SEG.3]` Para resolver la base offline PEREZOSAMENTE — ver `decidirYLimpiar`. */
    private injector: Injector,
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

  /**
   * `[SEG.2]` Cerrar sesión borra el rastro de quien se va, y con `derribar` además **recarga**.
   *
   * ── Por qué la recarga, y por qué no alcanza con limpiar servicio por servicio ──────────────
   * Medido el 2026-09-28: hay **25 servicios `providedIn: 'root'` con estado cacheado** y este
   * método limpiaba **2** (permisos y alcance). Ir a buscar los otros 23 a mano deja el problema
   * abierto para el servicio número 26, que nadie va a acordarse de registrar — es el mismo
   * motivo por el que la guarda de la rueda se hizo listener global y no directiva. Una
   * navegación DURA destruye el inyector entero: los 25 y los que vengan, sin lista que mantener.
   *
   * `derribar` es del llamador porque no todo cierre de sesión es voluntario: el interceptor
   * llama acá ante un 401, y recargar ahí puede dejar un bucle. El borrado del rastro, en
   * cambio, corre **siempre**: un 401 por token vencido deja el mismo cache que un logout.
   */
  logout(opts: { derribar?: boolean } = {}): void {
    // `[SEG.3]` La decisión de borrar la base offline necesita saber QUIÉN se va, así que se
    // toma ANTES de vaciar `user`. Dos líneas más abajo ya no habría a quién preguntarle.
    const quienSeVa = this.user();

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

    // `[SEG.2]` El resto del rastro: localStorage de la persona, sessionStorage y —lo que más
    // importa— los caches de DATOS del service worker, que se llavean por URL y no miran quién
    // pregunta. Sin esto, `/api/users/**` y `/api/commercial/warehouses/**` se sirven hasta 24 h
    // con la respuesta que bajó la persona anterior, sin tocar la red.
    // `[SEG.3]` La base offline se borra para toda persona que NO sea de campo (decisión del
    // usuario). Guarda visitas, FOTOS de tienda, pings de GPS y conteos: en un equipo compartido
    // la siguiente persona los heredaba. Quien sí es de campo la conserva — es su trabajo.
    const limpieza = this.decidirYLimpiar(quienSeVa);

    if (opts.derribar && typeof window !== 'undefined') {
      // Se espera a que el borrado termine ANTES de recargar: si la navegación gana la carrera,
      // el `caches.delete()` queda a medias y el cache sobrevive — que es exactamente el defecto.
      limpieza
        .catch(() => undefined)
        .then(() => window.location.assign('/login'));
    }
  }

  /**
   * `[SEG.3]` Cuenta lo pendiente, decide, y limpia. Separado de `logout()` porque es `async` y
   * el cierre de sesión no puede esperar a una base de datos para vaciar los signals.
   *
   * ⚠️ `OfflineDatabaseService` se resuelve **perezosamente** por el inyector: pedirlo como
   * dependencia de `AuthService` abriría la base offline en cada arranque, también para las
   * personas de oficina que nunca la usan.
   *
   * ⛔ `[BND.1]` Eso evitaba INSTANCIARLA y NO evitaba EMPAQUETARLA: mientras el archivo tuviera
   * un `import` normal arriba, el bundler metía Dexie en el `main` igual — 94.7 KB medidos, para
   * todo el mundo, en el arranque. Son dos problemas distintos y el comentario original sólo
   * resolvía uno. Por eso acá va un `await import()` de verdad: la clase llega cuando se cierra
   * sesión, que es el único momento en que hace falta.
   */
  private async decidirYLimpiar(quienSeVa: JwtPayload | null): Promise<RastroLimpiado> {
    let pendientes: number | null = null;
    let db: OfflineDatabaseService | null = null;
    try {
      const mod = await import('./offline-database.service');
      db = this.injector.get(mod.OfflineDatabaseService);
      const e = await db.getEstadisticasOffline();
      // Las MUERTAS también cuentan: que hayan agotado los reintentos no las vuelve basura,
      // las vuelve trabajo que alguien tiene que rescatar a mano.
      pendientes = (e.visitasPendientes ?? 0) + (e.visitasMuertas ?? 0);
    } catch {
      pendientes = null; // no se pudo contar ⇒ no se borra (ver `decidirBorradoOffline`)
    }

    const veredicto = decidirBorradoOffline(quienSeVa, pendientes);
    if (veredicto.borrar && db) {
      // Dexie deja la conexión ABIERTA y `deleteDatabase` se queda esperando: sin este cierre el
      // borrado sale `onblocked` y la base sobrevive al cierre de sesión.
      try { db.close(); } catch { /* ya estaba cerrada */ }
    }

    const r = await limpiarRastroDeSesion({ borrarIndexedDb: veredicto.borrar });
    r.declarado.push(`offline: ${veredicto.motivo}`);
    if (!veredicto.borrar && pendientes) {
      // Un rol que no es de campo dejando trabajo sin sincronizar es una sorpresa, no una
      // rutina: o su pantalla no debería capturar, o el rol tiene que entrar a la excepción.
      console.warn(`[SEG.3] ${pendientes} registro(s) sin sincronizar de alguien que no es de campo: la base offline NO se borró.`);
    }
    return r;
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
