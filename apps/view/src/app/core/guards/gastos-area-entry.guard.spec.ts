import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { PermissionsService } from '../services/permissions.service';
import { Permission } from '../constants/permissions';
import { gastosAreaEntryGuard } from './permission.guard';

/**
 * `[GX.83]` La tarjeta «Gastos» de «Mi trabajo» y la entrada a Finanzas llevaban a capturar un
 * folio. Ahora llevan a `/finanzas/gastos-inicio`, que manda a la PRIMERA pestaña que la persona ve.
 */
function correr(permisos: Permission[], admin = false): string {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { isAuthenticated: true } },
      { provide: PermissionsService, useValue: { has: (p: Permission) => admin || permisos.includes(p), isAdmin: () => admin } },
    ],
  });
  const r = TestBed.runInInjectionContext(() =>
    gastosAreaEntryGuard({} as ActivatedRouteSnapshot, { url: '/finanzas/gastos-inicio' } as RouterStateSnapshot));
  const router = TestBed.inject(Router);
  return r instanceof UrlTree ? router.serializeUrl(r).split('?')[0] : String(r);
}

describe('[GX.83] gastosAreaEntryGuard', () => {
  it('quien firma entra a Aprobación', () => {
    expect(correr([Permission.FINANCE_EXPENSES_COMPROBAR])).toBe('/finanzas/aprobacion-gastos');
  });
  it('⭐ quien sólo captura entra a Mis gastos, no a capturar un folio', () => {
    expect(correr([Permission.FINANCE_EXPENSES_CAPTURAR])).toBe('/finanzas/mis-gastos');
  });
  it('con sólo la llave del historial de todos, al Historial', () => {
    expect(correr([Permission.FINANCE_EXPENSES_HISTORIAL_TODOS])).toBe('/finanzas/gastos-historial');
  });
  /** ⛔ Prueba negativa: sin ninguna pestaña no se le abre nada. */
  it('⛔ sin permisos de gastos se niega (no cae en ninguna pantalla de gastos)', () => {
    const r = correr([Permission.FINANCE_BANK_VER]);
    expect(r).not.toMatch(/^\/finanzas\/(aprobacion-gastos|mis-gastos|expediente|gastos-historial|gastos)$/);
  });
});
