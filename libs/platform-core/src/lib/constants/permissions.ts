/**
 * `[ID.28]` — Re-export. La definición vive en `@megadulces/contracts`.
 *
 * Este archivo era una de las **cinco** copias del enum. Se conserva como
 * re-export en vez de borrarse para no tocar los ~200 archivos del backend que
 * importan `Permission` desde `@megadulces/platform-core`: el punto de la
 * etapa es que haya **una sola definición**, no renombrar imports en todo el
 * repo el mismo día.
 *
 * ⚠️ No agregues claves acá. Van en
 * `libs/contracts/src/authz/permissions.ts`, y el gate G1 se pone rojo si
 * aparece un segundo `export enum Permission` en el repo.
 */
export { Permission } from '@megadulces/contracts/authz/permissions';
