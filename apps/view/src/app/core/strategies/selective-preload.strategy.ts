import { Injectable, inject } from '@angular/core';
import { PreloadingStrategy, Route } from '@angular/router';
import { Observable, of } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { Permission } from '../constants/permissions';

/**
 * Precarga los chunks lazy solo para usuarios con dashboard completo
 * (reportes de equipo/global). Un colaborador, que solo accede a captura
 * diaria, no descarga comercial/logística/admin/etc en segundo plano:
 * esas rutas siguen cargando bajo demanda si alguna vez navega a ellas.
 */
@Injectable({ providedIn: 'root' })
export class SelectivePreloadStrategy implements PreloadingStrategy {
  private auth = inject(AuthService);

  preload(_route: Route, load: () => Observable<unknown>): Observable<unknown> {
    const perms = this.auth.user()?.permissions;
    const full =
      perms?.[Permission.REPORTES_VER_EQUIPO] === true ||
      perms?.[Permission.REPORTES_VER_GLOBAL] === true;
    return full ? load() : of(null);
  }
}
