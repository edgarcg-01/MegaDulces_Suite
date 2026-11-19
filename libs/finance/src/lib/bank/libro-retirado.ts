/**
 * `[BFU.5.1]` El libro CUENTAS de Tesorería ya no se carga (Edgar, 2026-11-19: «ya no se vuelve a usar workbook»).
 * La fuente de los bancos es la descarga del banco (Bancos › Estados de cuenta, VERDAD §39). La subida por pantalla
 * y la sincronización con Google Sheets lo niegan con este mensaje; el importador del servicio sigue existiendo
 * porque las pruebas contra base real lo usan para armar sus casos.
 */
export const LIBRO_RETIRADO = 'El libro CUENTAS de Tesorería ya no se carga: la fuente de los bancos es la descarga del banco. Súbela en Bancos › Estados de cuenta.';
