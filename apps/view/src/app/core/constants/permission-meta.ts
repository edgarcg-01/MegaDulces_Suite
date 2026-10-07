/**
 * `[ID.28]` — Re-export. La definición vive en `@megadulces/contracts`.
 *
 * La etiqueta y la categoría de cada clave sólo existían en `apps/view`. Es lo
 * que hace legible la pantalla de roles, y también lo que necesita cualquier
 * otro cliente que quiera mostrar un permiso con su nombre en vez de con su
 * `SCREAMING_SNAKE_CASE`.
 */
export type { PermissionMetaEntry } from '@megadulces/contracts/authz/permission-meta';
export {
  PERMISSION_META,
  PERMISSION_CATEGORY_ORDER,
  TOTAL_PERMISSIONS,
} from '@megadulces/contracts/authz/permission-meta';
