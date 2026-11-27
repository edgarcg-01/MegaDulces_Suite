'use strict';
/**
 * `[PGP.224]` — **La decisión de Administración o Contabilidad sobre una factura fuera de norma** (anexo NF §3).
 *
 * La norma fiscal del CFDI (`libs/contracts/src/finance/norma-fiscal-cfdi.contract.ts`, `[PGP.223]`) deja dos reglas
 * con salida humana: una recibida con uso S01 (sin efectos fiscales) y una a nuestro nombre con un régimen que no es
 * 612. Esa salida es una persona que dice «se usa» o «no se usa», con su motivo. Basta una firma, de Administración o
 * de Contabilidad (D-NF2, Francisco, 2026-11-26).
 *
 * Es una decisión humana (HITL), no una copia de nada (regla 2): tabla propia. **Una decisión por UUID y por regla**:
 * la S01 y el régimen de la misma factura se deciden aparte, y una regla que aparezca después no queda cubierta.
 * Cambiar de opinión es revocar (UPDATE de `revoked_*`) y decidir otra vez: nada se borra y queda quién y cuándo.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-26) ────────────────────────────────────────────────────────────
 *  · 2026, recibidas tipo I no canceladas: **35 con S01** que piden decisión (sin las 131 de BBVA y Banorte, que el
 *    banco cobra solo, D-NF4) y **33 con régimen ≠ 612** ($469,835; sin las 27 del IMSS, excepción por regla, D-NF3).
 *  · La tabla no existe y nada la lee hoy. La lee el freno del Calendario (`leerNormaDeObligaciones`, `[PGP.225]`);
 *    la escribe la bandeja «Facturas fuera de norma» (`[PGP.229]`).
 *
 * Tabla nueva: `tenant_id` + auditoría + RLS (regla 18). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'cfdi_norm_authorizations';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) {
    await knex.schema.withSchema('finance').createTable(TABLA, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('cfdi_uuid').notNullable();          // fiscal.cfdis.uuid, en minúsculas
      t.text('norm_rule').notNullable();          // la regla que se decide (ReglaNorma)
      t.text('decision').notNullable();           // se_usa | no_se_usa
      t.text('reason').notNullable();             // el motivo, en llano
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by').notNullable();         // quien decidió
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
      t.timestamp('revoked_at', { useTz: true }); // revocada: la factura vuelve a pedir decisión
      t.text('revoked_by');
      t.text('revoke_reason');
    });
  }
  const ck = async (nombre, expr) => {
    await knex.raw(`ALTER TABLE finance.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_${nombre}`);
    await knex.raw(`ALTER TABLE finance.${TABLA} ADD CONSTRAINT ${TABLA}_${nombre} CHECK (${expr})`);
  };
  await ck('uuid_ck', `cfdi_uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`);
  // Sólo las reglas que tienen salida humana (REGLAS_AUTORIZABLES): una cancelada o una PUE de mes anterior no se autorizan.
  await ck('rule_ck', `norm_rule IN ('sin_efectos_fiscales', 'regimen')`);
  await ck('decision_ck', `decision IN ('se_usa', 'no_se_usa')`);
  await ck('reason_ck', `length(btrim(reason)) BETWEEN 3 AND 300`);
  await ck('revoke_ck', `(revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)`);
  // Una sola decisión viva por factura y regla: dos personas a la vez no deciden dos veces.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_viva ON finance.${TABLA} (tenant_id, cfdi_uuid, norm_rule)
                    WHERE revoked_at IS NULL`);
  await knex.raw(`ALTER TABLE finance.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${TABLA}_tenant ON finance.${TABLA}`);
  await knex.raw(`CREATE POLICY ${TABLA}_tenant ON finance.${TABLA} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.${TABLA} TO app_runtime`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): si alguien ya decidió, la tabla se conserva y
 * se dice; sólo vacía se quita.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) return;
  const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM finance.${TABLA}`)).rows[0].n);
  if (n > 0) {
    // eslint-disable-next-line no-console
    console.log(`[PGP.224] finance.${TABLA} tiene ${n} decisión(es) tomadas por personas: se conserva (regla 5).`);
    return;
  }
  await knex.schema.withSchema('finance').dropTableIfExists(TABLA);
};
