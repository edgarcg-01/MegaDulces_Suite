import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { PermissionsService } from '../../core/services/permissions.service';
import { AuthService } from '../../core/services/auth.service';
import { GastosAreaShellComponent } from './gastos-area-shell.component';
import { BuscadorGastosEstado } from './components/buscador-gastos.estado';

/**
 * `[GX.88]` / `[GX.101]` **El estado del buscador de gastos vive en el shell; la caja, en cada pantalla.**
 *
 * `[GX.88]` puso el buscador UNA vez arriba de las pestañas. `[GX.101]` (pedido del usuario,
 * 2026-11-06: «a uno más visible») movió la caja junto al título de cada pantalla. Lo que se cuida
 * aquí: que el shell ya no pinte una segunda caja arriba, y que siga dando UN estado a todas las
 * pantallas — así lo escrito se conserva al cambiar de pestaña.
 */
@Component({ standalone: true, template: '<p>pantalla</p>' })
class PantallaDePrueba {
  readonly estado = inject(BuscadorGastosEstado, { optional: true });
}

describe('[GX.101] GastosAreaShellComponent · el estado del buscador', () => {
  async function montar(url: string) {
    TestBed.configureTestingModule({
      imports: [GastosAreaShellComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        provideRouter([
          { path: 'finanzas/aprobacion-gastos', component: PantallaDePrueba },
          { path: 'finanzas/mis-gastos', component: PantallaDePrueba },
        ]),
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => true } },
        { provide: AuthService, useValue: { user: () => ({ permissions: { FINANCE_EXPENSES_COMPROBAR: true } }) } },
      ],
    });
    const fix = TestBed.createComponent(GastosAreaShellComponent);
    await TestBed.inject(Router).navigateByUrl(url);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix;
  }

  // La barra de pestañas lleva la activa a la vista con `scrollIntoView`, que jsdom no trae.
  beforeAll(() => { if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined; });
  afterEach(() => TestBed.resetTestingModule());

  /** ⛔ Una sola caja: la de la pantalla. Arriba de las pestañas ya no va. */
  it('⛔ el shell ya no pinta el buscador arriba de las pestañas', async () => {
    const fix = await montar('/finanzas/aprobacion-gastos');
    expect((fix.nativeElement as HTMLElement).querySelector('app-buscador-gastos')).toBeNull();
    expect((fix.nativeElement as HTMLElement).querySelector('.gx-area-buscador')).toBeNull();
  });

  it('da el estado a la pantalla de la pestaña', async () => {
    const fix = await montar('/finanzas/aprobacion-gastos');
    expect(fix.debugElement.injector.get(BuscadorGastosEstado)).toBeTruthy();
  });

  /** ⭐ Lo escrito se conserva al cambiar de pestaña: las dos pantallas leen el MISMO estado. */
  it('⭐ el estado es UNO para todas las pestañas', async () => {
    const fix = await montar('/finanzas/aprobacion-gastos');
    const estado = fix.debugElement.injector.get(BuscadorGastosEstado);
    estado.busqueda.set('papeleria');
    await TestBed.inject(Router).navigateByUrl('/finanzas/mis-gastos');
    fix.detectChanges();
    expect(fix.debugElement.injector.get(BuscadorGastosEstado).busqueda()).toBe('papeleria');
  });
});
