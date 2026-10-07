'use strict';
/**
 * `[JZ.3]` — **EL JEFE DE ZONA RESPONDE DE LA VENTA DE SU ZONA, Y ESO NO ESTABA ESCRITO.**
 *
 * ── Qué desbloquea ──────────────────────────────────────────────────────────────────────────
 * Desde `[SN.30]` «Mi trabajo» muestra **sólo lo que la persona responde** (Edgar, 2026-09-14:
 * *«si no tiene responsabilidades no se le muestra nada»*). El bloque «Cómo va tu zona» que
 * agrega `[JZ.3]` se enciende con estas dos claves: sin ellas el código está, mide bien, y **no
 * se lo muestra a nadie**. Esta migración es la mitad de datos de esa entrega.
 *
 * ── Por qué DOS claves y no una ─────────────────────────────────────────────────────────────
 * Porque son dos trabajos y dos pantallas. El piso de venta se mira en `/tienda/live`; la ruta
 * directa en `/comercial/ventas-por-ruta`. Hay quien responde de uno y no del otro —un encargado
 * de sucursal responde de su piso y no de la ruta— y con una sola clave eso no se puede decir.
 * Es el mismo criterio que partió la conciliación en ingresos y egresos (`[SN.17]`).
 *
 * ── A quién se le asigna, y por qué ese puesto ──────────────────────────────────────────────
 * ⭐ **Medido en prod el 2026-09-15, y corrige una medición mía anterior.** Yo había reportado que
 * el puesto `jefe_zona` tenía **0 personas** y que los jefes reales eran `supervisor_rd`. Es
 * falso hoy:
 *
 *     jefe_zona     → 3 personas: aaron_alejo (MORELIA ABASTOS), ivette_cruz (LA PIEDAD RD),
 *                                 ramon_rodriguez (ZAMORA)
 *     supervisor_rd → 3 personas DISTINTAS: angel_vazquez, francisco_martinez, jose_herrera
 *
 * Los dos niveles existen y están poblados, uno por zona. Así que la asignación va al PUESTO
 * (`position_responsibilities`), que es la fuente normal, y no hace falta ninguna excepción por
 * persona.
 *
 * ⛔ **`supervisor_rd` NO recibe estas claves**, y es una decisión, no un olvido. Su trabajo es la
 * EJECUCIÓN —qué tiendas no se visitaron—, que es la otra mitad del diseño y sale de
 * `commercial.execution_360`, no de la venta. Darle la venta acá sería afirmar algo de su puesto
 * que el diseño contradice. Cuando exista su bloque, tendrá su propia clave.
 *
 * ── ⚠️ Dos cosas que quedan declaradas, no resueltas ────────────────────────────────────────
 *  1. **Ivette Cruz (jefa de zona de LA PIEDAD) NO tiene `COMMERCIAL_ROUTE_SALES_VER`** — medido.
 *     Sus 6 rutas (el 21 % de la venta de su zona) le van a aparecer **sin enlace y con el motivo**,
 *     que es el patrón ya establecido (`MePendiente.sin_acceso`). ⛔ Esta migración **no le da el
 *     permiso**: repartir permisos es una decisión de quien administra roles, y la responsabilidad
 *     ORDENA, no autoriza (regla de `[OR.1b]`). Queda dicho para que se decida, no se descubra.
 *  2. **Una persona = una zona.** `LA PIEDAD RD` y `LA PIEDAD VECINAL` son la misma plaza y hoy
 *     son dos filas de `trade.zones` sin nada arriba. Hasta que exista el agrupador de plaza, un
 *     jefe con dos zonas ve una.
 *
 * Aditiva e idempotente. No toca permisos, ni roles, ni personas.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] — mismo formato que `20260911140000`. */
const NUEVAS = [
  [
    'comercial.venta_tiendas',
    'Venta de tus tiendas',
    'Cuanto vendieron las sucursales de tu zona en el mes corrido, contra el mismo tramo anterior.',
    'zone',
    90,
  ],
  [
    'comercial.venta_rutas',
    'Venta de tus rutas',
    'Cuanto vendieron las rutas de detalle de tu zona en el mes corrido, contra el mismo tramo anterior.',
    'zone',
    92,
  ],
];

/** El puesto que responde de las dos. `es_principal` = es el eje de su trabajo, no un anexo. */
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
  console.log(`  [JZ.3] catálogo: +${NUEVAS.length} responsabilidades de venta por zona`);

  /*
   * El puesto puede no existir en un ambiente recién levantado (la FK es a
   * `identity.positions`). No se inventa: se dice y se sigue — el catálogo igual quedó cargado y
   * la asignación se puede repetir después, porque esta migración es idempotente.
   */
  const puestos = await knex('identity.positions').where({ code: PUESTO }).select('tenant_id');
  if (puestos.length === 0) {
    console.log(`  [JZ.3] ⚠️ el puesto "${PUESTO}" no existe — NO se asignó nada`);
    return;
  }

  for (const { tenant_id } of puestos) {
    for (const [key] of NUEVAS) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [JZ.3] ${PUESTO} ya responde de "${key}" — sin cambios`);
        continue;
      }
      await knex('identity.position_responsibilities').insert({
        tenant_id,
        position_code: PUESTO,
        responsibility_key: key,
        es_principal: true,
      });
      console.log(`  [JZ.3] ${PUESTO} → ${key}`);
    }
  }

  const n = await knex('identity.users')
    .where({ position_code: PUESTO })
    .whereNull('deleted_at')
    .count('* as n')
    .first();
  console.log(`  [JZ.3] personas en el puesto "${PUESTO}": ${n.n}`);
};

exports.down = async function down(knex) {
  // Se retiran SOLO las filas que esta migración creó. No se vacía ninguna tabla.
  await knex('identity.position_responsibilities')
    .where({ position_code: PUESTO })
    .whereIn(
      'responsibility_key',
      NUEVAS.map(([k]) => k),
    )
    .del();
  await knex('identity.responsibilities')
    .whereIn(
      'key',
      NUEVAS.map(([k]) => k),
    )
    .del();
};
