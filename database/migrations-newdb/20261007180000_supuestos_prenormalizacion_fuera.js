'use strict';
/**
 * `[VE.7.1]` — **Los supuestos que sobrevivieron a la limpieza también nacieron mal.**
 *
 * `[VE.6.1]` sacó del JSONB las claves de canales **muertos** (`credito`, `contado_nf`) y dejó las
 * otras tres. Al mirar la pantalla con ojos de usuario se ve el problema que eso deja:
 *
 *     Mostrador  12.5 %     ← guardado el 2026-09-21, calculado sobre el canal PARTIDO
 *     Mayoreo     2.6 %     ← NO tiene valor propio: está mostrando el RESPALDO genérico
 *     Ruta        1.3 %     ← mismo origen pre-normalización
 *     Vecinal    44.4 %     ← idem; y +44 % en un canal es justo la forma de un artefacto
 *
 * ⛔ **`mayoreo` muestra 2.6 % y su valor derivado correcto es −8.4 %** (medido: $140.2 M → $128.4 M
 * sobre el canal canónico). Son 11 puntos sobre el canal que concentra **$95.7 M de meta**, y el
 * 2.6 % no es ni siquiera un cálculo: es el default cayendo donde no hay dato.
 *
 * ⭐ El error de criterio de `[VE.6.1]` fue tratar el problema como «claves que ya no existen»
 * cuando era **«números calculados con el catálogo viejo»**. `mostrador` existe y siempre existió
 * — pero su 12.5 % se calculó cuando `contado_nf` estaba afuera, así que tampoco describe al canal
 * de hoy. *Lo que caduca no es el nombre de la clave: es el universo con que se calculó el valor.*
 *
 * Se vacía `growth_by_channel` entero. El piloto (`[VE.7]`) lo vuelve a derivar en la pasada
 * nocturna sobre el canal canónico, y escribe sólo los canales sin valor — así que esto no compite
 * con nadie: deja el lugar limpio para que lo llene quien sabe calcularlo.
 *
 * ⚠️ **No se borra `default_growth_pct`**: es el respaldo declarado para un canal sin historia
 * propia (`mayoreo` lo necesitaba hasta hoy), y dejarlo en NULL rompería a los canales nuevos.
 * Lo que cambia es que la pantalla ahora **declara** cuándo un canal está usando ese respaldo en
 * vez de mostrarlo como si fuera su cifra (ADR-056).
 */

exports.up = async function up(knex) {
  const { rows: antes } = await knex.raw(
    `SELECT budget_id, growth_by_channel FROM budget.sales_plan_settings
      WHERE growth_by_channel IS NOT NULL AND growth_by_channel <> '{}'::jsonb`);

  if (!antes.length) {
    console.log('[VE.7.1] no hay supuestos por canal guardados — nada que limpiar.');
    return;
  }

  for (const r of antes) {
    console.log(`[VE.7.1] ${r.budget_id}: se retira ${JSON.stringify(r.growth_by_channel)} `
      + '— calculado antes de normalizar el canal; el piloto lo re-deriva');
  }

  const { rowCount } = await knex.raw(
    `UPDATE budget.sales_plan_settings
        SET growth_by_channel = '{}'::jsonb, updated_by = 'migracion_ve71', updated_at = now()
      WHERE growth_by_channel IS NOT NULL AND growth_by_channel <> '{}'::jsonb`);
  console.log(`[VE.7.1] ${rowCount ?? 0} fila(s) limpiadas.`);
};

exports.down = async function down() {
  // No se repone: eran valores calculados sobre un catálogo de canales que ya no existe. Volver a
  // ponerlos sería restaurar el defecto, no deshacer el arreglo.
};
