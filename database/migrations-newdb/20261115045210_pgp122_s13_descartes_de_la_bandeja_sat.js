'use strict';
/**
 * `[PGP.122]` S.13 — **Los descartes de la bandeja de facturas del SAT** («No es de aquí», anexo S §14, DS23).
 *
 * Una factura recibida del SAT que no se debe registrar por esta puerta la saca una persona, con su motivo, y se puede
 * deshacer. Dos alcances (la revisión independiente encontró que un solo alcance borraba la factura de la sucursal
 * dueña sin dejarle rastro):
 *   · `todas`    — no es un gasto que se registre aquí (no es de la empresa, ya se registró de otra forma, es
 *                  mercancía): sale de todas las bandejas y aparece en «Descartadas» de cada sucursal que la veía.
 *   · `sucursal` — «no es de esta sucursal»: sólo sale de la que lo dijo; sus otras sucursales de historia y 00 la
 *                  siguen viendo, con el aviso.
 * Es una decisión humana (HITL), no una copia de nada (regla 2): tabla propia. `fiscal.cfdi_assignments` liga una
 * factura con UN documento (exige `doc_tipo` y `doc_folio`); usarla para «no es gasto» forzaría su significado.
 *
 * ── Lo medido antes (prod, sólo lectura) ──────────────────────────────────────────────────────────────────────
 *  · 816 facturas de acreedores de gasto desde el corte; 171 por registrar (106 sin sucursal propuesta: las ven
 *    sus 2 sucursales de historia y 00).
 *  · La tabla no existe y nada la lee hoy: la lee y la escribe sólo `FacturasSatService` (S.13.2–S.13.3).
 *
 * Tabla nueva: `tenant_id` + auditoría + RLS (regla 18). Deshacer es un UPDATE (`undone_at`): nada se borra.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'expense_sat_invoice_dismissals';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) {
    await knex.schema.withSchema('finance').createTable(TABLA, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('cfdi_uuid').notNullable();          // fiscal.cfdis.uuid, en minúsculas
      t.text('sucursal').notNullable();           // la bandeja desde la que se descartó
      t.text('scope').notNullable().defaultTo('todas'); // todas | sucursal
      t.text('reason').notNullable();             // el motivo, en llano
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by').notNullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
      t.timestamp('undone_at', { useTz: true });  // deshecho: la factura vuelve a la bandeja
      t.text('undone_by');
    });
  }
  const ck = async (nombre, expr) => {
    await knex.raw(`ALTER TABLE finance.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_${nombre}`);
    await knex.raw(`ALTER TABLE finance.${TABLA} ADD CONSTRAINT ${TABLA}_${nombre} CHECK (${expr})`);
  };
  await ck('uuid_ck', `cfdi_uuid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`);
  await ck('sucursal_ck', `sucursal ~ '^[0-9]{2}$'`);
  await ck('scope_ck', `scope IN ('todas', 'sucursal')`);
  // Desde 00 (que ve todas) «no es de esta sucursal» no tiene sentido: la escondería de quien atiende lo que no tiene dueño.
  await ck('scope_00_ck', `NOT (scope = 'sucursal' AND sucursal = '00')`);
  await ck('reason_ck', `length(btrim(reason)) BETWEEN 3 AND 300`);
  await ck('undo_ck', `(undone_at IS NULL) = (undone_by IS NULL)`);
  // Un solo descarte vivo por factura y alcance: dos personas a la vez no la descartan dos veces.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_todas ON finance.${TABLA} (tenant_id, cfdi_uuid)
                    WHERE undone_at IS NULL AND scope = 'todas'`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_sucursal ON finance.${TABLA} (tenant_id, cfdi_uuid, sucursal)
                    WHERE undone_at IS NULL AND scope = 'sucursal'`);
  await knex.raw(`ALTER TABLE finance.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${TABLA}_tenant ON finance.${TABLA}`);
  await knex.raw(`CREATE POLICY ${TABLA}_tenant ON finance.${TABLA} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.${TABLA} TO app_runtime`);
};

/**
 * Deshace lo que hizo el `up` sin borrar decisiones humanas (regla 5): si alguien ya descartó facturas, la tabla se
 * conserva y se dice; sólo vacía se quita.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) return;
  const n = Number((await knex.raw(`SELECT count(*)::int AS n FROM finance.${TABLA}`)).rows[0].n);
  if (n > 0) {
    // eslint-disable-next-line no-console
    console.log(`[PGP.122 S.13] finance.${TABLA} tiene ${n} descarte(s) hechos por personas: se conserva (regla 5).`);
    return;
  }
  await knex.schema.withSchema('finance').dropTableIfExists(TABLA);
};
