import { inject } from '@angular/core';
import { Router, type CanActivateFn, type RedirectFunction } from '@angular/router';

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
