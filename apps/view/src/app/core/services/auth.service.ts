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
export class AuthService {
  private apiUrl = environment.apiUrl;

  // Estado central usando Signals
  public token = signal<string | null>(null);
  public user = signal<JwtPayload | null>(null);
  public permissions = signal<Record<string, boolean>>({});

  constructor(private http: HttpClient) {
    this.restoreSessionFromCookie();
  }

  private restoreSessionFromCookie() {
    const tokenMatch = document.cookie.match(
      /(^|;)\s*auth_token\s*=\s*([^;]+)/,
    );
    if (tokenMatch && tokenMatch[2]) {
      this.setSession(tokenMatch[2], false); // false para no volver a escribir la cookie
    }
  }

  public get isAuthenticated(): boolean {
    return !!this.token();
  }

  public hasPermission(key: Permission | string): boolean {
    const currentUser = this.user() as any;

    if (currentUser && currentUser['role_name'] === 'superadmin') {
      return true;
    }

    return this.permissions()[key] === true;
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
        })
      );
  }

  logout(): void {
    this.token.set(null);
    this.user.set(null);
    this.permissions.set({});
    document.cookie = 'auth_token=; max-age=0; path=/; SameSite=Lax;';
  }

  private setSession(token: string, writeCookie: boolean = true): void {
    try {
      const payloadBase64 = token.split('.')[1];
      const payload: any = JSON.parse(atob(payloadBase64));

      // Normalizamos el rol a una sola propiedad para facilitar el código
      payload.role_name = payload.rol || payload.role_name;

      this.token.set(token);
      this.user.set(payload);
      this.permissions.set(payload.permissions || {});
    } catch (error) {
      console.error('Invalid token format', error);
      this.logout();
    }
  }
}
