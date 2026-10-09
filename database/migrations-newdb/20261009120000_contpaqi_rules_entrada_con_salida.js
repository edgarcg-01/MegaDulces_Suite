'use strict';
/**
 * `[CP.8.1d]` — **Las dos categorías de ENTRADA que aparecen con salida.**
 *
 * ── El hueco, encontrado ejercitando el armador contra prod ─────────────────────────────────
 * `[CP.8.1c]` sembró las 19 categorías cuyo `flow` es `out` o `both`. Al correr
 * `ContpaqiArmadoService` sobre enero y febrero aparecieron rechazos con un motivo distinto al
 * esperado: *«la categoría "cobranza" no tiene fila en contpaqi.account_rules»*.
 *
 * Medido: **2 categorías de `flow='in'` tienen movimientos con `amount_out > 0`**:
 *
 *     cobranza             79 movimientos
 *     ingreso_devolucion    1 movimiento
 *
 * Son reversos — un cobro que se devuelve sale por el banco. El `flow` del catálogo describe
 * **la intención** de la categoría, no lo que cada movimiento termina haciendo.
 *
 * ⭐ El armador ya los rechazaba correctamente; lo que fallaba era el MOTIVO: decía «no tiene
 * fila» (que suena a dato faltante) en vez de «no tiene regla» (que es la decisión pendiente del
 * contador). Dos estados distintos deben verse distintos.
 *
 * Mismo criterio que `[CP.8.1c]`: `sin_regla`, sin cuenta y sin confianza. La evidencia va en
 * `concepto_medido` como texto.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

const CATEGORIAS = [
  ['cobranza', 'Cobranza (venta cobrada). Es categoria de ENTRADA, pero 79 movimientos salen por '
    + 'el banco: son reversos o devoluciones de un cobro. Probablemente NO deba generar poliza de '
    + 'egreso -- su contrapartida es el ingreso original. Decision del contador.'],
  ['ingreso_devolucion', 'Ingreso por devolucion. 1 movimiento con salida. Mismo caso que cobranza: '
    + 'un reverso de un reingreso previo.'],
];

exports.up = async function up(knex) {
  for (const [code, evidencia] of CATEGORIAS) {
    await knex.raw(
      `INSERT INTO contpaqi.account_rules
         (tenant_id, categoria_code, concepto_medido, cuenta_gasto, cuenta_nombre,
          confianza_pct, estado, medido_en)
       VALUES (?, ?, ?, NULL, NULL, NULL, 'sin_regla', DATE '2026-10-09')
       ON CONFLICT (tenant_id, categoria_code) DO UPDATE
         SET concepto_medido = EXCLUDED.concepto_medido,
             estado          = 'sin_regla',
             updated_at      = now()`,
      [TENANT, code, evidencia],
    );
  }
};

exports.down = async function down(knex) {
  await knex('contpaqi.account_rules').where({ tenant_id: TENANT })
    .whereIn('categoria_code', CATEGORIAS.map(([c]) => c)).del();
};
