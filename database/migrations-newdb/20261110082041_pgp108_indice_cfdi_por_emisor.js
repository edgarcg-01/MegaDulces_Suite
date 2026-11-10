'use strict';
/**
 * `[PGP.108]` — **Índice de los CFDI recibidos por RFC emisor y fecha.**
 *
 * El Calendario de Pagos liga cada factura con su CFDI (mismo RFC, total ±$1, fecha ±45 días) para
 * saber si es PUE o PPD y armar la póliza de egreso. `fiscal.cfdis` no tiene índice por emisor.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-10) ────────────────────────────────────────
 *  · `fiscal.cfdis`: 451,951 filas, 1.4 GB.
 *  · La consulta de candidatos de un día (17 RFC, ventana de 5 meses) entra por
 *    `ix_fiscal_cfdis_fecha` y descarta **21,570 filas** para quedarse con 163: 100 ms en el
 *    servidor, 250–390 ms desde la API. Con el índice por emisor lee sólo las suyas.
 *
 * Parcial (sólo recibidas tipo I, que es lo único que esta consulta lee): más chico y más barato
 * de mantener.
 *
 * CONCURRENTLY + `transaction:false`: el carril del ADD escribe en `fiscal.cfdis` en vivo y un
 * CREATE INDEX normal lo bloquearía mientras dura. Un CONCURRENTLY que falla deja el índice INVÁLIDO
 * y `IF NOT EXISTS` lo daría por hecho: por eso se borra antes si quedó inválido. ⚠️ Aplicarla fuera
 * del horario hábil (regla 9): recorre la tabla completa.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

const NOMBRE = 'ix_fiscal_cfdis_recibidas_emisor_fecha';
const DEF = `(tenant_id, emisor_rfc, fecha) WHERE rol = 'recibidas' AND tipo_comprobante = 'I'`;

exports.up = async function up(knex) {
  await knex.raw(`SET lock_timeout = '5s'`);
  try {
    const { rows } = await knex.raw(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'fiscal' AND c.relname = ?`, [NOMBRE]);
    if (rows[0] && rows[0].indisvalid === false) {
      await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS fiscal.${NOMBRE}`);
    }
    await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NOMBRE} ON fiscal.cfdis ${DEF}`);
  } finally {
    await knex.raw(`RESET lock_timeout`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS fiscal.${NOMBRE}`);
};
