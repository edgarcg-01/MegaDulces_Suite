'use strict';
/**
 * `[PQ.110]` — **Cancelar una OC de Kepler desde `/compras/oc-abiertas`: lo que la Suite guarda,
 * el interruptor y la llave.** Nada de esto escribe en Kepler.
 *
 *  1. **`commercial.purchase_order_cancellations`**: un renglón por INTENTO (cancelada o rechazada),
 *     con el motivo que escribió la persona y lo que Kepler PIERDE al cancelar: capturista, fecha y
 *     hora originales (`c67`/`c68`/`c69` se sobrescriben, anexo PQ §3c), total y renglones.
 *  2. **El interruptor** `commercial.kepler_push_switch` admite el tipo `cancela_oc`, sembrado
 *     **apagado** en las nueve sucursales con tope de **1 por día** (el canario, como `cliente`).
 *  3. **La llave** `COMPRAS_OC_CANCELAR` («Cancelar OC en Kepler»): compras, gerente_compras,
 *     auxiliar_compras, compras_operaciones, encargado_tienda (+ superadmin). `COMPRAS_PEDIDO_GESTIONAR`
 *     no sirve: también la tienen marketing, finanzas y tesorería (medido 2026-11-13).
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-13) ──
 *  · `kepler_push_switch_tipo_ck` = compra, traspaso, telemarketing, cliente (36 renglones).
 *  · Los cinco roles existen y tienen `COMPRAS_PEDIDO_GESTIONAR` = true.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pq110_cancelar_oc]';
const TABLA = 'purchase_order_cancellations';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const LLAVE = 'COMPRAS_OC_CANCELAR';
const ROLES = ['compras', 'gerente_compras', 'auxiliar_compras', 'compras_operaciones', 'encargado_tienda', 'superadmin'];
const TIPOS_ANTES = ['compra', 'traspaso', 'telemarketing', 'cliente'];
const marcas = (xs) => xs.map(() => '?').join(',');
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Lo que guarda la Suite ────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable(TABLA))) {
    await knex.schema.withSchema('commercial').createTable(TABLA, (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('sucursal').notNullable();
      t.text('oc_folio').notNullable();
      t.text('motivo').notNullable();
      t.text('estado').notNullable();
      /** Por qué no se canceló (regla, Kepler, permiso). NULL si se canceló. */
      t.text('rechazo');
      /** Lo que Kepler pierde: { serie, estado, total, capturista, fecha_captura, hora_captura, renglones, origen_tipo, origen_folio }. */
      t.jsonb('kepler_original');
      t.text('requisicion_folio');
      t.boolean('requisicion_reabierta').notNullable().defaultTo(false);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.text('created_by_username');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at', { useTz: true });
    });
  }
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_estado_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_estado_ck
                    CHECK (estado IN ('cancelada','rechazada') AND (estado = 'rechazada') = (rechazo IS NOT NULL))`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_suc_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_suc_ck CHECK (sucursal ~ '^[0-9]{2}$')`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_motivo_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_motivo_ck CHECK (length(btrim(motivo)) >= 10)`);
  // Una OC se cancela UNA vez: el segundo intento de cancelarla tiene que fallar, no duplicar.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_una_vez
                    ON commercial.${TABLA} (tenant_id, sucursal, oc_folio)
                    WHERE estado = 'cancelada' AND deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${TABLA}_oc ON commercial.${TABLA} (tenant_id, sucursal, oc_folio, created_at DESC)`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${TABLA}_tenant ON commercial.${TABLA}`);
  await knex.raw(`CREATE POLICY ${TABLA}_tenant ON commercial.${TABLA}
                    USING (tenant_id = current_tenant_id())
                    WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT ON commercial.${TABLA} TO app_runtime`);

  // ── 2. El interruptor ────────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck
                    CHECK (tipo IN (${lista([...TIPOS_ANTES, 'cancela_oc'])}))`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: 'cancela_oc', encendida: false, tope_dia: 1,
      nota: '[PQ.110] Cancelar OC en Kepler desde oc-abiertas: apagada hasta el ensayo verde y los GRANT; canario de 1 por día',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = 'cancela_oc'`);
  console.log(`  ${TAG} interruptor 'cancela_oc': ${sw.n} renglón(es), ${sw.encendidas} encendido(s)`);

  // ── 3. La llave ──────────────────────────────────────────────────────────────────────────
  const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, (role_name IN (${marcas(ROLES)})))
      WHERE permissions -> ?::text IS NULL
        AND role_name NOT LIKE 'retirado%'
        AND deleted_at IS NULL`,
    [LLAVE, ...ROLES, LLAVE],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`,
    [LLAVE],
  );
  // Regla 20: exigida sólo si algún rol existe en esta base (la base vacía del CI no los tiene).
  const { rows: existen } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions WHERE role_name IN (${marcas(ROLES)}) AND role_name <> 'superadmin' AND deleted_at IS NULL`,
    ROLES,
  );
  if (hay.n > 0 && existen.length && !rows.length) throw new Error(`${TAG} Ningun rol (fuera de superadmin) quedo con ${LLAVE} (regla 20)`);
  if (!existen.length) console.log(`  ${TAG} ⚠️ NO MEDIDO: esta base no tiene los roles de compras — ${LLAVE} sólo queda en superadmin.`);
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. La tabla se conserva si ya tiene renglones (regla 5). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: 'cancela_oc' }).del();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(TIPOS_ANTES)}))`);
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM commercial.${TABLA}`).catch(() => ({ rows: [{ n: 0 }] }));
  if (n.n === 0) await knex.raw(`DROP TABLE IF EXISTS commercial.${TABLA}`);
  else console.log(`  ${TAG} ${TABLA} tiene ${n.n} renglón(es): se conserva`);
};
