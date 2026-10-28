'use strict';
/**
 * `[PQ.20]` — **Encender y apagar la escritura a Kepler sin desplegar.**
 *
 * Pedido de Edgar (2026-10-28): *«no quiero tener que estar haciendo deploy para apagar o
 * encender la escritura»*. Hasta hoy el interruptor era el secreto k3s `kepler-push`: comentar
 * una línea, recrear el secreto y reiniciar `api` — ~1 min, `ssh` a `md`, y el reinicio tumba
 * las sesiones en curso. Ese mismo día se hizo tres veces (00/04 → los nueve → sin tope).
 *
 * Lo que se separa:
 *  · **Las credenciales se quedan en el secreto** (`KEPLER_PUSH_URL_NN`, plantillas). Una URL con
 *    contraseña no va a una tabla que lee la app.
 *  · **El encendido y el tope viven aquí**, un renglón por (sucursal, tipo). El service lo lee en
 *    cada envío: el cambio vale en el siguiente envío, sin reiniciar.
 *
 * ⛔ Falla cerrada: sin renglón, o `encendida = false`, NO se escribe aunque el secreto tenga la
 * URL. Para no apagar en silencio lo que hoy está encendido, se siembra el estado medido el
 * 2026-10-28 08:35: compra encendida en 00–08 sin tope (pedido de Edgar), traspaso apagado
 * (espera `[PQ.19]` desplegado).
 *
 * `tope_dia` NULL = sin tope (decisión de Edgar). Un entero = máximo de documentos por día en ese
 * servidor, contado en Kepler.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('kepler_push_switch'))) {
    await knex.schema.withSchema('commercial').createTable('kepler_push_switch', (t) => {
      t.uuid('tenant_id').notNullable();
      t.text('sucursal').notNullable();
      t.text('tipo').notNullable();
      t.boolean('encendida').notNullable().defaultTo(false);
      t.integer('tope_dia');
      t.text('nota');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'sucursal', 'tipo']);
    });
  }
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN ('compra','traspaso'))`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_suc_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_suc_ck CHECK (sucursal ~ '^[0-9]{2}$')`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tope_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tope_ck CHECK (tope_dia IS NULL OR tope_dia > 0)`);

  await knex.raw('ALTER TABLE commercial.kepler_push_switch ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.kepler_push_switch FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS kepler_push_switch_tenant ON commercial.kepler_push_switch');
  await knex.raw(`CREATE POLICY kepler_push_switch_tenant ON commercial.kepler_push_switch
                    USING (tenant_id = current_tenant_id())
                    WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON commercial.kepler_push_switch TO app_runtime');

  // El estado vigente al escribir esto. ON CONFLICT DO NOTHING: re-correr no pisa lo que alguien
  // ya cambió desde la pantalla. Con FORCE RLS, el insert necesita el tenant en la sesión.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  const filas = SUCURSALES.flatMap((s) => [
    { tenant_id: TENANT, sucursal: s, tipo: 'compra', encendida: true, tope_dia: null, nota: 'Estado sembrado: compra encendida en los nueve, sin tope (Edgar, 2026-10-28)' },
    { tenant_id: TENANT, sucursal: s, tipo: 'traspaso', encendida: false, tope_dia: null, nota: 'Estado sembrado: traspaso apagado hasta desplegar PQ.19 (unidad base)' },
  ]);
  await knex('commercial.kepler_push_switch').insert(filas).onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.kepler_push_switch');
};
