import type { Router } from '@angular/router';
import { Permission } from '../../core/constants/permissions';
import type { PermissionsService } from '../../core/services/permissions.service';

/**
 * `[GP.RF.30]` A dónde lleva «Salir» en una pantalla de foco (Surtir, Checar).
 *
 * Antes iba fijo a `/almacen`, que no regresa a donde estabas: el área brinca a la primera pantalla
 * que el puesto puede abrir. Para superadmin es Inventario; para el surtidor es Surtir misma, así que
 * «Salir» no hacía nada. Lo encontró Edgar el 2026-11-17: *«este botón no sirve, te arroja al inicio
 * directo»*.
 *
 * Ahora regresa a la pantalla de donde se llegó. Hay tres casos en que no se regresa:
 * - se abrió directo o se recargó, y no hay de dónde;
 * - se llegó desde otra pantalla de foco: ir y volver entre ellas no es salir;
 * - la anterior era el login o «sin acceso».
 *
 * En esos casos va al Tablero si el puesto lo abre, y si no, a «Mi trabajo».
 */
export const TABLERO = '/almacen/pedidos';
export const MI_TRABAJO = '/projects';

/** Los permisos con que se abre el Tablero: los mismos de su ruta en `app.routes.ts`. */
export const PERMISOS_TABLERO: readonly Permission[] = [
  Permission.ALMACEN_PEDIDOS_VER,
  Permission.COMMERCIAL_PICKING_GESTIONAR,
  Permission.ALMACEN_SURTIDO_COORDINAR,
];

/** Pantallas de foco del surtido: regresar a una de ellas no es salir. */
const DE_FOCO = /^\/almacen\/(surtir|checar|clientes-nuevos)(\/|$)/;
/** De donde no tiene sentido regresar. */
const SIN_SENTIDO = /^\/(login|sin-acceso)?(\/|$)/;

export function destinoDeSalida(previa: string | null, puedeTablero: boolean): string {
  // La ruta sin consulta, fragmento ni panel lateral: con ellos se compara, pero se regresa completa.
  const ruta = (previa ?? '').split(/[?#(]/)[0];
  if (previa && ruta && !DE_FOCO.test(ruta) && !SIN_SENTIDO.test(ruta)) return previa;
  return puedeTablero ? TABLERO : MI_TRABAJO;
}

export function puedeAbrirTablero(perms: Pick<PermissionsService, 'hasAny'>): boolean {
  return perms.hasAny(...PERMISOS_TABLERO);
}

/**
 * La dirección de donde se llegó. Se lee al CREAR la pantalla: la navegación que la está abriendo
 * todavía está en curso y trae la anterior. Después ya no se puede saber.
 */
export function urlPrevia(router: Router): string | null {
  const t = router.currentNavigation()?.previousNavigation?.finalUrl;
  return t ? router.serializeUrl(t) : null;
}
