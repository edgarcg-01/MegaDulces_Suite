import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { MI_TRABAJO, TABLERO, destinoDeSalida, urlPrevia } from './salida-de-foco';

/**
 * `[GP.RF.30]` «Salir» de Surtir y Checar regresa a donde se llegó. Lo encontró Edgar en prod
 * (2026-11-17): iba fijo a `/almacen`, que brinca a la primera pantalla del área.
 */
describe('[GP.RF.30] destinoDeSalida', () => {
  it('⭐ regresa a la pantalla de donde se llegó, con su consulta', () => {
    expect(destinoDeSalida('/almacen/pedidos?vista=fila', true)).toBe('/almacen/pedidos?vista=fila');
    expect(destinoDeSalida('/almacen/anden', false)).toBe('/almacen/anden');
  });

  it('conserva el panel lateral de la dirección anterior', () => {
    expect(destinoDeSalida('/almacen/pedidos(panel:chat)', true)).toBe('/almacen/pedidos(panel:chat)');
  });

  it('sin pantalla anterior: al Tablero si lo abre, si no a «Mi trabajo» (no a «sin acceso»)', () => {
    expect(destinoDeSalida(null, true)).toBe(TABLERO);
    expect(destinoDeSalida(null, false)).toBe(MI_TRABAJO);
  });

  it('NEGATIVA: desde otra pantalla de foco no se regresa (sería ida y vuelta)', () => {
    for (const p of ['/almacen/surtir', '/almacen/surtir/ruta/abc', '/almacen/checar', '/almacen/clientes-nuevos?x=1']) {
      expect(destinoDeSalida(p, true), p).toBe(TABLERO);
    }
  });

  it('NEGATIVA: del login, «sin acceso» o la raíz tampoco', () => {
    for (const p of ['/login', '/sin-acceso?from=x', '/']) expect(destinoDeSalida(p, true), p).toBe(TABLERO);
  });

  it('NEGATIVA: una ruta que sólo se parece a una de foco sí es pantalla anterior', () => {
    expect(destinoDeSalida('/almacen/surtido-consola', true)).toBe('/almacen/surtido-consola');
  });
});

/** El supuesto del que depende todo: al CREAR la pantalla todavía se sabe de dónde se llegó. */
@Component({ standalone: true, template: 'foco' })
class FocoComponent {
  readonly previa = urlPrevia(inject(Router));
}
@Component({ standalone: true, template: 'otra' })
class OtraComponent {}

describe('[GP.RF.30] urlPrevia con un router de verdad', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'almacen/pedidos', component: OtraComponent }, { path: 'almacen/surtir', component: FocoComponent }])],
    });
  });

  it('⭐ llegar desde el Tablero: la pantalla de foco sabe que vino de ahí', async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/almacen/pedidos?vista=fila');
    const foco = await h.navigateByUrl('/almacen/surtir', FocoComponent);
    expect(foco.previa).toBe('/almacen/pedidos?vista=fila');
  });

  it('NEGATIVA: abierta directo no inventa de dónde vino', async () => {
    const h = await RouterTestingHarness.create();
    const foco = await h.navigateByUrl('/almacen/surtir', FocoComponent);
    expect(foco.previa).toBeNull();
  });
});
