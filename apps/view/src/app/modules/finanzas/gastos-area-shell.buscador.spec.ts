import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { PermissionsService } from '../../core/services/permissions.service';
import { AuthService } from '../../core/services/auth.service';
import { GastosAreaShellComponent, RUTAS_CON_BUSCADOR } from './gastos-area-shell.component';

/**
 * `[GX.88]` **El buscador de gastos va UNA vez, arriba de las pestañas** (pedido del usuario,
 * 2026-11-05): en Aprobación, Mis gastos, Expediente e Historial. NO en Comisiones de logística
 * ni en Hoja de zona, que viven en el mismo shell (Hoja de zona es de Caja General). Y sólo para
 * quien aprueba.
 */
@Component({ standalone: true, template: '<p>pantalla</p>' })
class PantallaDePrueba {}

describe('[GX.88] GastosAreaShellComponent · el buscador de arriba', () => {
  async function montar(url: string, comprobar: boolean) {
    TestBed.configureTestingModule({
      imports: [GastosAreaShellComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        provideRouter([
          { path: 'finanzas/aprobacion-gastos', component: PantallaDePrueba },
          { path: 'finanzas/mis-gastos', component: PantallaDePrueba },
          { path: 'finanzas/expediente', component: PantallaDePrueba },
          { path: 'finanzas/gastos-historial', component: PantallaDePrueba },
          { path: 'finanzas/hoja-gastos', component: PantallaDePrueba },
          { path: 'finanzas/comisiones-logistica', component: PantallaDePrueba },
        ]),
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => comprobar } },
        { provide: AuthService, useValue: { user: () => ({ permissions: comprobar ? { FINANCE_EXPENSES_COMPROBAR: true } : {} }) } },
      ],
    });
    const fix = TestBed.createComponent(GastosAreaShellComponent);
    await TestBed.inject(Router).navigateByUrl(url);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }
  const caja = (el: HTMLElement) => el.querySelector('.gx-area-buscador app-buscador-gastos input[type=search]');

  // La barra de pestañas lleva la activa a la vista con `scrollIntoView`, que jsdom no trae. Lo
  // hace en un temporizador que puede correr DESPUÉS de la prueba: por eso no se quita al final
  // (en jsdom no había nada que restaurar).
  beforeAll(() => { if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined; });
  afterEach(() => TestBed.resetTestingModule());

  it('son exactamente las cuatro pestañas pedidas', () => {
    expect([...RUTAS_CON_BUSCADOR].sort()).toEqual(
      ['/finanzas/aprobacion-gastos', '/finanzas/expediente', '/finanzas/gastos-historial', '/finanzas/mis-gastos']);
  });

  for (const url of ['/finanzas/aprobacion-gastos', '/finanzas/mis-gastos', '/finanzas/expediente', '/finanzas/gastos-historial']) {
    it(`quien aprueba lo ve en ${url}`, async () => {
      expect(caja(await montar(url, true))).not.toBeNull();
    });
  }

  it('con filtros en la URL también (se compara sin la query)', async () => {
    expect(caja(await montar('/finanzas/gastos-historial?mes=2026-10', true))).not.toBeNull();
  });

  /** ⛔ Hoja de zona es de Caja General y Comisiones es otro trámite: ahí no va. */
  for (const url of ['/finanzas/hoja-gastos', '/finanzas/comisiones-logistica']) {
    it(`⛔ no aparece en ${url}`, async () => {
      expect((await montar(url, true)).querySelector('.gx-area-buscador')).toBeNull();
    });
  }

  /** ⛔ Sin permiso de aprobar no hay caja (el servidor además da 403). */
  it('⛔ quien no aprueba no lo ve, ni en Mis gastos', async () => {
    expect(caja(await montar('/finanzas/mis-gastos', false))).toBeNull();
  });

  it('va ARRIBA de las pestañas', async () => {
    const el = await montar('/finanzas/aprobacion-gastos', true);
    const buscador = el.querySelector('.gx-area-buscador');
    const pestanas = el.querySelector('.gx-area-tabs');
    expect(buscador && pestanas).toBeTruthy();
    // El buscador viene ANTES que las pestañas en el documento.
    expect(buscador?.compareDocumentPosition(pestanas as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
