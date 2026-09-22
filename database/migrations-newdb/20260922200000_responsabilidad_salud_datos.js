'use strict';
/**
 * `[SN.32]` — **La salud de las bases de datos es trabajo de Sistemas, y se declara como tal.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-22: *«necesito que en mi interfaz "superoot" muestres el estado de las bases de
 * datos /admin/db-health»*.
 *
 * ── Por qué hacía falta una fila y no una pantalla ──────────────────────────────────────────
 * La pantalla **ya existe** desde `[DBH.1]`: `/admin/db-health` publica frescura por fuente,
 * bandeja de alertas y salud del motor, y el menú la ofrece gateada por `USUARIOS_GESTIONAR`.
 * Lo que faltaba es de quién ES ese trabajo.
 *
 * Medido en prod el 2026-09-22 (solo lectura):
 *
 *   · `superoot` está fichado en el puesto `sistemas` («Jefatura de Sistemas y Transformación
 *     Digital», 4 personas: `felipe_galvan`, `jlh_lopez`, `superoot`, `guillermo_lopez`).
 *   · `identity.position_responsibilities` reparte claves a 14 puestos y **`sistemas` no es
 *     ninguno**: tiene **CERO** responsabilidades.
 *   · Por `[SN.30]` —«si no tiene responsabilidades no se le muestra nada»— «Mi trabajo» de
 *     `superoot` sale **vacía**, aunque su `superadmin` le abra todas las puertas. Es la
 *     distinción de `work/task.contract.ts` otra vez: *el permiso decide si podés ABRIRLO, la
 *     responsabilidad decide si es TUYO*.
 *   · Y había trabajo real esperando: **6 alertas abiertas, 5 críticas**, la más vieja desde el
 *     **12-sep** (10 días) — `wincaja_branch_stale`, `wincaja_feed`, `wincaja_cedis_stale`,
 *     `stock_snapshot`, `cxc_snapshot`, `cdc_reconcile`. De **869** alertas históricas,
 *     **CERO** reconocidas: la bandeja existe y nadie la tiene a cargo.
 *
 * ── ⛔ Por qué el reparto va al PUESTO y no por permiso ──────────────────────────────────────
 * Derivarlo de `USUARIOS_GESTIONAR` (como hace `[CG.21]` con su clave) barrería a todo puesto
 * administrativo. Es justo el modo de falla que `[SN.30]` vino a corregir: cinco colas sin dueño
 * ofrecidas a superadmins que no responden de ninguna. Acá el dueño se nombra: Sistemas.
 *
 * ⚠️ **Colateral declarado:** `guillermo_lopez` recibe esta clave porque su ficha sigue diciendo
 * `sistemas`, aunque `[CDRP.3]` ya le dio por persona las de Dirección Comercial. El arreglo de
 * fondo es moverlo de puesto desde `/admin/personas` (regla de Edgar, 2026-08-27 — el dato
 * operativo se administra por UI, no por script). Hasta entonces la ve de más, no de menos.
 *
 * ⛔ **Esto NO otorga permisos.** `USUARIOS_GESTIONAR` ya existe y ya está repartido; esta
 * migración sólo dice de quién es el trabajo.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] — mismo formato que `20260917190000`. */
const NUEVAS = [
  [
    'sistemas.salud_datos',
    'Salud de las bases de datos',
    'Fuentes, réplicas y feeds que dejaron de actualizarse o fallaron su última corrida. ' +
      'Sin dimensión: una réplica de Kepler o el CDC del ODS no le pertenecen a una sucursal.',
    null,
    100,
  ],
];

/** Medido: existe, 4 personas, `default_role = superadmin`, reporta a `direccion`. */
const PUESTO = 'sistemas';

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
  console.log(`  [SN.32] catálogo: +${NUEVAS.length} responsabilidad (salud de las bases de datos)`);

  const puestos = await knex('identity.positions')
    .where({ code: PUESTO })
    .whereNull('deleted_at')
    .select('tenant_id');
  if (puestos.length === 0) {
    // No se inventa un puesto: sin él la clave queda declarada y sin dueño, y eso se DICE.
    console.log(`  [SN.32] ⚠️ el puesto "${PUESTO}" no existe — la clave queda SIN DUEÑO`);
    return;
  }

  for (const { tenant_id } of puestos) {
    for (const [key] of NUEVAS) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [SN.32] ${PUESTO} ya responde de "${key}" — sin cambios`);
        continue;
      }
      await knex('identity.position_responsibilities').insert({
        tenant_id,
        position_code: PUESTO,
        responsibility_key: key,
        es_principal: true,
      });
      const gente = await knex('identity.users')
        .where({ tenant_id, position_code: PUESTO })
        .whereNull('deleted_at')
        .pluck('username');
      console.log(
        `  [SN.32] ${PUESTO} → ${key}  (la reciben ${gente.length}: ${gente.join(', ') || '—'})`,
      );
    }
  }
};

exports.down = async function down(knex) {
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
