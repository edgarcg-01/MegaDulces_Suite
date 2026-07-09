import { inject } from '@angular/core';
import { CanMatchFn } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Redirect condicional de `/tienda`: los que tienen el monitor en vivo caen en `/tienda/live`;
 * los que solo tienen etiquetas (ej. rol `etiquetas_tienda`) caen en `/tienda/etiquetas`.
 * Se usa como CanMatchFn en la ruta de redirect a `live`: si NO matchea, el router prueba
 * la siguiente (redirect a `etiquetas`).
 */
export const storeLiveMatch: CanMatchFn = () => {
  const perms = inject(PermissionsService);
  const legacy = inject(AuthService).user()?.permissions;
  return perms.can('manage', 'all') || legacy?.[Permission.STORE_LIVE_VER] === true;
};
