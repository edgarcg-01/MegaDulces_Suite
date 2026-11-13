import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/** Quien tiene esto ve la pantalla de Asistencia (y por lo tanto, todo lo que vive dentro de ella). */
export const VER_ASISTENCIA: Permission[] = [Permission.HR_ATTENDANCE_VER, Permission.HR_ATTENDANCE_GESTIONAR];

/**
 * Fase RH · `[RH.13.5]` — Asistencia es UNA pantalla: checadas, faltas, tolerancia, incidencias y relojes viven en
 * `/rh/asistencia` (las dos últimas en su panel lateral). Las rutas viejas siguen existiendo para que ningún enlace
 * guardado, aviso ni marcador se rompa: llevan a la pantalla con lo mismo abierto y SIN perder lo que traían en la URL
 * (`nueva`, `site`, `persona`, `desde`…).
 *
 * `soloSiVe`: la ruta vieja se respeta para quien NO ve Asistencia. Medido en `MATRIZ_ACCESOS` (prod): Contabilidad
 * entra a «Incidencias y cierre semanal» sin permiso de Asistencia (audita lo cerrado). Mandarla a `/rh/asistencia`
 * la rebotaría; para ella la página de siempre sigue siendo su puerta.
 *
 * Va DESPUÉS del guard de permisos de la ruta: quien no tiene acceso a la página vieja sigue rebotando igual que antes.
 */
export function aLaPantallaUnica(abrir: Record<string, string>, soloSiVe = false): CanActivateFn {
  return (route) => {
    if (soloSiVe && !inject(PermissionsService).hasAny(...VER_ASISTENCIA)) return true;
    return inject(Router).createUrlTree(['/rh/asistencia'], { queryParams: { ...route.queryParams, ...abrir } });
  };
}
