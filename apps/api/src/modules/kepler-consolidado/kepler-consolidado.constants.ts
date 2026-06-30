// Token de inyección para la conexión Knex a la DB de consolidación Kepler
// (kepler_consolidado en localhost:5433). En archivo aparte para evitar el
// import circular módulo↔servicio (lección KNEX_NEW_DB).
export const KNEX_KEPLER_CONSOLIDADO = 'KNEX_KEPLER_CONSOLIDADO';
