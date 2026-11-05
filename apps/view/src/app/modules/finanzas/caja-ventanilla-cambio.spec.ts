import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import type { Route } from '@angular/router';
import { routes, trabajaEnVentanilla } from '../../app.routes';
import { CajaTabsComponent } from './caja-tabs.component';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * ⭐ `[LE.6.9]` **El cambio de Captura a Ventanilla es UNA clave, y cada persona ve un solo sistema (D34).**
 *
 * Edgar, 2026-11-04: *«me dijiste que tu trabajo ya está al 100% y ni la interfaz tienes»*. La
 * Ventanilla estaba construida y probada, pero ninguna ruta la abría. Estas pruebas clavan la puerta:
 * con `FINANCE_CAJA_VENTANILLA`, `/finanzas/caja-general` abre la Ventanilla y la pestaña lo dice;
 * sin ella, la misma ruta sigue en Captura.
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-11-04): quitando `canMatch` de la ruta de la Ventanilla se pone
 * roja la 1; invirtiendo el orden de las dos rutas, la 1; anulando el `has()` de `trabajaEnVentanilla`,
 * la 2. La 4 es el control: queda verde siempre.
 */
const deCaja = (): Route[] => {
  const hallar = (rs: Route[] | undefined): Route[] =>
    (rs ?? []).flatMap((r) => [...(r.path === 'caja-general' ? [r] : []), ...hallar(r.children)]);
  return hallar(routes);
};

const conClave = (tiene: boolean, admin = false) => {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: PermissionsService, useValue: { has: (p: Permission) => admin || (tiene && p === Permission.FINANCE_CAJA_VENTANILLA), isAdmin: () => admin } },
      { provide: AuthService, useValue: { user: signal({ permissions: { FINANCE_CAJA_VER: true, FINANCE_CAJA_GESTIONAR: true, FINANCE_CAJA_VENTANILLA: tiene } }) } },
    ],
  });
};

describe('[LE.6.9] la Ventanilla toma Caja General por clave', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('1 · hay DOS rutas `caja-general`: primero la Ventanilla con canMatch, después Captura sin él', async () => {
    const [ventanilla, captura, ...otras] = deCaja();
    expect(otras).toHaveLength(0);
    expect(ventanilla.canMatch).toEqual([trabajaEnVentanilla]);
    expect(((await ventanilla.loadComponent!()) as { name: string }).name).toBe('FinanzasCajaVentanillaComponent');
    expect(captura.canMatch).toBeUndefined();
    expect(((await captura.loadComponent!()) as { name: string }).name).toBe('FinanzasCajaGeneralComponent');
    // Las dos piden lo mismo para entrar: la clave del cambio no da acceso por sí sola.
    expect(ventanilla.canActivate).toHaveLength(1);
    expect(captura.canActivate).toHaveLength(1);
  });

  it('2 · la puerta de la Ventanilla coincide sólo con la clave', () => {
    conClave(true);
    expect(TestBed.runInInjectionContext(() => trabajaEnVentanilla({} as Route, []))).toBe(true);
    TestBed.resetTestingModule();
    conClave(false);
    expect(TestBed.runInInjectionContext(() => trabajaEnVentanilla({} as Route, []))).toBe(false);
  });

  it('3 · con la clave, la primera pestaña dice «Ventanilla» (no «Captura», que ya no es lo que abre)', () => {
    conClave(true);
    const tabs = TestBed.createComponent(CajaTabsComponent).componentInstance.tabs;
    expect(tabs[0]).toMatchObject({ label: 'Ventanilla', route: '/finanzas/caja-general' });
    expect(tabs.map((t) => t.label)).not.toContain('Captura');
  });

  it('4 · sin la clave, todo sigue como hoy: Captura', () => {
    conClave(false);
    const tabs = TestBed.createComponent(CajaTabsComponent).componentInstance.tabs;
    expect(tabs[0]).toMatchObject({ label: 'Captura', route: '/finanzas/caja-general' });
  });
});
