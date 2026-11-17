import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { aFilaDeSurtido, aSurtirPreventa, mesaSoloConPedido } from './almacen-pedidos.redirecciones';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

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

/**
 * `[GP.RF.32]` `/almacen/surtir-preventa` se retiró (decisión de Edgar, 2026-11-17). Quien surte llega a
 * Surtir con su `?pedido=`; quien sólo ve la preventa, al Tablero filtrado. Nadie cae en «sin acceso».
 */
@Component({ standalone: true, template: 'surtir' })
class Surtir {}

describe('[GP.RF.32] /almacen/surtir-preventa retirada', () => {
  async function ir(url: string, permisos: Record<string, boolean>): Promise<string> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'almacen/pedidos', component: Tablero },
          { path: 'almacen/surtir', component: Surtir },
          { path: 'almacen/surtir-preventa', redirectTo: aSurtirPreventa },
        ]),
      ],
    });
    TestBed.inject(PermissionsService).load(permisos, 'rol-de-prueba');
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    return TestBed.inject(Router).url;
  }

  it('⭐ quien surte llega a Surtir con el mismo pedido del aviso de la campana', async () => {
    expect(await ir('/almacen/surtir-preventa?pedido=o-1', { [Permission.COMMERCIAL_PICKING_GESTIONAR]: true })).toBe('/almacen/surtir?pedido=o-1');
  });

  it('sin pedido, quien surte llega a Surtir a secas', async () => {
    expect(await ir('/almacen/surtir-preventa', { [Permission.COMMERCIAL_PICKING_GESTIONAR]: true })).toBe('/almacen/surtir');
  });

  it('NEGATIVA: quien sólo VE la preventa no va a Surtir (lo rebotaría): va al Tablero filtrado', async () => {
    expect(await ir('/almacen/surtir-preventa?pedido=o-1', { [Permission.COMMERCIAL_PICKING_VER]: true, [Permission.ALMACEN_PEDIDOS_VER]: true }))
      .toBe('/almacen/pedidos?origen=PREVENTA');
  });
});
