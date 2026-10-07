/**
 * `[ID.28]` — Re-export. La definición vive en `@megadulces/contracts`.
 *
 * ⚠️ Esta copia tenía **63 claves de 175: 112 de deriva**, y nadie lo veía —
 * el smoke de paridad comparaba back ↔ `apps/view`, o sea las dos que ya
 * coincidían. Verificado antes de reemplazarla: las 63 existen en el enum
 * canónico, así que pasar al contrato **suma** y no rompe ninguna referencia.
 *
 * Lo que la deriva significaba en la práctica: un permiso nuevo del backend no
 * existía como símbolo acá, así que una pantalla de esta app no podía gatearse
 * con él sin volver a escribirlo a mano — y escribirlo a mano es lo que hacía
 * crecer la deriva.
 */
export { Permission } from '@megadulces/contracts/authz/permissions';
