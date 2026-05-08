import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { PermissionsService } from './permissions.service';

export interface JwtPayload {
  sub: string;
  username: string;
  rol?: string;
  role_name?: string;
  zona?: string;
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
    this.restoreSessionFromCookie();
  }

  private restoreSessionFromCookie() {
    const tokenMatch = document.cookie.match(
      /(^|;)\s*auth_token\s*=\s*([^;]+)/,
    );
    if (tokenMatch && tokenMatch[2]) {
      this.setSession(tokenMatch[2], false);
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

  logout(): void {
    this.token.set(null);
    this.user.set(null);
    this.perms.clear();
    document.cookie = 'auth_token=; max-age=0; path=/; SameSite=Lax;';
  }

  private setSession(token: string, writeCookie: boolean = true): void {
    try {
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64)) as JwtPayload & { rol?: string; role_name?: string; permissions?: Record<string, boolean>; rules?: any[] };

      payload.role_name = payload.rol || payload.role_name;

      this.token.set(token);
      this.user.set(payload);

      if (payload.rules) {
        this.perms.loadRules(payload.rules);
      }

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
