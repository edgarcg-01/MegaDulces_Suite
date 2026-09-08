import { inject } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * Redirect condicional de `/tienda`: los que tienen el monitor en vivo caen en `/tienda/live`;
 * las CAJERAS (solo arqueo) en `/tienda/arqueo`; los que solo tienen etiquetas (ej. rol
 * `etiquetas_tienda`) en `/tienda/etiquetas`. Sin el caso de arqueo, la cajera caía en
 * `etiquetas` cuyo guard la rebotaba a `/dashboard/captures`.
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
  const god = perms.isAdmin();
  if (god || legacy?.[Permission.STORE_LIVE_VER] === true) return 'live';
  if (legacy?.[Permission.STORE_ARQUEO_VER] === true || legacy?.[Permission.STORE_ARQUEO_CAPTURAR] === true) return 'arqueo';
  // Etiquetas primero para no cambiarle el destino a nadie que ya lo tenía.
  if (legacy?.[Permission.STORE_LABELS_VER] === true) return 'etiquetas';
  // Colaborador de caducidades (2026-09-08): su único permiso de tienda es
  // CAPTURAR, así que caía en `etiquetas` y el guard de esa ruta lo rebotaba a
  // `/dashboard/captures` — el mismo síntoma que ya había tenido la cajera.
  if (legacy?.[Permission.COMMERCIAL_EXPIRY_CAPTURAR] === true || legacy?.[Permission.COMMERCIAL_EXPIRY_VER] === true) return 'caducidades';
  return 'etiquetas';
};
