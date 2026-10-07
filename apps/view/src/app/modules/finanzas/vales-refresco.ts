/**
 * `[GX.73]` **Cada cuánto se refrescan solas las pantallas de vales.**
 *
 * Reporte del usuario (2026-10-07): *«a los usuarios les tarda mucho cuando el estatus de su vale
 * cambia, aún lo ven en una fase anterior»*. Una de las dos causas era de pantalla: Mis gastos,
 * Aprobación, Historial y Expediente cargaban UNA vez y no volvían a preguntar. Quien sube el vale
 * no veía que se lo aprobaron hasta recargar, y quien aprueba no veía llegar los nuevos. (La otra
 * causa era de ingesta —la autorización de Kepler no llegaba al ODS—, ver
 * `database/importers/lib/ods-open-docs.js`.)
 *
 * ⚠️ Por qué ENCUESTA y no el socket `/expense-proofs`: (1) los cambios que vienen de Kepler no
 * emiten nada — el socket sólo avisa lo que pasa dentro de la Suite; (2) el socket rechaza a quien
 * sólo tiene `CAPTURAR`, que es justo quien sube vales, y abrírselo le mandaría el evento de los
 * vales de TODA la empresa (`solicitante`, `importe`). La encuesta pide lo de siempre, con el mismo
 * alcance del servidor.
 *
 * ⚠️ Por qué 60 s: la red de estado del ODS re-envía cada 5 min, así que refrescar más seguido no
 * trae dato más nuevo de Kepler; y 60 s es lo que ya usa la campana de avisos. Sólo corre con la
 * pestaña visible y se pone al día al volver (`encuestarVisible`).
 */
export const REFRESCO_VALES_MS = 60_000;
