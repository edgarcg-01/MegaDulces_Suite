/**
 * `[ID.28]` — Re-export. La definición vive en `@megadulces/contracts`.
 *
 * Era una de las cinco copias del enum (175 claves, idénticas a las del backend
 * clave por clave — verificado antes de mover). Se conserva como re-export para
 * no tocar los **82 archivos** de esta app que importan `Permission` desde acá.
 *
 * ⚠️ No agregues claves acá: van en `libs/contracts/src/authz/permissions.ts`.
 */
export { Permission } from '@megadulces/contracts/authz/permissions';
