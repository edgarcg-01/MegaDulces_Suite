// Token de inyección en su propio archivo, no en el módulo: evita el import
// circular módulo↔servicio (mismo patrón que kepler-consolidado.constants.ts
// en apps/api/src/modules/kepler-consolidado/).
export const KNEX_KP_CONCENTRADA = 'KNEX_KP_CONCENTRADA';
