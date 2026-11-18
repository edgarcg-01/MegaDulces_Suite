import { inject } from '@angular/core';
import { Router, type CanActivateFn, type RedirectFunction } from '@angular/router';
import { Permission } from '../../core/constants/permissions';
import { PermissionsService } from '../../core/services/permissions.service';

/**
 * `[GP.10.4c]` Las dos pantallas que el Tablero de pedidos absorbió (D1, D2) ya no tienen pestaña, y
 * sus rutas viejas llevan al Tablero con la vista o el filtro puestos: un marcador o un enlace viejo
 * (la bandeja de pendientes de sucursal, el árbol de permisos) sigue llegando a lo mismo.
 */

/** `/almacen/surtido-consola` → la vista «Fila de surtido» del Tablero (D2). */
export const aFilaDeSurtido: RedirectFunction = () =>
  inject(Router).createUrlTree(['/almacen/pedidos'], { queryParams: { vista: 'fila' } });

/**
 * `/almacen/pedidos/preventa` sin pedido → el Tablero filtrado por preventa (D1). Con `?pedido=<id>`
 * la Mesa de Control sí se abre: es el detalle de un `PD-` (documento de Kepler, cobro, recorrido) y
 * su lista sigue a la vista detrás del panel.
 */
export const mesaSoloConPedido: CanActivateFn = (route) =>
  route.queryParamMap.has('pedido') || inject(Router).createUrlTree(['/almacen/pedidos'], { queryParams: { origen: 'PREVENTA' } });

/**
 * `[GP.RF.32]` `/almacen/surtir-preventa` se retiró (decisión de Edgar, 2026-11-17): el surtidor surte la
 * preventa en Surtir › Sucursal, que ahora tiene todo lo que ella tenía (`[GP.RF.31]`, cambiar por otro
 * producto). En 30 días no tuvo ni una medición de uso.
 *
 * Quien surte llega a Surtir con el mismo `?pedido=` (el aviso de la campana sigue abriendo su pedido).
 * Quien sólo VE la preventa (coordinador de embarques, dirección, prevención: medido en prod el
 * 2026-11-17, los cuatro abren el Tablero) llega al Tablero filtrado por preventa, no a «sin acceso».
 */
export const aSurtirPreventa: RedirectFunction = ({ queryParams }) => {
  const router = inject(Router);
  if (inject(PermissionsService).has(Permission.COMMERCIAL_PICKING_GESTIONAR)) {
    const pedido = typeof queryParams['pedido'] === 'string' ? queryParams['pedido'] : null;
    return router.createUrlTree(['/almacen/surtir'], { queryParams: pedido ? { pedido } : {} });
  }
  return router.createUrlTree(['/almacen/pedidos'], { queryParams: { origen: 'PREVENTA' } });
};
