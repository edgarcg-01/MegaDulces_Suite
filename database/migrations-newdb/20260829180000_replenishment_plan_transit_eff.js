/**
 * RA-PRO.45 — El tránsito se pesa por la probabilidad de que llegue.
 *
 *   transit_eff_cajas  numeric — mismas cajas de `transit_cajas` pero multiplicadas por
 *                       P(llega | edad de la OC), curva derivada del propio ODS cada corrida.
 *
 * Por qué dos columnas y no una: `transit_cajas` es lo que dicen los papeles — es lo que el
 * comprador ve en la columna "En camino" y puede rastrear folio por folio en el diálogo, así que
 * tiene que seguir cuadrando con la suma de las OCs. `transit_eff_cajas` es lo que el motor
 * descuenta de la necesidad.
 *
 * El fondo: en Kepler la OC `X-A-35` se captura CUANDO SE RECIBE (81% de las del CEDIS y 95–100%
 * de las de sucursal cierran el mismo día), así que una OC abierta no es "el pipeline normal" sino
 * un documento estancado. Medido 2026-08-29 sobre OCs de hace 180–400 d ya resueltas: de las que
 * seguían abiertas al día 45 sólo el 13.6% terminó recibiéndose. Restar el 100% sobrecreditaba
 * $10.4M de $20.3M (51%) y dejaba 420 filas producto×almacén en piso CERO sin pedir.
 */
exports.up = async function up(knex) {
  if (await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', 'transit_eff_cajas')) return;
  await knex.schema.withSchema('analytics').alterTable('replenishment_plan', (t) => {
    t.decimal('transit_eff_cajas', null);
  });
};

exports.down = async function down() {
  // aditiva — no se revierte (la columna queda; el importer la repuebla)
};
