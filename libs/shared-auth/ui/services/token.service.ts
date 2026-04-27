import { Injectable } from '@angular/core';
import { JwtPayload } from '../../core/interfaces';

@Injectable({
  providedIn: 'root',
})
export class TokenService {
  decodeToken(token: string): JwtPayload | null {
    try {
      const payloadBase64 = token.split('.')[1];
      const payload = JSON.parse(atob(payloadBase64)) as JwtPayload;
      return payload;
    } catch {
      return null;
    }
  }

  isTokenExpired(token: string): boolean {
    const payload = this.decodeToken(token);
    if (!payload) return true;
    
    const now = Date.now() / 1000;
    return payload.exp < now;
  }
}
