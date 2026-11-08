'use strict';
/**
 * `[VAC.P1]` — Índices para que el escaneo del verificador de precios no barra `kdii` entero.
 *
 * `/api/kp/precio` busca el código escaneado en SIETE columnas de `kepler_ods.kdii` (clave, EAN
 * primario y secundarios, código interno) con `TRIM(col) = $1 OR ...`. Ningún índice sirve para
 * eso —`ix_kdii_suc_sku` arranca por sucursal—, así que cada escaneo era un Parallel Seq Scan.
 *
 * Un índice NO es una copia (regla 2): no duplica el dato ni agrega lag; sólo cuesta un poco en
 * el UPSERT del replicador, igual que `ix_kdii_suc_sku` (mig 20260822140100).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-07) ────────────────────────────────────────
 *  · `kdii`: 86,132 filas, 79 MB. La consulta del escaneo: Parallel Seq Scan, 62–66 ms de
 *    ejecución (3 corridas), 8,892 buffers, para devolver 9 filas.
 *  · `/api/kp/precio` de punta a punta: ~75 ms en la LAN, ~280 ms por megadulcessuite.com.
 *  · La WHERE nueva (arreglo + `@>`) contra la vieja (7 OR): 428 códigos de las 7 columnas
 *    (cortos, con y sin ceros, basura), 3,815 filas, 0 diferencias. Prueba negativa: quitarle
 *    `c85` al arreglo sí difiere (9 filas contra 0).
 *  · Plan con estos índices (tabla temporal a escala de prod, base local, ROLLBACK): Bitmap
 *    Index Scan, 0.44 ms con EAN y 0.09 ms con clave corta (BitmapOr de los dos índices).
 *
 * ⛔ Las expresiones tienen que ser IDÉNTICAS a las de `KpService.getPrecio`: si cambian allá,
 *    cambian aquí, o el índice deja de aplicar en silencio y vuelve el barrido.
 *
 * CONCURRENTLY + `transaction:false`: el CDC le escribe a `kdii` en vivo y un CREATE INDEX normal
 * lo bloquearía mientras dura. Un CONCURRENTLY que falla deja el índice INVÁLIDO y `IF NOT EXISTS`
 * lo daría por hecho: por eso se borra antes si quedó inválido.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

const IDX = [
  // El código escaneado en cualquiera de las 7 columnas: un GIN sobre el arreglo, una sola
  // condición `@>` en vez de 7 OR.
  ['ix_kdii_codigos_verificador',
    `USING gin ((ARRAY[btrim(c1::text), btrim(c7::text), btrim(c82::text), btrim(c93::text),
                       btrim(c95::text), btrim(c96::text), btrim(c85::text)]))`],
  // La clave interna corta tecleada sin ceros ("123" contra "00123").
  ['ix_kdii_clave_lpad5', `((lpad(btrim(c1::text), 5, '0')))`],
];

exports.up = async function up(knex) {
  await knex.raw(`SET lock_timeout = '5s'`);
  try {
    for (const [name, def] of IDX) {
      const { rows } = await knex.raw(
        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'kepler_ods' AND c.relname = ?`, [name]);
      if (rows[0] && rows[0].indisvalid === false) {
        await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${name}`);
      }
      await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON kepler_ods.kdii ${def}`);
    }
  } finally {
    await knex.raw(`RESET lock_timeout`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const [name] of IDX) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${name}`);
  }
};
