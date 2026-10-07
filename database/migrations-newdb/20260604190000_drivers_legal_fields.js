/**
 * J.11.1 — ALTER logistics.drivers para agregar campos legales/IMSS faltantes
 * del Beta v1.
 *
 * Adds: curp, rfc, blood_type, federal_license, hire_date,
 *       base_salary_biweekly, emergency_phone.
 *
 * `emergency_contact` ya existe pero es solo nombre — `emergency_phone` lo
 * complementa con el teléfono.
 *
 * Idempotente (hasColumn antes de addColumn). RLS heredada de la tabla.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('logistics').hasColumn('drivers', col);

  await knex.schema.withSchema('logistics').alterTable('drivers', async (t) => {
    // alterTable knex callback NO permite condicionales async limpios — usamos addColumn
    // crudo afuera del callback. Mantenemos el callback vacío y movemos toda la lógica
    // a raw SQL idempotente para mayor seguridad.
  });

  if (!(await has('curp'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN curp VARCHAR(18)`);
  }
  if (!(await has('rfc'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN rfc VARCHAR(13)`);
  }
  if (!(await has('blood_type'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN blood_type VARCHAR(5)`);
  }
  if (!(await has('federal_license'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN federal_license VARCHAR(50)`);
  }
  if (!(await has('hire_date'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN hire_date DATE`);
  }
  if (!(await has('base_salary_biweekly'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN base_salary_biweekly NUMERIC(12,2)`);
  }
  if (!(await has('emergency_phone'))) {
    await knex.raw(`ALTER TABLE logistics.drivers ADD COLUMN emergency_phone VARCHAR(30)`);
  }

  // CHECK constraint para blood_type (idempotente)
  const checkExists = await knex.raw(`
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drivers_blood_type_check' AND conrelid = 'logistics.drivers'::regclass
  `);
  if (!checkExists.rows.length) {
    await knex.raw(`
      ALTER TABLE logistics.drivers
      ADD CONSTRAINT drivers_blood_type_check
      CHECK (blood_type IS NULL OR blood_type IN ('O+','O-','A+','A-','B+','B-','AB+','AB-'))
    `);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE logistics.drivers DROP CONSTRAINT IF EXISTS drivers_blood_type_check`);
  await knex.schema.withSchema('logistics').alterTable('drivers', (t) => {
    t.dropColumn('emergency_phone');
    t.dropColumn('base_salary_biweekly');
    t.dropColumn('hire_date');
    t.dropColumn('federal_license');
    t.dropColumn('blood_type');
    t.dropColumn('rfc');
    t.dropColumn('curp');
  });
};
