/**
 * CB.9.3 — Corrige los mapeos que producían FALSOS positivos en la conciliación
 * vs Kepler (validado contra la balanza real de enero 2026):
 *
 *  1. imss_sua: mayor 762 → 601. La balanza NO tiene el 762 ($0): en Kepler el
 *     IMSS/SUA vive en el 601 junto con nómina. Con 762 el diagnóstico marcaba
 *     dos falsos: "IMSS: banco pagó +$1.05M" y "Nómina: Kepler +$919k" — que son
 *     la MISMA cuenta. Colapsados en 601: banco $4.55M vs Kepler $4.42M → Δ ~$129k.
 *     (El 122 IVA acreditable se excluye por código en reconciliation(): NON_CASH.)
 *
 *  2. Reglas de clasificación seguras (prio 170+) para patrones INEQUÍVOCOS que
 *     caían en sin_clasificar. Se dejan FUERA a propósito los nombres de personas /
 *     familia (código 613), PRESTAMO PERSONAL, AUTOMOTORES/TOYOCAMION (posible
 *     capex vehicular) y NUEVA WALMART: requieren criterio de negocio de Edgar.
 *
 * Idempotente: UPDATE por code; reglas ON CONFLICT (tenant, priority) DO NOTHING.
 * NO reclasifica movimientos: eso lo hace reclassifyAll tras aplicar (o el próximo import).
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

// priority, match_type, match_code, match_concept, category_code, note
const SAFE_RULES = [
  [170, null, null, '\\bSAT\\b',                          'impuestos',  'Pago SAT (concepto directo)'],
  [171, null, null, '\\bPEAJE\\b|\\bCASETA(S)?\\b',       'gasto_admin', 'Peaje / casetas'],
  [172, null, null, 'QUALITAS|ASEGURAD|\\bSEGURO(S)?\\b|POLIZA DE SEGURO', 'gasto_admin', 'Seguros'],
  [173, null, null, 'CAJA CHICA|REPOSICION (DE )?CAJA',   'gasto_admin', 'Reposición de caja chica'],
  [174, null, null, 'VERIFICACION (VEHIC|HUMO)|VERIFICACION AMBIENTAL', 'gasto_admin', 'Verificación vehicular'],
];

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('movement_categories'))) return;
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);

  // 1. Remap IMSS 762 → 601 (idempotente: solo si sigue en 762).
  await knex.raw(
    `UPDATE finance.movement_categories
       SET kepler_account = '601',
           kepler_note = 'Cuota IMSS/SUA; en Kepler vive en 601 (mayor 762 está en $0). Corregido CB.9.3',
           updated_at = now()
     WHERE tenant_id = ? AND code = 'imss_sua' AND kepler_account = '762'`,
    [MEGA],
  );

  // 2. Reglas seguras.
  for (const [priority, mType, mCode, mConcept, category, note] of SAFE_RULES) {
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
  await knex.raw(
    `UPDATE finance.movement_categories SET kepler_account = '762', updated_at = now()
     WHERE tenant_id = ? AND code = 'imss_sua' AND kepler_account = '601'`,
    [MEGA],
  );
  await knex('finance.bank_classify_rules').where({ tenant_id: MEGA })
    .whereIn('priority', SAFE_RULES.map((r) => r[0])).del();
};
