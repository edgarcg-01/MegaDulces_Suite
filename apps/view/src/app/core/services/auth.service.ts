import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { tap } from 'rxjs/operators';
import { Observable } from 'rxjs';
import { JwtPayload, LoginResponse } from '@shared-models';


@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = environment.apiUrl;

  // Estado central usando Signals
  public token = signal<string | null>(null);
  public user = signal<JwtPayload | null>(null);

  constructor(private http: HttpClient) {
    this.restoreSessionFromCookie();
  }

  private restoreSessionFromCookie() {
    const tokenMatch = document.cookie.match(/(^|;)\s*auth_token\s*=\s*([^;]+)/);
    if (tokenMatch && tokenMatch[2]) {
      this.setSession(tokenMatch[2], false); // false para no volver a escribir la cookie
    }
  }

  public get isAuthenticated(): boolean {
    return !!this.token();
  }

  login(credentials: { username: string; password: string }): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/auth/login`, credentials).pipe(
      tap(response => {
        this.setSession(response.access_token);
      })
    );
  }

  logout(): void {
    this.token.set(null);
    this.user.set(null);
    document.cookie = "auth_token=; max-age=0; path=/; SameSite=Lax;";
  }

  private setSession(token: string, writeCookie: boolean = true): void {
    try {
      // Decode simple payload to keep info in memory
      const payloadBase64 = token.split('.')[1];
      const decodedJson = atob(payloadBase64);
      const payload: JwtPayload = JSON.parse(decodedJson);
      
      this.token.set(token);
      this.user.set(payload);

      if (writeCookie) {
        // 12 hours = 43200 seconds
        document.cookie = `auth_token=${token}; max-age=43200; path=/; SameSite=Lax;`;
      }
    } catch (error) {
      console.error('Invalid token format', error);
      this.logout();
    }
  }
}
