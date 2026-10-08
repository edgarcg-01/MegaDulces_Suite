'use strict';
/**
 * `[SUC.1]` — **La sucursal 03 se llamaba `8ESQ` en la base, y eso es un código, no un nombre.**
 *
 * ── Por qué aparece ahora ────────────────────────────────────────────────────────────────────
 * Pedido de Edgar: *"sale como sucursal como número y es universal que debe salir como nombre"*.
 * Al construir el rotulador (`warehouseName()` en `libs/contracts`) hubo que mirar de dónde sale
 * el nombre de cada plaza, y la base contradecía al código:
 *
 *     commercial.warehouses.name  →  '8ESQ'        ← un código con forma de nombre
 *     store-branches.ts (front)   →  '8 Esquinas'
 *     purchase-adjustments.service.ts ya lo había denunciado textual:
 *       *"y ya divergía: «8 Esquinas» / «8ESQ» / «Ocho Esquinas»"*
 *
 * ⭐ Lo llamativo es la dirección del error: **el dato estaba peor que la copia**. La lista
 * cableada del frontend —la que hay que retirar— tenía el nombre bueno, y la tabla canónica el
 * malo. Por eso no alcanzaba con «leer de la base»: había que arreglarla.
 *
 * Autorizado por Edgar el 2026-10-07 («corrijo 03 a 8 Esquinas y dejo 05»).
 *
 * ── Lo que NO se toca, y con motivo ──────────────────────────────────────────────────────────
 * ⛔ `05` queda `Zamora Centro` con su `short_label` **`DAMASO`**. Parece una inconsistencia y no
 * lo es: `name` es el nombre de la plaza y `short_label` el apodo de piso con el que la nombra la
 * gente. Cambiarlo sería renombrar algo que alguien dice todos los días.
 * ⛔ `display_order` tiene una **colisión real** —`05` y `07` valen los dos 8, y falta el 3— pero
 * tampoco se toca acá: el orden de pantalla lo manda `WAREHOUSE_DISPLAY_ORDER`, no esta columna,
 * así que arreglarla no cambiaría ninguna pantalla y mezclaría dos asuntos en una migración.
 * Queda DECLARADO para que no se descubra de nuevo dentro de seis meses.
 *
 * ── Seguridad del cambio, verificada antes de escribirla ─────────────────────────────────────
 * `name` **no es llave de nada**: grep en `libs/`, `apps/` y `database/` no encontró un solo
 * `where('name', …)` sobre `commercial.warehouses`, ni join por nombre. Los consumidores casan
 * por `code`, por `kepler_code` o por `wincaja_source_branch`.
 *
 * ⚠️ Idempotente y ACOTADA: sólo actúa si el nombre sigue siendo exactamente `8ESQ`. Si alguien
 * ya lo corrigió a mano —o le puso otra cosa a propósito— esta migración no pisa su decisión.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const VIEJO = '8ESQ';
const NUEVO = '8 Esquinas';

exports.up = async function (knex) {
  const r = await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '03', name: VIEJO })
    .whereNull('deleted_at')
    .update({ name: NUEVO, updated_at: knex.fn.now() });
  // Se declara lo que pasó: 1 = se corrigió · 0 = ya estaba (o alguien le puso otro nombre).
  console.log(`[SUC.1] commercial.warehouses 03: ${r} fila(s) con name '${VIEJO}' -> '${NUEVO}'`);
};

exports.down = async function (knex) {
  await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '03', name: NUEVO })
    .whereNull('deleted_at')
    .update({ name: VIEJO, updated_at: knex.fn.now() });
};
