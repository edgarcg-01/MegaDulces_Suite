import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { Router } from '@angular/router';
import { catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);

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
        Authorization: `Bearer ${token}`
      }
    });
  }

  return next(modifiedReq).pipe(
    catchError((error: HttpErrorResponse) => {
      // 401 → logout + redirect al login.
      if (error.status === 401) {
        authService.logout();
        router.navigateByUrl('/login');
      }
      return throwError(() => error);
    })
  );
};
