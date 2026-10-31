/**
 * SM.35 — La identidad del turno de caja vive en `@megadulces/platform-core`
 * (`lib/caja/cash-cut-identity.ts`) desde `[CSU.16]`: la usa también Cortes/Sucursales,
 * en `libs/finance`, que no puede importar de esta lib. Esto sólo la re-exporta para
 * que los consumidores de aquí no cambien de import.
 */
export { CUADRE_UMBRAL, cuadreTurno, pideRetiro } from '@megadulces/platform-core';
export type { CorteKepler, CuadreTurno, MotivoNoMedible } from '@megadulces/platform-core';
