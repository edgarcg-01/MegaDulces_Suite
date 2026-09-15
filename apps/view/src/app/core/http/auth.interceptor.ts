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
  // GX.9 — la captura de gasto por link es PÚBLICA y se autoriza con el token de la URL.
  // Va acá por dos motivos, y los dos muerden:
  //   1. Si el celular arrastra un token viejo en localStorage, este interceptor lo pegaría
  //      en la petición; el `TenantContextInterceptor` del servidor sólo pasa de largo cuando
  //      NO hay header — con uno inválido tira 401. O sea: un token vencido que no le importa
  //      a nadie rompería una ruta pública.
  //   2. Ese 401 dispararía el logout + redirect de abajo, y el trabajador terminaría en un
  //      /login que no puede usar porque no tiene cuenta.
  if (req.url.includes('/auth/login') || req.url.includes('/auth-mt/login')
      || req.url.includes('/finance/captura')) {
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
      // 401 → se cayó la sesión. Antes esto era logout + /login MUDO: se veía
      // idéntico a cerrar sesión a propósito, sin decir que había expirado y
      // perdiendo dónde estabas. Ahora se lleva el motivo y la ruta de vuelta.
      if (error.status === 401) {
        const from = router.url;
        authService.logout();
        router.navigate(['/login'], {
          queryParams: {
            reason: 'expired',
            // No tiene sentido volver al propio login ni a una pantalla de error.
            returnUrl: from && !from.startsWith('/login') && !from.startsWith('/sin-acceso') ? from : null,
          },
        });
      }
      return throwError(() => error);
    })
  );
};
