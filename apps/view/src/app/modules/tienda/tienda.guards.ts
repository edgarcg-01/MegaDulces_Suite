import { inject } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Redirect condicional de `/tienda`: los que tienen el monitor en vivo caen en `/tienda/live`;
 * los que solo tienen etiquetas (ej. rol `etiquetas_tienda`) caen en `/tienda/etiquetas`.
 *
 * `redirectTo` funcional (Angular 18) en UNA sola ruta de path vacío. Reemplaza al patrón
 * anterior de DOS rutas `path:''` — una con `canMatch:[storeLiveMatch]` → `live` y otra de
 * fallback → `etiquetas` — que en cold-start rebotaba a `/dashboard/captures`: cuando el
 * usuario solo tenía etiquetas, el `canMatch` fallaba y el fall-through al 2º redirect no
 * resolvía de forma fiable (el guard de `etiquetas` corría en un estado intermedio). Con un
 * único redirect determinista se elige el destino en la fase de recognize y se enруta directo.
 */
export const storeEntryRedirect = (): string => {
  const perms = inject(PermissionsService);
  const legacy = inject(AuthService).user()?.permissions;
  const canLive = perms.can('manage', 'all') || legacy?.[Permission.STORE_LIVE_VER] === true;
  return canLive ? 'live' : 'etiquetas';
};
