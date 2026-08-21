import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs/operators';

import { DiagnosticsRecorderService } from '../errors/diagnostics-recorder.service';

/**
 * Anota cada llamada a la API en la grabadora de diagnóstico.
 *
 * Se cierra en `tap` (respuesta o error) y NO en `finalize`: una petición cancelada
 * —porque el componente se destruyó o el usuario navegó— no debe figurar como terminada.
 * Lo que queda con `ms: null` es exactamente lo que buscamos: la que nunca respondió.
 *
 * Ignora el `/health` del propio diagnóstico: sería medir su propia sonda.
 */
export const diagnosticsInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.includes('/api/') || req.url.endsWith('/health')) return next(req);
  const rec = inject(DiagnosticsRecorderService);
  const done = rec.begin('req', `${req.method} ${req.url.replace(/^https?:\/\/[^/]+/, '')}`);
  return next(req).pipe(
    tap({
      next: (e) => { if (e instanceof HttpResponse) done(String(e.status)); },
      error: (e) => done(`error ${e?.status ?? ''}`.trim()),
    }),
  );
};
