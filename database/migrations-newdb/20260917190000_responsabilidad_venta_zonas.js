'use strict';
/**
 * `[JZ.7]` — **DE QUÉ RESPONDE LA DIRECCIÓN.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-17: *«luis francisco es dirección general y guillermo lopez es dirección
 * comercial»*. Era una corrección al organigrama, y al medirla salió el hueco de fondo.
 *
 * ── Lo que estaba medido y no se veía ───────────────────────────────────────────────────────
 * Medido en prod el 2026-09-17:
 *
 *   · `superuser` (Luis Francisco López Gutierrez, el DUEÑO) y `guillermo_lopez` están fichados
 *     los dos en el puesto `sistemas` = «Jefatura de Sistemas y Transformación Digital».
 *   · Los puestos `direccion` («Dirección General», nivel dirección, la cúspide del organigrama)
 *     y `direccion_comercial` EXISTEN y tienen **0 personas**. El rol `direccion` existe en
 *     `role_permissions` y **no lo trae ningún usuario**.
 *   · `identity.position_responsibilities` reparte claves a **12 de ~50 puestos**, y **ninguno**
 *     es de dirección.
 *
 * Resultado: por `[SN.30]` —«si no tiene responsabilidades no se le muestra nada»— el dueño de la
 * empresa abría «Mi trabajo» y no veía **ni una** cola, tarea ni bloque. Su `superadmin` le abría
 * todas las puertas y no le declaraba ni un dueño. Es exactamente la distinción de
 * `work/task.contract.ts`: *el permiso decide si podés ABRIRLO, la responsabilidad decide si es
 * TUYO*.
 *
 * ── ⛔ Por qué una clave NUEVA y no las tres que ya existen ─────────────────────────────────
 * `comercial.venta_tiendas|_rutas|_vecinal` tienen `dimension = 'zone'` y anclan en
 * `identity.users.zona_id`. **La ficha de los dos directores dice OFICINAS**, que tiene 0
 * almacenes y 0 rutas (medido): darles esas tres claves les habría publicado «la venta de
 * OFICINAS» — un cero con cara de cifra, que es justo lo que ADR-056 prohíbe.
 *
 * `comercial.venta_zonas` va **sin dimensión**: el sujeto son TODAS las zonas con canal de venta,
 * y `medirZona` lo resuelve por otro camino. Que sea una clave aparte también deja decir «el
 * director comercial ve las zonas pero no la bandeja de finanzas», que con `superadmin` no se
 * puede decir.
 *
 * ── ⚠️ Esta migración NO mueve a ninguna persona ────────────────────────────────────────────
 * Reparte la clave a los DOS PUESTOS de dirección y ahí se queda. Mientras `superuser` y
 * `guillermo_lopez` sigan fichados en `sistemas`, no la recibe nadie y el bloque no aparece: se
 * enciende cuando alguien les corrija el puesto desde `/admin/personas`, que es donde ese dato se
 * administra (regla de Edgar, 2026-08-27 — el dato operativo se cambia por UI, no por script, y
 * así queda el rastro en `identity.user_events`).
 *
 * ⚠️ Y queda dicho, porque lo destapó la misma medición y no es de esta fase: de las **6 zonas
 * con canal de venta** sólo 3 tienen `jefe_zona`. **CANINDO, MORELIA MADERO y YURECUARO no
 * tienen jefe** — nadie responde hoy de su venta.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] — mismo formato que `20260915200000`. */
const NUEVAS = [
  [
    'comercial.venta_zonas',
    'Venta de todas las zonas',
    'Cómo va la venta de cada zona de la empresa, y el total sobre un mismo tramo. ' +
      'Sin dimensión: el sujeto son todas las zonas con canal de venta, no la de la ficha.',
    null,
    40,
  ],
];

/** Los dos puestos de dirección. Hoy vacíos los dos; ver la cabecera. */
const PUESTOS = ['direccion', 'direccion_comercial'];

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
  console.log(`  [JZ.7] catálogo: +${NUEVAS.length} responsabilidad (venta de todas las zonas)`);

  for (const PUESTO of PUESTOS) {
    const puestos = await knex('identity.positions').where({ code: PUESTO }).select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [JZ.7] ⚠️ el puesto "${PUESTO}" no existe — NO se asignó nada`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      for (const [key] of NUEVAS) {
        const ya = await knex('identity.position_responsibilities')
          .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
          .whereNull('deleted_at')
          .first();
        if (ya) {
          console.log(`  [JZ.7] ${PUESTO} ya responde de "${key}" — sin cambios`);
          continue;
        }
        await knex('identity.position_responsibilities').insert({
          tenant_id,
          position_code: PUESTO,
          responsibility_key: key,
          es_principal: true,
        });
        const n = await knex('identity.users')
          .where({ tenant_id, position_code: PUESTO })
          .whereNull('deleted_at')
          .count({ n: '*' })
          .first();
        console.log(
          `  [JZ.7] ${PUESTO} → ${key}  (${n && n.n ? n.n : 0} persona(s) en ese puesto hoy)`,
        );
      }
    }
  }
};

exports.down = async function down(knex) {
  await knex('identity.position_responsibilities')
    .whereIn('position_code', PUESTOS)
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
