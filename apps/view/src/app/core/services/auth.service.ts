import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { JwtPayload, LoginResponse } from '@shared-models';
import { Permission } from '../constants/permissions';

@Injectable({
  providedIn: 'root',
})
/**
 * Servicio de autenticación para gestionar sesiones de usuario,
 * tokens JWT y permisos.
 */
export class AuthService {
  private apiUrl = environment.apiUrl;

  // Estado central usando Signals
  /** Token de autenticación JWT */
  public token = signal<string | null>(null);
  /** Información del usuario actual */
  public user = signal<JwtPayload | null>(null);
  /** Permisos del usuario */
  public permissions = signal<Record<string, boolean>>({});

  constructor(private http: HttpClient) {
    this.restoreSessionFromCookie();
  }

  /**
   * Restaura la sesión desde la cookie del navegador
   */
  private restoreSessionFromCookie() {
    const tokenMatch = document.cookie.match(
      /(^|;)\s*auth_token\s*=\s*([^;]+)/,
    );
    if (tokenMatch && tokenMatch[2]) {
      this.setSession(tokenMatch[2], false); // false para no volver a escribir la cookie
    }
  }

  /**
   * Verifica si el usuario está autenticado
   * @returns true si hay un token de autenticación
   */
  public get isAuthenticated(): boolean {
    return !!this.token();
  }

  /**
   * Verifica si el usuario tiene un permiso específico
   * @param key Clave del permiso a verificar
   * @returns true si el usuario tiene el permiso o es superadmin
   */
  public hasPermission(key: Permission | string): boolean {
    const currentUser = this.user();

    if (currentUser && currentUser.role_name === 'superadmin') {
      return true;
    }

    return this.permissions()[key] === true;
  }

  /**
   * Inicia sesión con las credenciales proporcionadas
   * @param credentials Credenciales de usuario (username y password)
   * @returns Observable con la respuesta de login que incluye el token
   */
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
   * Cierra la sesión del usuario y limpia el estado
   */
  logout(): void {
    this.token.set(null);
    this.user.set(null);
    this.permissions.set({});
    document.cookie = 'auth_token=; max-age=0; path=/; SameSite=Lax;';
  }

  /**
   * Establece la sesión del usuario desde un token JWT
   * @param token Token JWT de autenticación
   * @param writeCookie Si es true, guarda el token en una cookie
   */
  private setSession(token: string, writeCookie: boolean = true): void {
    try {
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64)) as JwtPayload & { rol?: string; role_name?: string; permissions?: Record<string, boolean> };

      // Normalizamos el rol a una sola propiedad para facilitar el código
      payload.role_name = payload.rol || payload.role_name;

      this.token.set(token);
      this.user.set(payload);
      this.permissions.set(payload.permissions || {});

      if (writeCookie) {
        const d = new Date();
        d.setTime(d.getTime() + (1 * 24 * 60 * 60 * 1000));
        document.cookie = `auth_token=${token}; expires=${d.toUTCString()}; path=/; SameSite=Lax;`;
      }
    } catch (error) {
      console.error('Invalid token format', error);
      this.logout();
    }
  }
}
