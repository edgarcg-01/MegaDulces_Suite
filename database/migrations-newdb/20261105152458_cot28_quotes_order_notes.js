'use strict';
/**
 * `[COT.28]` — Las observaciones del pedido: lo que Telemarketing le dice al almacén y a la ruta
 * («cobrar hoy para entregar hoy mismo», «REMISIÓN», «PEDIDO TIK TOK») viajan con la cotización
 * aceptada a «Comentarios» del Pedido TELEMARK en Kepler (`kdm1.c25`/`c26`; `c24` lleva el folio
 * de la cotización, que es la marca de idempotencia).
 *
 * Columna propia y no `notes`: `notes` se imprime AL CLIENTE en el PDF/Excel («Nota: …») y estas
 * son instrucciones internas del pedido.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-05) ──────────────────────────────────────────────
 *  · Kepler vivo (01, 05, 06, 08): `kdm1.c24`, `c25`, `c26` son `varchar(60)` → 120 caracteres
 *    caben en c25 + c26. De ahí el `varchar(120)`.
 *  · U-D-40 TELEMARK de 120 días en Padre Hidalgo: `c24` lleno en 1,836 de 1,948, `c25` en 657,
 *    `c26` en 39 — el comentario se usa, y casi siempre en una o dos líneas.
 *  · Los pedidos que ya armó la Suite traen c25 y c26 vacíos (7 de 7).
 *
 * Aditiva y nullable: la API desplegada no la conoce y no la necesita (expand).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN IF NOT EXISTS order_notes varchar(120)`);
  await knex.raw(
    `COMMENT ON COLUMN commercial.quotes.order_notes IS
     'COT.28: observaciones del pedido para Kepler (Comentarios, kdm1.c25/c26, 60+60). Internas: no se imprimen al cliente (eso es notes).'`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.quotes DROP COLUMN IF EXISTS order_notes`);
};
