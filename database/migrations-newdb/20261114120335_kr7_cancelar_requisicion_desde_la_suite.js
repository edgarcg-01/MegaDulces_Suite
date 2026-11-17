'use strict';
/**
 * `[KR.7]` — **Cancelar en Kepler una requisición de compra desde su ficha: lo que la Suite guarda,
 * el interruptor y la llave.** Nada de esto escribe en Kepler. Hermana de `20261113142557` (`[PQ.110]`).
 *
 *  1. **La tabla de intentos de PQ.110 se EXTIENDE, no se copia** (regla 2):
 *     `commercial.purchase_order_cancellations` gana `document_type` (`oc` | `requisicion`, default `oc`:
 *     los renglones y el código de PQ.110 no cambian) y `requisition_id` (la requisición de la Suite).
 *     `oc_folio` deja de ser obligatoria: en un renglón de requisición el folio va en `requisicion_folio`.
 *     Un CHECK amarra cada tipo a sus columnas y un índice único hace que una requisición se cancele UNA vez.
 *     Sin llave foránea a `purchase_requisitions` a propósito: es la tabla más usada de Compras y el
 *     candado de la FK no vale lo que cuida (el servicio sólo escribe el id que acaba de leer).
 *  2. **El interruptor** `commercial.kepler_push_switch` admite `cancela_requisicion`, sembrado **apagado**
 *     en las nueve sucursales con tope de **1 por día** (el canario, como `cancela_oc`).
 *  3. **La llave** `COMPRAS_REQUISICION_CANCELAR` («Cancelar requisición en Kepler») a los mismos seis roles
 *     que `COMPRAS_OC_CANCELAR`. Aparte de esa llave porque su rótulo diría «OC» de algo que no lo es.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-14) ──
 *  · `kepler_push_switch_tipo_ck` = compra, traspaso, telemarketing, cliente, cancela_oc.
 *  · `purchase_order_cancellations`: 0 renglones (PQ.110 encendida en la 08, sin cancelar todavía).
 *  · Los seis roles con `COMPRAS_OC_CANCELAR` tienen `COMPRAS_REQUISICIONES_VER` (abren la ficha) y
 *    `GESTIONAR`; finanzas, marketing y tesorería gestionan requisiciones y NO cancelan OC: no la reciben.
 *  · Requisiciones de la Suite con folio de Kepler: 116 ordered · 86 received · 1 cancelled.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[kr7_cancelar_requisicion]';
const TABLA = 'purchase_order_cancellations';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const LLAVE = 'COMPRAS_REQUISICION_CANCELAR';
const ROLES = ['compras', 'gerente_compras', 'auxiliar_compras', 'compras_operaciones', 'encargado_tienda', 'superadmin'];
const TIPOS_ANTES = ['compra', 'traspaso', 'telemarketing', 'cliente', 'cancela_oc'];
const marcas = (xs) => xs.map(() => '?').join(',');
const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La tabla de PQ.110, extendida ─────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable(TABLA))) {
    throw new Error(`${TAG} falta commercial.${TABLA}: aplica antes 20261113142557 (PQ.110)`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, 'document_type'))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN document_type text NOT NULL DEFAULT 'oc'`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, 'requisition_id'))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN requisition_id uuid`);
  }
  await knex.raw(`ALTER TABLE commercial.${TABLA} ALTER COLUMN oc_folio DROP NOT NULL`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_doc_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_doc_ck
                    CHECK (document_type IN ('oc','requisicion')
                           AND (document_type = 'oc') = (oc_folio IS NOT NULL)
                           AND (document_type = 'oc' OR (requisicion_folio IS NOT NULL AND requisition_id IS NOT NULL)))`);
  // Una requisición se cancela UNA vez (el de la OC no la cubre: su oc_folio es NULL).
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_requisicion_una_vez
                    ON commercial.${TABLA} (tenant_id, sucursal, requisicion_folio)
                    WHERE document_type = 'requisicion' AND estado = 'cancelada' AND deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${TABLA}_requisicion
                    ON commercial.${TABLA} (tenant_id, requisition_id, created_at DESC)
                    WHERE requisition_id IS NOT NULL`);

  // ── 2. El interruptor ────────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  // La lista se DERIVA de lo que la tabla tiene hoy, no de una constante escrita en noviembre:
  // `[PGP.122]` agregó 'solicitud_gasto' el 2026-11-16 y un CHECK con la lista vieja ya no aplica
  // («is violated by some row»). Se conserva todo lo vivo y se suma el tipo nuevo.
  const { rows: tiposHoy } = await knex.raw(`SELECT DISTINCT tipo FROM commercial.kepler_push_switch`);
  const TIPOS = [...new Set([...TIPOS_ANTES, ...tiposHoy.map((r) => r.tipo), 'cancela_requisicion'])].sort();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck
                    CHECK (tipo IN (${lista(TIPOS)}))`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: 'cancela_requisicion', encendida: false, tope_dia: 1,
      nota: '[KR.7] Cancelar requisición en Kepler desde su ficha: apagada hasta su ensayo en esa sucursal; canario de 1 por día',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = 'cancela_requisicion'`);
  console.log(`  ${TAG} interruptor 'cancela_requisicion': ${sw.n} renglón(es), ${sw.encendidas} encendido(s)`);

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

/**
 * Deshace EXACTAMENTE lo que hizo el `up`. Las columnas se conservan si ya hay renglones de requisición
 * (regla 5), y `oc_folio` sólo vuelve a ser obligatoria si ningún renglón la tiene vacía.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: 'cancela_requisicion' }).del();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  const { rows: quedan } = await knex.raw(`SELECT DISTINCT tipo FROM commercial.kepler_push_switch`);
  const TIPOS_DOWN = [...new Set([...TIPOS_ANTES, ...quedan.map((r) => r.tipo)])].filter((t) => t !== 'cancela_requisicion').sort();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista(TIPOS_DOWN)}))`);
  if (!(await knex.schema.withSchema('commercial').hasTable(TABLA))) return;
  const { rows: [n] } = await knex.raw(`SELECT count(*) FILTER (WHERE document_type = 'requisicion')::int n FROM commercial.${TABLA}`)
    .catch(() => ({ rows: [{ n: 0 }] }));
  if (n.n > 0) { console.log(`  ${TAG} ${TABLA} tiene ${n.n} renglón(es) de requisición: se conservan sus columnas`); return; }
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_${TABLA}_requisicion`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_${TABLA}_requisicion_una_vez`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_doc_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN IF EXISTS requisition_id`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN IF EXISTS document_type`);
  const { rows: [v] } = await knex.raw(`SELECT count(*)::int n FROM commercial.${TABLA} WHERE oc_folio IS NULL`);
  if (v.n === 0) await knex.raw(`ALTER TABLE commercial.${TABLA} ALTER COLUMN oc_folio SET NOT NULL`);
};
