'use strict';
/**
 * `[JZ.6]` — **La ruta vecinal es un canal aparte, y por eso responde aparte.**
 *
 * Edgar (2026-09-17): *«hay que mostrar vecinal aparte»*.
 *
 * Es la tercera clave del mismo criterio que partió tiendas de rutas en `[JZ.3]`: **una clave por
 * canal, porque son trabajos distintos y pantallas distintas**. La vecinal tiene su propia gente
 * —5 `vendedor_ruta` con ficha en las zonas `* VECINAL`— y su propio patrón de venta; hay quien
 * responde del piso y no de la ruta, y quien responde de la vecinal y no de la ruta directa.
 *
 * ── Lo que desbloquea, medido ───────────────────────────────────────────────────────────────
 * Las vecinales vendieron **$944,740 en LA PIEDAD del 1 al 16 de septiembre** (`1V001` + `1V002`
 * de Padre Hidalgo, `1V003` de La Piedad Abastos) y **no aparecían en ninguna parte** de la
 * portada: no tienen almacén `RUTA-*` propio, así que `[JZ.2]` las declaraba `sin_almacen` y
 * `[JZ.3]` ni siquiera las listaba. El puente nuevo (`analytics.v_route_zone`) las resuelve.
 *
 * ⚠️ **No son una zona aparte.** Cuelgan de la sucursal madre, así que su zona es la misma que la
 * de las tiendas (`LA PIEDAD RD`). Las zonas `LA PIEDAD VECINAL` / `ZAMORA VECINAL` de
 * `trade.zones` son eje de PERSONAS y no tienen un solo almacén.
 *
 * Se asigna al mismo puesto que las otras dos (`jefe_zona`, 3 personas). Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const NUEVAS = [
  [
    'comercial.venta_vecinal',
    'Venta de tus rutas vecinales',
    'Cuanto vendieron las rutas vecinales de tu zona en el tramo, contra el mismo tramo anterior.',
    'zone',
    94,
  ],
];

const PUESTO = 'jefe_zona';

exports.up = async function up(knex) {
  for (const [key, label, desc, dim, orden] of NUEVAS) {
    await knex.raw(
      `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                       dimension = EXCLUDED.dimension, orden = EXCLUDED.orden`,
      [key, label, desc, dim, orden],
    );
  }
  console.log(`  [JZ.6] catálogo: +${NUEVAS.length} responsabilidad (venta vecinal)`);

  const puestos = await knex('identity.positions').where({ code: PUESTO }).select('tenant_id');
  if (puestos.length === 0) {
    console.log(`  [JZ.6] ⚠️ el puesto "${PUESTO}" no existe — NO se asignó nada`);
    return;
  }
  for (const { tenant_id } of puestos) {
    for (const [key] of NUEVAS) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [JZ.6] ${PUESTO} ya responde de "${key}" — sin cambios`);
        continue;
      }
      await knex('identity.position_responsibilities').insert({
        tenant_id,
        position_code: PUESTO,
        responsibility_key: key,
        es_principal: true,
      });
      console.log(`  [JZ.6] ${PUESTO} → ${key}`);
    }
  }
};

exports.down = async function down(knex) {
  await knex('identity.position_responsibilities')
    .where({ position_code: PUESTO })
    .whereIn('responsibility_key', NUEVAS.map(([k]) => k))
    .del();
  await knex('identity.responsibilities')
    .whereIn('key', NUEVAS.map(([k]) => k))
    .del();
};
