import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { Permission } from '../constants/permissions';
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
  rules?: any[];
  exp: number;
  iat: number;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

const STORAGE_KEY = 'auth_token';

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
  ) {
    this.restoreSession();
  }

  private restoreSession() {
    // El JWT con `rules` CASL embebidas supera los 4 KB que un cookie soporta
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
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
    // Limpiar cookie legacy si quedó alguno
    if (typeof document !== 'undefined') {
      document.cookie = 'auth_token=; max-age=0; path=/; SameSite=Lax;';
    }
  }

  private setSession(token: string, persist: boolean = true): void {
    try {
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64)) as JwtPayload & { rol?: string; role_name?: string; permissions?: Record<string, boolean>; rules?: any[] };

      payload.role_name = payload.rol || payload.role_name;

      this.token.set(token);
      this.user.set(payload);

      if (payload.rules) {
        this.perms.loadRules(payload.rules);
      }

      if (persist) {
        try { localStorage.setItem(STORAGE_KEY, token); } catch { /* quota / privacy mode */ }
      }
    } catch (error) {
      console.error('Invalid token format', error);
      this.logout();
    }
  }
}
