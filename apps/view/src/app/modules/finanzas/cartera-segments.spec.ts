import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Component } from '@angular/core';
import { CarteraSegmentsComponent } from './cartera-segments.component';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * `[CXC.26]` El selector de vista de Crédito, con la tercera opción («Por día») puesta.
 *
 * ⛔ **Por qué existe este spec.** Al agregar `/finanzas/cartera/dia` apareció un defecto que en
 * pantalla se ve bien y miente: `actual()` resolvía con `find(url.startsWith(o.value))`, así que
 * estando en `/finanzas/cartera/dia` se encendía **«Por cliente»** — la primera opción, y
 * `/finanzas/cartera` es prefijo suyo. El control marcaba una pestaña que no era la abierta, que
 * es peor que no marcar ninguna: dice que estás en otro lado.
 *
 * Se prueba también el gateo: los segmentos NO comparten permiso (`FINANCE_RECEIVABLES_VER` vs
 * `FINANCE_COLLECTIONS_VER`) y un control que ofrezca la mitad que la persona no puede ver la
 * manda a un 403.
 */

@Component({ standalone: true, template: '' })
class Vacio {}

/** Dobles mínimos: acá se mide la lógica del control, no la sesión ni el mapa de permisos. */
function montar(permisos: Permission[], admin = false) {
  const mapa: Record<string, boolean> = {};
  for (const p of permisos) mapa[p] = true;

  TestBed.configureTestingModule({
    imports: [CarteraSegmentsComponent],
    providers: [
      provideRouter([
        { path: 'finanzas/cartera', component: Vacio },
        { path: 'finanzas/cartera/dia', component: Vacio },
        { path: 'finanzas/cobranza', component: Vacio },
        { path: 'finanzas/carteras', component: Vacio },
      ]),
      { provide: AuthService, useValue: { user: () => ({ permissions: mapa }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => admin } },
    ],
  });
  const fixture = TestBed.createComponent(CarteraSegmentsComponent);
  return { fixture, cmp: fixture.componentInstance, router: TestBed.inject(Router) };
}

const TODO = [Permission.FINANCE_RECEIVABLES_VER, Permission.FINANCE_COLLECTIONS_VER];

describe('[CXC.26] CarteraSegmentsComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('ofrece las tres vistas cuando la persona tiene los dos permisos', () => {
    const { cmp } = montar(TODO);
    expect(cmp.opciones().map((o) => o.value)).toEqual([
      '/finanzas/cartera', '/finanzas/cartera/dia', '/finanzas/cobranza',
    ]);
  });

  it('⛔ en /finanzas/cartera/dia marca «Por día», NO «Por cliente»', async () => {
    const { cmp, router } = montar(TODO);
    await router.navigateByUrl('/finanzas/cartera/dia');
    // El defecto original devolvía '/finanzas/cartera' acá.
    expect(cmp.actual()).toBe('/finanzas/cartera/dia');
  });

  it('en /finanzas/cartera marca «Por cliente»', async () => {
    const { cmp, router } = montar(TODO);
    await router.navigateByUrl('/finanzas/cartera');
    expect(cmp.actual()).toBe('/finanzas/cartera');
  });

  it('los query params y el fragmento no cambian qué segmento está marcado', async () => {
    const { cmp, router } = montar(TODO);
    await router.navigateByUrl('/finanzas/cartera/dia?cuenta=cliente_final#x');
    expect(cmp.actual()).toBe('/finanzas/cartera/dia');
  });

  it('⛔ una ruta que sólo COMPARTE PREFIJO no marca nada (el corte es por segmento)', async () => {
    const { cmp, router } = montar(TODO);
    await router.navigateByUrl('/finanzas/carteras');
    // Con `startsWith` pelado esto encendía «Por cliente».
    expect(cmp.actual()).toBe('');
  });

  it('con sólo el permiso de Cobranza no se ofrece ninguna vista de crédito', () => {
    const { cmp } = montar([Permission.FINANCE_COLLECTIONS_VER]);
    expect(cmp.opciones().map((o) => o.value)).toEqual(['/finanzas/cobranza']);
  });

  it('«Por día» viaja con «Por cliente»: mismo permiso, mismo dato', () => {
    const { cmp } = montar([Permission.FINANCE_RECEIVABLES_VER]);
    expect(cmp.opciones().map((o) => o.value)).toEqual(['/finanzas/cartera', '/finanzas/cartera/dia']);
  });

  it('el admin ve las tres aunque su mapa de permisos esté vacío', () => {
    const { cmp } = montar([], true);
    expect(cmp.opciones()).toHaveLength(3);
  });

  it('navegar al segmento ya activo no dispara una navegación', async () => {
    const { cmp, router } = montar(TODO);
    await router.navigateByUrl('/finanzas/cartera/dia');
    const espia = vi.spyOn(router, 'navigateByUrl');
    cmp.ir('/finanzas/cartera/dia');
    expect(espia).not.toHaveBeenCalled();
  });
});
