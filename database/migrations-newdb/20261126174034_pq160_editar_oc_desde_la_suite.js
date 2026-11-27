'use strict';
/**
 * `[PQ.160]` — **Editar las cantidades de una OC de Kepler desde `/compras/oc-abiertas`: lo que la Suite guarda,
 * el interruptor y la llave.** Nada de esto escribe en Kepler (los permisos de allá están en
 * `ops/prod/kepler-grants/pq160_editar_oc.sql`).
 *
 *  1. **`commercial.purchase_order_edits`**: un renglón por INTENTO (aplicada o rechazada), con el motivo que
 *     escribió la persona, cada renglón antes y después, y el total antes y después. La requisición de la que
 *     salió la OC NO cambia al editarla: esta tabla es lo que explica la diferencia.
 *  2. **El interruptor** `commercial.kepler_push_switch` admite el tipo `edita_oc`, sembrado **apagado** en las
 *     nueve sucursales con tope de 20 por día.
 *  3. **La llave** `COMPRAS_OC_EDITAR` («Editar cantidades de OC en Kepler»): los mismos roles que tienen hoy
 *     `COMPRAS_OC_CANCELAR` (medido 2026-11-26: auxiliar_compras, compras, compras_operaciones, encargado_tienda,
 *     gerente_compras, superadmin), leídos de la base y no escritos aquí.
 *  4. **La primera edición, hecha a mano antes de que existiera esto**: OC 00-0007492 (SALSA MAGA), sus 4
 *     renglones de 120 a 132 cajas, total $109,098.00 → $120,007.80, el 2026-11-26 por pedido de Edgar. Se
 *     registra para que la diferencia con su requisición (RQ-2026-03481) tenga motivo. Sólo donde está la réplica
 *     de Kepler con esa OC (prod); en una base vacía no hace nada.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-26) ──
 *  · `kepler_push_switch_tipo_ck` admite 13 tipos; esta migración los LEE de la restricción y agrega
 *    `edita_oc` (no los copia a mano: PQ.110 los escribió a mano y la lista ya cambió cinco veces).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pq160_editar_oc]';
const TABLA = 'purchase_order_edits';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const LLAVE = 'COMPRAS_OC_EDITAR';
const MOLDE = 'COMPRAS_OC_CANCELAR';
const TIPO = 'edita_oc';

/** Los tipos que hoy acepta el interruptor, leídos de su restricción. */
async function tiposActuales(knex) {
  const { rows } = await knex.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'kepler_push_switch_tipo_ck'`);
  if (!rows.length) return null;
  return [...rows[0].d.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}
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
      /** Por qué no se aplicó (regla, Kepler, permiso). NULL si se aplicó. */
      t.text('rechazo');
      /** [{ renglon, sku, unidad, antes, despues, importe_antes, importe_despues }] */
      t.jsonb('cambios').notNullable().defaultTo(knex.raw(`'[]'::jsonb`));
      t.decimal('total_antes', 14, 2);
      t.decimal('total_despues', 14, 2);
      /** `suite` = desde el apartado · `a_mano` = escrita en Kepler antes del apartado, registrada después. */
      t.text('origen').notNullable().defaultTo('suite');
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
                    CHECK (estado IN ('aplicada','rechazada') AND (estado = 'rechazada') = (rechazo IS NOT NULL))`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_suc_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_suc_ck CHECK (sucursal ~ '^[0-9]{2}$')`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_motivo_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_motivo_ck CHECK (length(btrim(motivo)) >= 10)`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_origen_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_origen_ck CHECK (origen IN ('suite','a_mano'))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${TABLA}_oc ON commercial.${TABLA} (tenant_id, sucursal, oc_folio, created_at DESC)`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS ${TABLA}_tenant ON commercial.${TABLA}`);
  await knex.raw(`CREATE POLICY ${TABLA}_tenant ON commercial.${TABLA}
                    USING (tenant_id = current_tenant_id())
                    WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT ON commercial.${TABLA} TO app_runtime`);

  // ── 2. El interruptor ────────────────────────────────────────────────────────────────────
  const tipos = await tiposActuales(knex);
  if (!tipos) throw new Error(`${TAG} no existe kepler_push_switch_tipo_ck: ¿falta la migración de PQ.110?`);
  if (!tipos.includes(TIPO)) {
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT kepler_push_switch_tipo_ck`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista([...tipos, TIPO])}))`);
  }
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: TIPO, encendida: false, tope_dia: 20,
      nota: '[PQ.160] Editar cantidades de OC en Kepler desde oc-abiertas: apagada hasta los GRANT y el ensayo verde',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  console.log(`  ${TAG} interruptor '${TIPO}': ${sw.n} renglón(es), ${sw.encendidas} encendido(s) · tipos: ${tipos.length} → ${tipos.includes(TIPO) ? tipos.length : tipos.length + 1}`);

  // ── 3. La llave: los roles que ya cancelan OC ─────────────────────────────────────────────
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, coalesce(permissions -> ?::text = 'true'::jsonb, false))
      WHERE permissions -> ?::text IS NULL AND role_name NOT LIKE 'retirado%' AND deleted_at IS NULL`,
    [LLAVE, MOLDE, LLAVE]);
  const { rows } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`, [LLAVE]);
  const { rows: [molde] } = await knex.raw(
    `SELECT count(*)::int n FROM identity.role_permissions
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL`, [MOLDE]);
  // Regla 20: si algún rol cancela OC, alguno tiene que poder editarla.
  if (molde.n > 0 && !rows.length) throw new Error(`${TAG} Ningún rol (fuera de superadmin) quedó con ${LLAVE} (regla 20)`);
  if (!molde.n) console.log(`  ${TAG} ⚠️ NO MEDIDO: esta base no tiene roles con ${MOLDE} — ${LLAVE} sólo queda donde ya estaba.`);
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);

  // ── 4. La primera edición, hecha a mano (sólo si la réplica tiene esa OC ya editada) ─────────
  const ods = (await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0].t;
  const esa = ods ? (await knex.raw(
    `SELECT 1 FROM kepler_ods.kdm1 WHERE sucursal = '00' AND c2 = 'X' AND c3 = 'A' AND c4::numeric = 35 AND btrim(c6) = '0007492'
        AND round(c16::numeric, 2) = 120007.80`)).rows.length : 0;
  const ya = await knex(`commercial.${TABLA}`).where({ tenant_id: TENANT, sucursal: '00', oc_folio: '0007492', origen: 'a_mano' }).first('id');
  if (esa && !ya) {
    const ren = (renglon, sku, costo) => ({
      renglon, sku, unidad: 'CJA', antes: 120, despues: 132,
      importe_antes: Math.round(120 * costo * 100) / 100, importe_despues: Math.round(132 * costo * 100) / 100,
    });
    await knex(`commercial.${TABLA}`).insert({
      tenant_id: TENANT, sucursal: '00', oc_folio: '0007492', estado: 'aplicada', origen: 'a_mano',
      motivo: 'Edgar pidió el 2026-11-26 ampliar la orden 12 cajas por SKU, antes de que llegue nada. Escrita en Kepler con un script con guardas (ensayo en seco primero) porque el apartado aún no existía.',
      cambios: JSON.stringify([ren(1, '99069', 223.98), ren(2, '99124', 276.01), ren(3, '99125', 204.58), ren(4, '99126', 204.58)]),
      total_antes: 109098.00, total_despues: 120007.80,
      created_by_username: 'edgar',
    });
    console.log(`  ${TAG} registrada la edición a mano de la OC 00-0007492 (120 → 132 cajas, $109,098.00 → $120,007.80)`);
  } else {
    console.log(`  ${TAG} edición a mano de 00-0007492: ${ya ? 'ya estaba registrada' : 'no aplica en esta base (sin réplica de esa OC editada)'}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`. La tabla se conserva si ya tiene renglones de la Suite (regla 5). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: TIPO }).del();
  const tipos = await tiposActuales(knex);
  if (tipos && tipos.includes(TIPO)) {
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT kepler_push_switch_tipo_ck`);
    await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(tipos.filter((t) => t !== TIPO))}))`);
  }
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM commercial.${TABLA} WHERE origen = 'suite'`).catch(() => ({ rows: [{ n: 0 }] }));
  if (n.n === 0) await knex.raw(`DROP TABLE IF EXISTS commercial.${TABLA}`);
  else console.log(`  ${TAG} ${TABLA} tiene ${n.n} edición(es) desde la Suite: se conserva`);
};
