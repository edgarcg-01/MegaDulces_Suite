'use strict';
/**
 * `[P2.9 paso 2]` — Caducidades: la unidad del renglón pasa de 4 a 7 (pieza · paquete · caja · bulto · kg ·
 * bolsa de 250 g · bolsa de 500 g). Decisiones D1–D3 del PM (2026-10-19), `FASE_FEFO_CADUCIDAD` §P2.9.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30) ─────────────────────────────────────────
 *  · 129 renglones (81 pieza · 44 caja · 4 sin unidad). De 118 cruzables con `kdii`, sólo **54 (46 %)**
 *    están en una unidad que el producto tiene en Kepler; **60 son «pieza» sobre productos de base PAQ
 *    sin ranura PZA**. 74 de los 104 productos capturados son de base **PAQ**, y la pantalla no ofrecía
 *    «paquete»: había que escoger entre caja y pieza.
 *
 * Sólo AMPLÍA el CHECK: ningún valor existente deja de ser válido y no se toca ninguna fila.
 * La columna es `varchar(10)`: «paquete» (7) cabe.
 *
 * ⚠️ Se aplica en prod ANTES del código: un servidor nuevo sobre el CHECK viejo responde 500 al
 *    guardar «paquete» (el servicio lo acepta y la base lo rechaza).
 *
 * Idempotente: suelta el CHECK por nombre (IF EXISTS) y lo vuelve a crear.
 *
 * @param { import("knex").Knex } knex
 */

const CHK = 'commercial_expiry_review_lines_unit_chk';
const SIETE = ['pieza', 'paquete', 'caja', 'bulto', 'kg', 'g250', 'g500'];
const CUATRO = ['caja', 'pieza', 'bulto', 'kg'];

const lista = (us) => us.map((u) => `'${u}'`).join(', ');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.expiry_review_lines DROP CONSTRAINT IF EXISTS ${CHK}`);
  await knex.raw(`ALTER TABLE commercial.expiry_review_lines ADD CONSTRAINT ${CHK} CHECK (unit IS NULL OR unit IN (${lista(SIETE)}))`);
  await knex.raw(
    `COMMENT ON COLUMN commercial.expiry_review_lines.unit IS 'Unidad en que se CONTÓ el renglón: pieza | paquete | caja | bulto | kg | g250 (bolsa de 250 g) | g500 (bolsa de 500 g). Definición única en libs/contracts (caducidad-unidad). NULL = renglón anterior a la columna.'`,
  );
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: vuelve al CHECK de 4. Si ya hay renglones con
 * paquete/g250/g500 el CHECK viejo no se puede validar sin tocarlos: se crea `NOT VALID` (protege
 * lo que entre después) y NO se reescribe ninguna fila — un `down` no inventa la unidad de nadie.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.expiry_review_lines DROP CONSTRAINT IF EXISTS ${CHK}`);
  await knex.raw(`ALTER TABLE commercial.expiry_review_lines ADD CONSTRAINT ${CHK} CHECK (unit IS NULL OR unit IN (${lista(CUATRO)})) NOT VALID`);
};
