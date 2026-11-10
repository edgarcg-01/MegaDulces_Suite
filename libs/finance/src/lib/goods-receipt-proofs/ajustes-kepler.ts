/**
 * `[RE.64]` Las notas de crédito y devoluciones que Kepler aplicó a cada orden de entrada.
 *
 * `[RE.67]` El primitivo vive en `@megadulces/contracts/finance/ajustes-kepler` porque también lo lee
 * comercial («Costo por proveedor») y un dominio no importa a otro. Este archivo sólo lo re-exporta para
 * que los consumidores de finanzas (y su spec) no cambien de ruta. Toda la documentación está allá.
 */
export * from '@megadulces/contracts/finance/ajustes-kepler';
