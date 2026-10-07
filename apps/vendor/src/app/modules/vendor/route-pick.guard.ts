import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of, timeout } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { todayMx } from '../../core/utils/mx-date';
import { VendorService } from './vendor.service';

/**
 * `[VR.SUP.1]` Marca local de "hoy ya le pregunté qué ruta trabaja". Se pone cuando el
 * supervisor elige "Mi agenda normal" (esa elección no deja fila en el backend, así que
 * sin esta marca le volveríamos a preguntar en cada entrada a "Mi ruta").
 */
export function routePickAskedKey(userSub: string | undefined): string {
  return `vr-route-pick-asked:${userSub ?? 'anon'}:${todayMx()}`;
}

export function markRoutePickAsked(userSub: string | undefined): void {
  try {
    localStorage.setItem(routePickAskedKey(userSub), '1');
  } catch {
    /* modo privado / storage bloqueado: a lo sumo le vuelve a preguntar */
  }
}

function alreadyAsked(userSub: string | undefined): boolean {
  try {
    return localStorage.getItem(routePickAskedKey(userSub)) === '1';
  } catch {
    return false;
  }
}

/**
 * `[VR.SUP.1]` Antes de "Mi ruta": si el usuario es supervisor (tiene equipo), aún no
 * escogió ruta hoy y no dijo "mi agenda normal", lo manda a escoger.
 *
 * Nunca bloquea al vendedor: sin red, error o lento (>4 s) → deja pasar a "Mi ruta".
 * Un supervisor que no pueda cargar las opciones trabaja su agenda como siempre.
 */
export const routePickGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const api = inject(VendorService);
  const sub = auth.user()?.sub;

  if (alreadyAsked(sub)) return true;

  return api.dayPickState().pipe(
    timeout(4000),
    map((s) => (s.can_pick && !s.current ? router.createUrlTree(['/vendor/route-pick']) : true)),
    catchError(() => of(true)),
  );
};
