'use strict';
/**
 * `[SN.36]` — **La cartera de clientes tiene dueño: Crédito y Cobranza.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-22: *«hay que generar el de crédito y cobranza»* — su «Mi trabajo».
 *
 * ── Por qué una fila y no una pantalla ──────────────────────────────────────────────────────
 * La pantalla **ya existe** desde la Fase CXC: `/finanzas/cartera` publica saldo, aging por
 * vencimiento, límite de crédito y compromisos de pago, gateada por `FINANCE_RECEIVABLES_VER`.
 * Y el permiso **ya está repartido**: medido en prod el 2026-09-22, los tres roles que usan
 * estas tres personas (`credito_cobranza`, `finanzas_operativo`) lo tienen en `true`. Lo único
 * que faltaba es de quién ES ese trabajo.
 *
 * Medido en prod el 2026-09-22 (solo lectura):
 *
 *   · El puesto es `auxiliar_credito_cobranza` («Crédito y Cobranza», nivel `operativo`,
 *     reporta a `tesoreria`) y tiene **3 personas**: `gloria_vera`, `paula_alanis`,
 *     `perla_garcia`. Dos entraron esta semana.
 *   · `identity.position_responsibilities` **no le reparte ni una clave**. Por `[SN.30]` su
 *     «Mi trabajo» sale **vacía**, aunque el permiso les abra la cartera entera.
 *   · Y hay trabajo real esperando: **680 clientes con saldo vencido** y **269 que ya pasaron
 *     su línea de crédito** — detectados, sin dueño, **con 0 triageados en 30 días**.
 *   · El vencido medido sobre la vista viva: **$52.7 M en 6,336 documentos de 980 clientes**,
 *     el más viejo con vencimiento del **5-jul-2025**.
 *
 * ── ⛔ Una sola clave para dos bandejas, a propósito ─────────────────────────────────────────
 * «Cobrar lo vencido» y «frenar la venta a crédito de quien ya se pasó» son dos acciones
 * distintas —y por eso son dos renglones en la portada— pero **una sola responsabilidad**: la
 * misma persona responde de las dos y por la misma razón. Partirla en dos claves haría que
 * `/admin/puestos` ofreciera quitarle una y dejarle la otra, que no es una decisión que exista.
 * Precedente: `tienda.caducidades` ya cubre dos bandejas (la propia y la de la sucursal).
 *
 * ── ⛔ Sin dimensión, y no por descuido ──────────────────────────────────────────────────────
 * Los hallazgos SÍ traen sucursal (`entity->>'sucursal'`), así que técnicamente se podría acotar.
 * No se acota porque **estas tres personas cobran de toda la red desde la oficina** — el saldo
 * vive en la sucursal que facturó, no donde se cobra. Acotarlas por su ficha les escondería el
 * 88% del vencido, que está en la sucursal `00`.
 *
 * ⛔ **Esto NO otorga permisos.** `FINANCE_RECEIVABLES_VER` ya existe y ya está repartido.
 *
 * ⚠️ **No se le da a `tesoreria` ni a `jefe_finanzas`** (ambos ocupados) en esta migración: lo
 * que ellos necesitan de cartera es un RESULTADO ($ vencido, % de la cartera), no esta cola de
 * 680 renglones para llamar por teléfono. Su bloque sale de la foto diaria
 * (`analytics.customer_receivable_snapshots`) y espera su propia entrega.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] — mismo formato que `20260922200000`. */
const NUEVAS = [
  [
    'finanzas.cartera',
    'Cartera de clientes',
    'Clientes con saldo vencido por cobrar y clientes que ya pasaron su línea de crédito. ' +
      'Sin dimensión: se cobra de toda la red desde la oficina, no desde la sucursal que facturó.',
    null,
    16,
  ],
];

/** Medido: existe, 3 personas, nivel `operativo`, reporta a `tesoreria`. */
const PUESTO = 'auxiliar_credito_cobranza';

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
  console.log(`  [SN.36] catálogo: +${NUEVAS.length} responsabilidad (cartera de clientes)`);

  const puestos = await knex('identity.positions')
    .where({ code: PUESTO })
    .whereNull('deleted_at')
    .select('tenant_id');
  if (puestos.length === 0) {
    // No se inventa un puesto: sin él la clave queda declarada y sin dueño, y eso se DICE.
    console.log(`  [SN.36] ⚠️ el puesto "${PUESTO}" no existe — la clave queda SIN DUEÑO`);
    return;
  }

  for (const { tenant_id } of puestos) {
    for (const [key] of NUEVAS) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [SN.36] ${PUESTO} ya responde de "${key}" — sin cambios`);
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
        `  [SN.36] ${PUESTO} → ${key}  (la reciben ${gente.length}: ${gente.join(', ') || '—'})`,
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
