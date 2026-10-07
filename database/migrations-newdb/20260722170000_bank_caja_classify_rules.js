/**
 * CB.9.2 — Reglas iniciales para los patrones de CAJA GENERAL (ADR-033).
 *
 * Al entrar CAJA GENERAL al cuadre (CB.9.2) subió el sin_clasificar (~14.7%):
 * trae conceptos que no existían en las hojas de banco (intereses, abonos a
 * préstamo, tarjeta de crédito, refrendos, viáticos, comisiones de venta…).
 * Este set inicial los clasifica; Edgar los afina en Admin (son editables).
 *
 * Regla de orden: prioridad 160+ (después de las reglas de banco 10-151) para que
 * las específicas de banco/612 ganen primero. Los ingresos (M=I / código 102) ya
 * se clasifican en prioridad 61/70 → estas reglas de concepto solo atrapan gastos.
 *
 * Categoría NUEVA: `comisiones_venta` (comisiones a vendedores/TLMK/rutas — NO es
 * comisión bancaria). kepler_account queda NULL: Edgar confirma la cuenta contable.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

// priority, match_type, match_code, match_concept, category_code, note
const RULES = [
  [160, null, null, 'PAGO INTERES|INTERESES?\\b|ABONO AL? PRESTAMO|ABONO PRESTAMO', 'pago_credito', 'Intereses / abonos a préstamo (CAJA)'],
  [161, null, null, '\\bTDC\\b|\\bAMEX\\b|AMERICAN EXPRESS|CONSUMOS TDC', 'compra_tarjeta', 'Pago de tarjeta de crédito (CAJA)'],
  [162, null, null, 'REFRENDO', 'impuestos', 'Refrendo vehicular = impuesto (CAJA)'],
  [163, null, null, 'VIATICOS|VIÁTICOS|TRANSPORTE PERSONAL|TRANSPORTE DE PERSONAL|REGALOS|POSADA|\\bBONO\\b', 'gasto_admin', 'Viáticos / transporte / regalos / bonos (CAJA)'],
  [164, null, null, 'COMISION|COMISIÓN|COMISIONES', 'comisiones_venta', 'Comisión a vendedores/TLMK/rutas — NO bancaria (CAJA)'],
];

exports.up = async function (knex) {
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);

  // Categoría nueva (idempotente). kepler_account NULL → Edgar la confirma en Admin.
  const maxSort = Number((await knex('finance.movement_categories').where({ tenant_id: MEGA }).max('sort_order as m').first())?.m || 0);
  await knex.raw(
    `INSERT INTO finance.movement_categories (tenant_id, code, name, flow, kepler_account, group_key, kepler_note, sort_order)
     VALUES (?, 'comisiones_venta', 'Comisiones de venta/operación', 'out', NULL, 'gasto', 'Comisiones a vendedores/TLMK/rutas. Cuenta Kepler por confirmar.', ?)
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [MEGA, maxSort + 10],
  );

  for (const [priority, mType, mCode, mConcept, category, note] of RULES) {
    await knex.raw(
      `INSERT INTO finance.bank_classify_rules
         (tenant_id, priority, match_type, match_code, match_concept, category_code, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, priority) DO NOTHING`,
      [MEGA, priority, mType, mCode, mConcept, category, note],
    );
  }
};

exports.down = async function (knex) {
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
  await knex('finance.bank_classify_rules').where({ tenant_id: MEGA }).whereIn('priority', RULES.map((r) => r[0])).del();
  // La categoría comisiones_venta se conserva (puede tener movimientos clasificados).
};
