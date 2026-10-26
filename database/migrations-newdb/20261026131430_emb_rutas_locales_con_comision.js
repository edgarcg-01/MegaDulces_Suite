'use strict';
/**
 * `[EMB.54]` — Las 3 rutas locales vuelven a PAGAR comisión: se les quita la marca «sin comisión»
 * que les puso EMB.33. Decisión de Edgar (2026-10-26, «sí, quítalas»).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-26) ────────────────────────────────────────
 *  · EMB.33 (13-oct) concluyó «los traslados locales no pagan comisión» midiendo SÓLO el concepto
 *    075. En el 054 (comisión de traspaso, cuenta 514-001) sí se pagan: en las 6 catorcenas pagadas
 *    del 13-ago al 22-oct, Logística cargó $93,963 al centro de Padre Hidalgo, $15,210 al de 8
 *    Esquinas, $11,520 al de La Piedad Abastos y $13,820 al de Yurécuaro. El 22-oct, Antonio
 *    Méndez, Raúl Galván y Rafa González cobraron $1,630, $1,770 y $1,560 al de Padre Hidalgo.
 *  · Con la marca, el reporte de la catorcena 8–21 oct les calculaba $0 a esos viajes (EMB.37).
 *  · El WHERE de abajo, corrido en sólo lectura, toca exactamente 3 rutas (las únicas marcadas).
 *
 * ── Lo que NO hace, a propósito ─────────────────────────────────────────────────────────────
 * NO les pone tarifa: lo pagado no sale de un monto fijo por viaje (los renglones de 8 Esquinas van
 * de $80 a $920 por persona y catorcena) y una tarifa inventada se pagaría. Sin la marca y en $0/$0
 * la ruta cuenta como «sin tarifa»: el reporte lo DICE en vez de pintar $0, y Logística la captura
 * en Configuración (con LOGISTICS_TARIFAS_AUTORIZAR si la ruta está fijada).
 * ⚠️ Mientras no tengan tarifa, un embarque MANUAL a esas rutas no crea su guía (regla de EMB.33);
 * los de Kepler no se frenan.
 *
 * Sólo toca las que siguen marcadas; cada cambio queda en `logistics.tariff_changes`.
 * ⚠️ Sólo hace UPDATE/INSERT: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA a todo el
 *    equipo hasta que alguien la aplique a mano. Se aplica en prod ANTES de soltar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[emb_rutas_locales_con_comision]';
const LOCALES = ['SANTA ANA PACUECO', 'SANTA ANA', 'LA PIEDAD'];
const NORMALIZA = `trim(regexp_replace(upper(translate(r.name,'ÁÉÍÓÚÜÑáéíóúüñ','AEIOUUNaeiouun')),'[^A-Z0-9]+',' ','g'))`;
const QUIEN = 'migración EMB.54 (decisión de Edgar, 2026-10-26: las locales sí pagan comisión)';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(
    `UPDATE logistics.routes r SET sin_comision = false, updated_at = now()
      WHERE r.deleted_at IS NULL AND r.sin_comision AND ${NORMALIZA} = ANY(?::text[])
      RETURNING r.id, r.tenant_id, r.name`,
    [LOCALES],
  );
  for (const r of rows) {
    await knex.raw(
      `INSERT INTO logistics.tariff_changes (tenant_id, entity, entity_id, entity_label, field, old_value, new_value, autorizado, changed_by_username)
       VALUES (?, 'route', ?, ?, 'sin_comision', 'true', 'false', true, ?)`,
      [r.tenant_id, r.id, r.name, QUIEN],
    );
  }
  console.log(`${TAG} pagan comisión otra vez (quedan «sin tarifa» hasta que Logística la capture): ${rows.map((r) => r.name).join(', ') || '(ninguna)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más; si ya les pusieron tarifa, se respeta. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(
    `DELETE FROM logistics.tariff_changes WHERE field = 'sin_comision' AND changed_by_username = ? RETURNING entity_id`,
    [QUIEN],
  );
  const ids = rows.map((r) => r.entity_id);
  if (ids.length) {
    await knex.raw(
      `UPDATE logistics.routes SET sin_comision = true, updated_at = now()
        WHERE id = ANY(?::uuid[]) AND COALESCE(driver_commission, 0) = 0 AND COALESCE(helper_commission, 0) = 0`,
      [ids],
    );
  }
};
