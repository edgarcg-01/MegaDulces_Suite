import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { permisos } from '../../../testing/rh.fixture';
import { aLaPantallaUnica } from './rh-una-pantalla.guard';

/**
 * `[RH.13.5]` Las rutas viejas de Asistencia (Tolerancia, Faltas, Incidencias, Relojes) llevan a la pantalla única con lo
 * mismo abierto. Lo que se defiende: ningún enlace guardado se rompe, no se pierde lo que traía la URL, y quien NO ve
 * Asistencia (Contabilidad con Incidencias, medido en MATRIZ_ACCESOS) se queda en su página en vez de rebotar.
 */
describe('[RH.13.5] aLaPantallaUnica', () => {
  function correr(claves: string[], abrir: Record<string, string>, soloSiVe: boolean, query: Record<string, string> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: PermissionsService, useValue: permisos(...claves) }] });
    const r = TestBed.runInInjectionContext(() =>
      aLaPantallaUnica(abrir, soloSiVe)({ queryParams: query } as unknown as ActivatedRouteSnapshot, {} as RouterStateSnapshot));
    return r instanceof UrlTree ? TestBed.inject(Router).serializeUrl(r) : r;
  }

  it('⭐ /rh/incidencias con la captura puesta → Asistencia con el panel abierto y la captura intacta', () => {
    expect(correr([Permission.HR_ATTENDANCE_VER], { panel: 'incidencias' }, true, { nueva: '1', site: 'PH', persona: '104' }))
      .toBe('/rh/asistencia?nueva=1&site=PH&persona=104&panel=incidencias');
  });

  it('⭐ /rh/asistencia/faltas → el modo Faltas de Checadas', () => {
    expect(correr([Permission.HR_ATTENDANCE_VER], { ver: 'faltas' }, false)).toBe('/rh/asistencia?ver=faltas');
  });

  it('⛔ NEGATIVA — quien NO ve Asistencia se queda en su página (no rebota)', () => {
    expect(correr([Permission.HR_INCIDENTS_AUDITAR], { panel: 'incidencias' }, true)).toBe(true);
    expect(correr([Permission.HR_DEVICES_GESTIONAR], { panel: 'relojes' }, true)).toBe(true);
  });

  it('quien gestiona Asistencia también llega a la pantalla única', () => {
    expect(correr([Permission.HR_ATTENDANCE_GESTIONAR], { panel: 'relojes' }, true)).toBe('/rh/asistencia?panel=relojes');
  });
});
