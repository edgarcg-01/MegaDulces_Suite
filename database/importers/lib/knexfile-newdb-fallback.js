'use strict';
/**
 * `[AUD-DAT.12]` — **El respaldo `knexfile-newdb.js` NO viaja en la imagen de ingesta, así que
 * ahí un problema de CREDENCIAL se disfrazaba de ARCHIVO PERDIDO.**
 *
 * ── EL DEFECTO, MEDIDO (2026-09-28) ─────────────────────────────────────────────────────────
 * Diez importers resuelven su conexión con la misma forma:
 *
 *     const cfg = process.env.DATABASE_URL_NEW ? { …url… }
 *               : require('…/knexfile-newdb.js').development;   // ← el respaldo
 *
 * Dentro del contenedor `trade-ingest` sólo viajan `database/importers` y `database/scripts`
 * (ver `RUTAS` en `ops/vl/deploy.sh`): **`database/knexfile-newdb.js` no está**. Verificado en
 * vivo: `test -f /app/database/knexfile-newdb.js` → AUSENTE.
 *
 * O sea que al correr uno de esos scripts adentro sin el env cargado, el error que sale es
 *
 *     Cannot find module '/app/database/knexfile-newdb.js'
 *
 * que manda a buscar un archivo perdido cuando lo que falta es **la credencial**. Es el mismo
 * pecado que el resto de la capa: el síntoma no nombra la causa.
 *
 * ⚠️ **Alcance real, para no exagerarlo:** los 5 importers agendados de esa lista corren en
 * `.249` vía `sync-wincaja-actual.ps1` (Jet 32-bit, el bloqueo de VL.5), y **ahí el respaldo sí
 * existe** — no hay falla viva hoy. La trampa es para quien los corra a mano dentro del
 * contenedor, que es una operación normal: pasó dos veces esta misma tarde.
 *
 * ── QUÉ HACE, Y QUÉ NO ──────────────────────────────────────────────────────────────────────
 * Devuelve el bloque `development` del knexfile **sólo si el archivo existe de verdad**; si no,
 * tira un error que nombra la causa real y dónde vive el env. **No toca la lógica de SSL ni el
 * pool de cada llamador**: cada archivo tenía la suya y unificarla sería un cambio de
 * comportamiento escondido en un arreglo de diagnóstico.
 *
 * Hallazgo levantado por la sesión de `[IC.CEDIS]`, que se lo topó de frente, y medido acá.
 */
const fs = require('fs');
const path = require('path');

/** `database/knexfile-newdb.js` — el mismo destino que resolvían los diez llamadores. */
const RUTA_KNEXFILE_NEWDB = path.resolve(__dirname, '..', '..', 'knexfile-newdb.js');

/**
 * @param {string} quien nombre del script que llama, para que el error diga quién se quedó sin conexión.
 * @returns {object} el bloque `development` del knexfile.
 * @throws si no hay `DATABASE_URL_NEW` **y** el knexfile no existe en este sustrato.
 */
function knexfileNewdbFallback(quien) {
  if (fs.existsSync(RUTA_KNEXFILE_NEWDB)) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(RUTA_KNEXFILE_NEWDB).development;
  }
  throw new Error(
    `${quien}: falta DATABASE_URL_NEW y acá NO hay knexfile-newdb.js de respaldo.\n`
    + `  · Lo que falta es la CREDENCIAL, no el archivo: ${RUTA_KNEXFILE_NEWDB} no existe en este sustrato.\n`
    + '  · Dentro del contenedor de ingesta sólo viajan database/importers y database/scripts,\n'
    + '    así que el respaldo nunca está: cargá el env como lo hace run-feed.sh\n'
    + '      docker run --rm --network prod_default --env-file /home/superoot/secrets/feeds.env …\n'
    + '  · Fuera del contenedor, exportá DATABASE_URL_NEW desde el .env del repo.',
  );
}

module.exports = { knexfileNewdbFallback, RUTA_KNEXFILE_NEWDB };
