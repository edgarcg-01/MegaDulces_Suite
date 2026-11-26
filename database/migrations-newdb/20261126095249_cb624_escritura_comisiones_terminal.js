'use strict';
/**
 * `[CB.62.4]` — **La Suite escribe en Kepler las comisiones de la terminal: los dos diales y la bitácora.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md` §9.5. El escritor no inventa documentos:
 * encadena los tres que ya existen (`[PGP.122]` solicitud `X-A-15`, `[PGP.123]` gasto `X-A-10`, `[PGP.106]`
 * pago `X-D-26`). Esta migración NO enciende nada: deja los diales apagados.
 *
 * ── 1. El dial de D3: CUENTA por cuenta, y con FECHA ────────────────────────────────────────────────────────
 * D3 (firmado por Edgar el 2026-11-10) dice que el cambio de manos va cuenta por cuenta, empezando por BBVA
 * 4885. Por eso el dial vive en `finance.bank_accounts`, no en el interruptor por sucursal: una misma cuenta
 * sirve a varias sucursales.
 *
 * ⭐ Y es una FECHA, no un sí/no: `comisiones_kepler_desde` dice **desde cuándo** las comisiones de esa cuenta
 * las escribe la Suite. Un interruptor booleano habría escrito también el atraso —los cargos viejos que Finanzas
 * ya tiene a medio capturar— y habría duplicado justo lo que los tres candados intentan evitar. Con la fecha,
 * un cargo anterior al cambio de manos no es trabajo de la Suite y se ve así en la pantalla.
 * `NULL` = apagada (el default, y lo que queda en las 20 cuentas).
 *
 * ── 2. El dial por sucursal: el interruptor que ya existe ───────────────────────────────────────────────────
 * `commercial.kepler_push_switch` gana el tipo `comisiones_terminal`, sembrado APAGADO en 01–08. CEDIS (`00`)
 * no lleva renglón: sus cuotas de banco son otra forma de gasto (203 / 702-002), fuera de CB.62.
 *
 * ── 3. La bitácora: un renglón por DÍA DE VENTA ─────────────────────────────────────────────────────────────
 * `finance.bank_commission_kepler_days` es el reclamo atómico y lo que pasó. El grano es el del gasto en Kepler
 * (sucursal × acreedor × día de venta), que es la llave que el armador ya usa. Guarda los tres folios porque
 * entre el COMMIT y el ODS pasan minutos: sin ellos la pantalla no sabría qué escribió.
 *
 * ⛔ `en_duda` es un estado, no un error: el COMMIT salió y la respuesta no volvió. NO se reintenta sin buscar
 *    antes los documentos en Kepler (por la marca de la solicitud, que es determinista por día).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** 01–08: cada sucursal captura sus comisiones en su propio Kepler. CEDIS (00) queda fuera de CB.62. */
const SUCURSALES = ['01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'comisiones_terminal';

/** Los tipos que hoy acepta el CHECK, leídos de la propia restricción: no se reescribe una lista de memoria. */
async function tiposActuales(knex) {
  const { rows } = await knex.raw(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'commercial.kepler_push_switch'::regclass AND conname = 'kepler_push_switch_tipo_ck'`);
  if (!rows.length) return [];
  return [...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
}

async function rehacerCheck(knex, tipos) {
  const lista = tipos.map((t) => `'${t.replace(/[^a-z_]/g, '')}'`).join(',');
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista}))`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El dial de D3, en la cuenta ───────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasColumn('bank_accounts', 'comisiones_kepler_desde'))) {
    await knex.schema.withSchema('finance').alterTable('bank_accounts', (t) => {
      t.date('comisiones_kepler_desde');
      t.uuid('comisiones_kepler_set_by');
      t.timestamp('comisiones_kepler_set_at', { useTz: true });
    });
  }
  await knex.raw(`COMMENT ON COLUMN finance.bank_accounts.comisiones_kepler_desde IS
    '[CB.62.4] D3: desde qué día las comisiones de esta cuenta las escribe la Suite en Kepler. NULL = las sigue capturando Finanzas a mano. Un cargo anterior a esta fecha no se escribe.'`);

  // ── 2. El dial por sucursal ──────────────────────────────────────────────────────────────────────────────
  const tipos = await tiposActuales(knex);
  if (tipos.length && !tipos.includes(TIPO)) await rehacerCheck(knex, [...tipos, TIPO]);

  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: TIPO, encendida: false, tope_dia: null,
      nota: 'Nace apagado (CB.62.4). Se enciende por sucursal DESPUÉS del ensayo verde, y sólo escribe las cuentas con comisiones_kepler_desde puesta (D3).',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();

  // ── 3. La bitácora por día de venta ──────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('bank_commission_kepler_days'))) {
    await knex.schema.withSchema('finance').createTable('bank_commission_kepler_days', (t) => {
      t.uuid('tenant_id').notNullable();
      /** El servidor de Kepler donde se captura (`md_NN`): la sucursal del depósito `U-A-5`. */
      t.text('sucursal').notNullable();
      /** `kdm1.c9` del gasto: el día de VENTA, no el del cargo en el banco. */
      t.date('dia_venta').notNullable();
      /** `kdm1.c10`: el banco como acreedor (`GB004`…). */
      t.text('acreedor').notNullable();
      /** La cuenta de los cargos (`bank_accounts.account_label`): el grano del dial de D3. */
      t.text('cuenta');
      t.text('estado').notNullable().defaultTo('pendiente');
      /** Los tres folios de Kepler, en el orden en que se escriben. */
      t.text('solicitud_folio');
      t.text('gasto_folio');
      /** `[{cargo, folio}]`: un `X-D-26` por cargo del banco. */
      t.jsonb('pagos').notNullable().defaultTo('[]');
      t.decimal('total', 14, 2);
      t.decimal('iva', 14, 2);
      t.integer('cargos');
      t.integer('intentos').notNullable().defaultTo(0);
      /** Por qué no se escribió, o qué pasó: se lee en la pantalla, en llano. */
      t.text('nota');
      t.timestamp('next_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'sucursal', 'dia_venta', 'acreedor']);
    });
  }
  await knex.raw(`ALTER TABLE finance.bank_commission_kepler_days DROP CONSTRAINT IF EXISTS bank_commission_kepler_days_estado_ck`);
  await knex.raw(`ALTER TABLE finance.bank_commission_kepler_days ADD CONSTRAINT bank_commission_kepler_days_estado_ck
    CHECK (estado IN ('pendiente','escribiendo','escrito','en_duda','rechazado','reintento'))`);
  await knex.raw(`ALTER TABLE finance.bank_commission_kepler_days DROP CONSTRAINT IF EXISTS bank_commission_kepler_days_suc_ck`);
  await knex.raw(`ALTER TABLE finance.bank_commission_kepler_days ADD CONSTRAINT bank_commission_kepler_days_suc_ck CHECK (sucursal ~ '^[0-9]{2}$')`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS bank_commission_kepler_days_pendientes_idx
    ON finance.bank_commission_kepler_days (tenant_id, estado, next_at)`);

  await knex.raw('ALTER TABLE finance.bank_commission_kepler_days ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE finance.bank_commission_kepler_days FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS bank_commission_kepler_days_tenant ON finance.bank_commission_kepler_days');
  await knex.raw(`CREATE POLICY bank_commission_kepler_days_tenant ON finance.bank_commission_kepler_days
                    USING (tenant_id = current_tenant_id())
                    WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON finance.bank_commission_kepler_days TO app_runtime');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.schema.withSchema('finance').dropTableIfExists('bank_commission_kepler_days');

  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tenant_id: TENANT, tipo: TIPO }).del();
  const tipos = (await tiposActuales(knex)).filter((t) => t !== TIPO);
  if (tipos.length) await rehacerCheck(knex, tipos);

  if (await knex.schema.withSchema('finance').hasColumn('bank_accounts', 'comisiones_kepler_desde')) {
    await knex.schema.withSchema('finance').alterTable('bank_accounts', (t) => {
      t.dropColumn('comisiones_kepler_desde');
      t.dropColumn('comisiones_kepler_set_by');
      t.dropColumn('comisiones_kepler_set_at');
    });
  }
};
