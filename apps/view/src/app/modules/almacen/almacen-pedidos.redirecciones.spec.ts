import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { aFilaDeSurtido, mesaSoloConPedido } from './almacen-pedidos.redirecciones';

@Component({ standalone: true, template: 'tablero' })
class Tablero {}
@Component({ standalone: true, template: 'mesa' })
class Mesa {}

/**
 * `[GP.10.4c]` Las rutas de las dos pestañas que el Tablero absorbió llevan al Tablero con la vista o el
 * filtro puestos. Se prueban con el router real: la configuración es la misma que en `app.routes.ts`.
 */
describe('Redirecciones del Tablero de pedidos (GP.10.4c)', () => {
  async function ir(url: string): Promise<string> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'almacen/pedidos/preventa', component: Mesa, canActivate: [mesaSoloConPedido] },
          { path: 'almacen/pedidos', component: Tablero },
          { path: 'almacen/surtido-consola', redirectTo: aFilaDeSurtido },
        ]),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return TestBed.inject(Router).url;
  }

  it('⭐ la Consola de surtido lleva a la vista «Fila de surtido» del Tablero', async () => {
    expect(await ir('/almacen/surtido-consola')).toBe('/almacen/pedidos?vista=fila');
  });

  it('⭐ la Mesa sin pedido lleva al Tablero filtrado por preventa', async () => {
    expect(await ir('/almacen/pedidos/preventa')).toBe('/almacen/pedidos?origen=PREVENTA');
  });

  it('NEGATIVA: la Mesa con ?pedido se abre (es el detalle de un PD-)', async () => {
    expect(await ir('/almacen/pedidos/preventa?pedido=abc')).toBe('/almacen/pedidos/preventa?pedido=abc');
  });
});
