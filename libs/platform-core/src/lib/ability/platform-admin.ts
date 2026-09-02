/**
 * God-mode de plataforma.
 *
 * Es lo único que sobrevivió de `ability.factory.ts` (la construcción de abilities de CASL, retirada
 * 2026-09-02). El resto de la autorización se resuelve por CLAVE EXACTA del permiso contra el mapa
 * `role_permissions` — en `RolesGuard` del lado del servidor y en `PermissionsService` del lado de
 * la UI.
 *
 * Por qué el god-mode es por ROL y no por un permiso de negocio: antes se derivaba de
 * `REPORTES_VER_GLOBAL`, y marcar "ver reportes globales" en un rol custom lo volvía superadmin de
 * facto. Bonus: admin/superadmin siguen pasando aunque a su JSONB en prod le falte una clave recién
 * agregada al enum, lo que evita el 403 por drift del seed hasta el backfill.
 *
 * Este listado se espeja en los 3 frontends (`PermissionsService.isAdmin`). Si cambia acá, cambia allá.
 */
const PLATFORM_ADMIN_ROLES = new Set(['superadmin', 'admin']);

export function isPlatformAdminRole(roleName?: string | null): boolean {
  return !!roleName && PLATFORM_ADMIN_ROLES.has(roleName.toLowerCase());
}
