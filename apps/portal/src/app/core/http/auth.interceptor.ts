import { HttpInterceptorFn, HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { Router } from '@angular/router';
import { catchError, retry } from 'rxjs/operators';
import { throwError, timer } from 'rxjs';
import { TelemetryService } from '../telemetry/telemetry.service';

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 300;

/**
 * ¿Vale la pena reintentar este error? (E3)
 * Solo GET (idempotente) ante fallos transitorios: sin red (status 0), timeout
 * (408), rate-limit (429) o 5xx. NUNCA reintentamos POST/PATCH/DELETE para no
 * duplicar órdenes — misma política que `proxy_next_upstream` en nginx.
 */
function isRetryable(req: HttpRequest<unknown>, error: unknown): boolean {
  if (req.method !== 'GET') return false;
  if (!(error instanceof HttpErrorResponse)) return false;
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const telemetry = inject(TelemetryService);

  // Skip open routes: legacy /auth/login + multi-tenant /auth-mt/login.
  // Sin esto, un 401 en /auth-mt/login (credenciales incorrectas en portal) gatillaría
  // el redirect global a /login y el usuario nunca vería el error inline.
  if (req.url.includes('/auth/login') || req.url.includes('/auth-mt/login')) {
    return next(req);
  }

  const token = authService.token();
  let modifiedReq = req;

  if (token) {
    modifiedReq = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  return next(modifiedReq).pipe(
    // Retry con backoff exponencial (300ms, 900ms) solo para GET transitorios.
    retry({
      count: MAX_RETRIES,
      delay: (error, retryCount) => {
        if (!isRetryable(modifiedReq, error)) return throwError(() => error);
        return timer(BASE_DELAY_MS * Math.pow(3, retryCount - 1));
      },
    }),
    catchError((error: HttpErrorResponse) => {
      // Toda falla http (tras agotar reintentos) va a telemetría — antes morían
      // en consola y nadie medía la tasa de error real del portal.
      telemetry.trackError('http_error', {
        status: error.status,
        method: modifiedReq.method,
        url: modifiedReq.url.replace(/\/[0-9a-f-]{8,}/gi, '/:id'), // sin IDs/PII
      });

      // 401 → logout + redirect. Respeta el contexto: si el user está en /portal/*
      // mandalo a /portal/login (no al admin /login que lo confunde).
      if (error.status === 401) {
        authService.logout();
        const onPortal = router.url.startsWith('/portal');
        const onVendor = router.url.startsWith('/vendor');
        const target = onPortal ? '/portal/login' : onVendor ? '/login' : '/login';
        router.navigateByUrl(target);
      }
      return throwError(() => error);
    }),
  );
};
