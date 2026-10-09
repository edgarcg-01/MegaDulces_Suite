'use strict';
/**
 * `[PVI.17]` — **El presupuesto ya tiene quién lo firme; le faltaba de quién ES.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Del usuario, 2026-10-09, sobre qué herramientas darle a Dirección General *«considerando que
 * ésta es su torre de control»*. La respuesta medida fue que **el módulo no necesita un tablero
 * nuevo**: por ADR-076 la torre es «Mi trabajo» (`/projects`), y lo que falta es que Presupuestos
 * **emita** hacia ella. Esta migración es la mitad de datos de esa emisión.
 *
 * ── Por qué una fila de catálogo y no una pantalla ──────────────────────────────────────────
 * La bandeja **ya existe**: `[TES.17]` construyó `PendingApprovalsService` y la pinta dentro de
 * `/presupuesto`. El defecto no es que falte la cola, es **dónde vive**: obliga a entrar al módulo
 * para enterarse de que hay algo que firmar, que es justo lo que una portada existe para evitar.
 *
 * `[PVI.17]` registra las dos colas en `BANDEJAS` (`libs/trade/.../me-work.ts`), y `[SN.30]` manda
 * que **una cola sólo se le muestra a quien RESPONDE de ella**. Sin esta fila y sin su reparto, las
 * dos entradas nuevas serían invisibles para todos, en silencio.
 *
 * ── Lo medido en prod el 2026-10-09 (solo lectura) ──────────────────────────────────────────
 *
 *     budget.budgets              3 ejercicios, los 3 en 'borrador'   → 0 esperando firma
 *     budget.expense_obligations  156 en 'propuesta' por $74,809,091.57  (+156 del duplicado
 *                                 `is_test`, copia byte a byte, que NO se cuentan)
 *     budget.line_movements       139, todos 'apertura' — reservado/comprometido/ejercido en $0
 *
 * ⭐ O sea: **Dirección ya puede aprobar y no tiene nada que aprobar.** `PRESUPUESTOS_APROBAR` se
 * repartió el 2026-10-09 (batch 867) a `direccion` y `superadmin`, y los 3 ejercicios siguen en
 * borrador. Ese 0 es precisamente lo que la cola de ejercicios está para gritar — y por eso van
 * DOS entradas y no una: con un solo contador, las 156 obligaciones se comen al 0.
 *
 * ── A qué puestos va, y por qué a ésos ──────────────────────────────────────────────────────
 * `direccion` firma; `jefe_finanzas` prepara y vigila. Es la separación que el diagnóstico de esta
 * sesión recomendó y que hoy no existe: `PRESUPUESTOS_GESTIONAR` prepara y aprueba a la vez, y lo
 * tienen las mismas 2 personas que firman.
 *
 * ⛔ **Esto NO otorga permisos.** La responsabilidad dice de quién es el trabajo; el permiso dice
 * si puede abrirlo (`work/task.contract.ts`). Medido, quién gana visibilidad de verdad:
 *
 *     direccion      guillermo_lopez   ve ✔  firma ✔
 *                    superuser         ve ✔  firma ✔
 *     jefe_finanzas  carmen_rodriguez  ve ✔  firma ✘   (rol `finanzas`: sólo lectura)
 *                    jesus_carrillo    ve ✘  firma ✘   ← su rol `finanzas_operativo` no tiene
 *                                                        `PRESUPUESTOS_VER`: recibe la clave y
 *                                                        la bandeja NO le llega
 *
 * El caso de `jesus_carrillo` se DECLARA en el log en vez de resolverse acá: darle la llave es una
 * decisión de quién prepara el presupuesto, no un efecto colateral de una migración — y los
 * permisos de un rol se administran desde `/admin/roles` (regla de Edgar). Mismo criterio que
 * `[SN.39]`, que declaró los 5 auxiliares sin `warehouse_code` en vez de inventarles sucursal.
 *
 * ── Forma de la fila ────────────────────────────────────────────────────────────────────────
 * `dimension` NULL: un ejercicio de presupuesto es de la empresa, no de una sucursal — no hay eje
 * que acotar, y las dos bandejas declaran `acotablePorSucursal: false`. `orden` 18 la deja entre
 * `finanzas.cartera` (16) y `finanzas.acciones` (20), que es su vecindario: las otras colas donde
 * Finanzas decide sobre dinero.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] */
const NUEVAS = [
  [
    'finanzas.presupuesto',
    'Presupuesto por autorizar',
    'Ejercicios de presupuesto enviados a firma y obligaciones de gasto esperando autorización. ' +
      'Sin aprobar, el ejercicio no se hace vigente ni materializa sus partidas; sin autorizar, la ' +
      'obligación no entra al Calendario de pagos. Sin dimensión: el ejercicio es de la empresa.',
    null,
    18,
  ],
];

/**
 * `direccion` firma, `jefe_finanzas` prepara y vigila.
 *
 * ⚠️ `tesoreria` (`maria_gutierrez`) queda fuera a propósito: ejecuta el pago una vez autorizado,
 * no decide la autorización — y su rol tampoco tiene `PRESUPUESTOS_VER`, así que la fila no le
 * mostraría nada. Sumarla es una línea el día que se decida; no se asume.
 */
const PUESTOS = ['direccion', 'jefe_finanzas'];

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
  console.log(`  [PVI.17] catálogo: +${NUEVAS.length} responsabilidad (presupuesto por autorizar)`);

  for (const PUESTO of PUESTOS) {
    const puestos = await knex('identity.positions')
      .where({ code: PUESTO })
      .whereNull('deleted_at')
      .select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [PVI.17] ⚠️ el puesto "${PUESTO}" no existe — no recibe la clave`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      for (const [key] of NUEVAS) {
        const ya = await knex('identity.position_responsibilities')
          .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
          .whereNull('deleted_at')
          .first();
        if (ya) {
          console.log(`  [PVI.17] ${PUESTO} ya responde de "${key}" — sin cambios`);
          continue;
        }
        await knex('identity.position_responsibilities').insert({
          tenant_id,
          position_code: PUESTO,
          responsibility_key: key,
          es_principal: true,
        });

        /*
         * ⛔ El log dice quién la ve DE VERDAD, no a cuántos se les asignó. Una responsabilidad
         * sin el permiso que abre la ruta es una bandeja que nunca aparece, y el defecto es
         * silencioso: nadie reporta una caja que no está. Se cruza acá, contra el estado vivo.
         */
        const gente = await knex('identity.users as u')
          .leftJoin('identity.role_permissions as rp', 'rp.role_name', 'u.role_name')
          .where({ 'u.tenant_id': tenant_id, 'u.position_code': PUESTO })
          .whereNull('u.deleted_at')
          .select('u.username', 'u.role_name', knex.raw(`(rp.permissions->>'PRESUPUESTOS_VER') as ve`));

        const ven = gente.filter((g) => g.ve === 'true');
        const ciegos = gente.filter((g) => g.ve !== 'true');
        console.log(
          `  [PVI.17] ${PUESTO} → ${key}  (la VEN ${ven.length} de ${gente.length}: ${ven.map((g) => g.username).join(', ') || '—'})`,
        );
        for (const c of ciegos) {
          console.log(
            `  [PVI.17] ⚠️ ${c.username} (rol "${c.role_name}") recibe la clave pero NO tiene ` +
              `PRESUPUESTOS_VER: la bandeja no le llega. Se reparte desde /admin/roles si se decide.`,
          );
        }
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
