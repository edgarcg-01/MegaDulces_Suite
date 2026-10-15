/**
 * `[CGP-L.9]` La sucursal del cajón de la Caja General: OFICINAS, `'00'`.
 *
 * El cajón físico es UNO y paga a todas las plazas —las nóminas de cuatro sucursales salen de la
 * misma bóveda (`[CG.98]`, medido)—, así que su corte NO se acota por sucursal. El cajero
 * automático (CAOS) también es un solo dispositivo ahí (CS.0). Es la misma `'00'` que Kepler llama
 * OFICINAS (`docs/ERP_KEPLER.md` §2.3), aunque el catálogo compartido todavía la nombre CEDIS.
 *
 * Una sola constante porque el alcance del corte, el sensor del corte abierto, la lista de jornadas
 * pendientes, el cajero y la pantalla hablan del MISMO cajón: dos copias del mismo `'00'` divergen.
 */
export const SUCURSAL_CAJA_GENERAL = '00';
