'use strict';
/**
 * `[PGP.3]` — **El pago a proveedor ya tiene quién lo prepare y quién lo firme; le faltaba de
 * quién ES.**
 *
 * ── Lo que la motiva, medido en prod el 2026-10-22 ──────────────────────────────────────────
 * (`system_identifier 7688376744939610156`, sólo lectura)
 *
 *     finance.payment_allocations    13 armados · 10 pending · 0 executed
 *     …de los 10 pendientes          10 sin método, sin cuenta de origen y sin destino
 *     finance.payment_calendar_lots   6 lotes, los 6 en 'draft' desde el 16-oct
 *     …autorizados                    0
 *
 * ⭐ **Parecía que faltaba la firma de Dirección. No era eso.** `releaseLot()` rechaza el día
 * entero si alguno de sus pagos pendientes está sin preparar, así que la firma habría devuelto
 * 400. El trabajo detenido es de Tesorería, y **nadie podía enterarse**: el calendario no emite
 * hacia «Mi trabajo», y hay que entrar al módulo para ver que hay seis días muertos adentro.
 *
 * ── Por qué una fila de catálogo y no una pantalla ──────────────────────────────────────────
 * La pantalla ya existe (`/finanzas/calendario-pagos`, Fase TP). `[PGP.3]` registra las dos colas
 * en `BANDEJAS` (`libs/trade/.../me-work.ts`), y `[SN.30]` manda que **una cola sólo se le muestra
 * a quien RESPONDE de ella**. Sin esta fila y sin su reparto, las dos entradas nuevas serían
 * invisibles para todos, en silencio.
 *
 * ── Por qué DOS bandejas con UNA sola clave ─────────────────────────────────────────────────
 * Son dos pasos del mismo trabajo, como `finanzas.presupuesto` (`[PVI.17]`). Con un solo contador
 * de «pagos pendientes del calendario», el **10** de Tesorería tapa el **0** de Dirección — y lo
 * que hay que ver es justamente **de quién es el paso**. La bandeja de firma además sólo cuenta
 * los días que de verdad se pueden autorizar: avisar «tenés 6 esperando tu firma» cuando los 6
 * botones devuelven 400 es peor que no avisar.
 *
 * ── A qué puestos va, y quién la VE de verdad ───────────────────────────────────────────────
 * Medido el 2026-10-22, cruzando puesto → rol → permiso. ⭐ **Cero ciegos**: todos los que
 * reciben la clave tienen el permiso que abre su mitad.
 *
 *     PREPARAN (FINANCE_PAYMENTS_GESTIONAR)              FIRMAN (FINANCE_PAYMENT_CALENDAR_AUTORIZAR)
 *     tesoreria          maria_gutierrez      ✔          direccion   guillermo_lopez  ✔
 *     auxiliar_finanzas  erika_macias         ✔                      superuser        ✔
 *                        ivonne_cruz          ✔
 *                        julio_torres         ✔
 *                        julissa_hernandez    ✔
 *     jefe_finanzas      carmen_rodriguez     ✔
 *                        jesus_carrillo       ✔
 *
 * ⚠️ `maria_gutierrez` (Tesorería) **no** tiene el permiso de firmar, y está bien: es la
 * separación de TP.6 —quien prepara no autoriza—. Recibe la clave porque la cola de «sin
 * preparar» sí es suya.
 *
 * ⛔ **Esto NO otorga permisos.** La responsabilidad dice de quién es el trabajo; el permiso dice
 * si puede abrirlo (`work/task.contract.ts`). Los permisos de un rol se administran desde
 * `/admin/roles`.
 *
 * ── Forma de la fila ────────────────────────────────────────────────────────────────────────
 * `dimension` NULL: el pago a proveedor está centralizado en Tesorería —medido en `[PP]`, el
 * `sucursal` del espejo es 100 % el CEDIS y el almacén del Excel es el centro de costo, no el
 * pagador—, así que no hay eje que acotar y las dos bandejas declaran `acotablePorSucursal:
 * false`. `orden` 19 la deja entre `finanzas.presupuesto` (18, que autoriza la obligación) y
 * `finanzas.acciones` (20): es el paso siguiente del mismo dinero.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] */
const NUEVAS = [
  [
    'finanzas.pagos',
    'Pagos a proveedor por preparar y firmar',
    'Las dos puertas del Calendario de pagos: preparar cada pago (método, cuenta de origen y ' +
      'destino) y autorizar el día completo. Un pago sin preparar impide autorizar su día entero, ' +
      'y sin autorizar Caja General no dispersa nada. Sin dimensión: el pago a proveedor está ' +
      'centralizado en Tesorería.',
    null,
    19,
  ],
];

/**
 * `tesoreria`, `auxiliar_finanzas` y `jefe_finanzas` preparan; `direccion` firma.
 *
 * ⚠️ `auxiliar_contabilidad` queda fuera a propósito aunque tiene `FINANCE_PAYMENTS_GESTIONAR`:
 * contabiliza el pago después, no lo prepara. Sumarlo es una línea el día que se decida; no se
 * asume — mismo criterio que `[PVI.17]` con Tesorería.
 */
const PUESTOS = ['tesoreria', 'auxiliar_finanzas', 'jefe_finanzas', 'direccion'];

/** Qué permiso abre la mitad que le toca a cada puesto. Se usa sólo para el log de visibilidad. */
const PERMISO_DE = {
  tesoreria: 'FINANCE_PAYMENTS_GESTIONAR',
  auxiliar_finanzas: 'FINANCE_PAYMENTS_GESTIONAR',
  jefe_finanzas: 'FINANCE_PAYMENTS_GESTIONAR',
  direccion: 'FINANCE_PAYMENT_CALENDAR_AUTORIZAR',
};

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
  console.log(`  [PGP.3] catálogo: +${NUEVAS.length} responsabilidad (pagos a proveedor)`);

  for (const PUESTO of PUESTOS) {
    const puestos = await knex('identity.positions')
      .where({ code: PUESTO })
      .whereNull('deleted_at')
      .select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [PGP.3] ⚠️ el puesto "${PUESTO}" no existe — no recibe la clave`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      for (const [key] of NUEVAS) {
        const ya = await knex('identity.position_responsibilities')
          .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
          .whereNull('deleted_at')
          .first();
        if (ya) {
          console.log(`  [PGP.3] ${PUESTO} ya responde de "${key}" — sin cambios`);
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
         * silencioso: nadie reporta una caja que no está.
         */
        const permiso = PERMISO_DE[PUESTO];
        const gente = await knex('identity.users as u')
          .leftJoin('identity.role_permissions as rp', 'rp.role_name', 'u.role_name')
          .where({ 'u.tenant_id': tenant_id, 'u.position_code': PUESTO })
          .whereNull('u.deleted_at')
          .select('u.username', 'u.role_name', knex.raw(`(rp.permissions->>'${permiso}') as ve`));

        const ven = gente.filter((g) => g.ve === 'true');
        const ciegos = gente.filter((g) => g.ve !== 'true');
        console.log(
          `  [PGP.3] ${PUESTO} → ${key}  (la VEN ${ven.length} de ${gente.length} con ${permiso}: ${ven.map((g) => g.username).join(', ') || '—'})`,
        );
        for (const c of ciegos) {
          console.log(
            `  [PGP.3] ⚠️ ${c.username} (rol "${c.role_name}") recibe la clave pero NO tiene ` +
              `${permiso}: esa mitad de la bandeja no le llega. Se reparte desde /admin/roles si se decide.`,
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
