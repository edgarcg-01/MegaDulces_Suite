'use strict';
/**
 * `[BFU.4.5.1]` — **Cada categoría de Bancos tiene un área dueña** (anexo BFU, BFU.4.5 desglosado; Edgar, 2026-11-23:
 * «que cada departamento pueda observar los movimientos y ligarlos a sus respectivos movimientos»).
 *
 * `finance.movement_categories.owner_department_code` → `identity.departments.code` (la misma llave en texto que ya usan
 * `identity.users` y `servicedesk.queues`). Es el parámetro que decide a qué área le llega un movimiento sin explicar:
 * el motor de categoría hoy dice «responsable: el área» sin decir cuál (`motor-de-categoria.ts`, BFU.4.5.2 lo resuelve
 * con esta columna). Se extiende el catálogo que existe; no se copia nada.
 *
 * Una categoría sin departamento que la reciba **no se asigna a uno inventado**: queda con el área nula y la pregunta
 * escrita en `owner_note` (el parámetro dice qué le falta). Mientras, la asigna Tesorería (BFU.4.5).
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-23) ──────────────────────────────────
 *  · Los 9 departamentos del mapa existen en `identity.departments` del tenant; no hay «Comercial» ni «Dirección».
 *  · Noviembre 1–23, 3,934 movimientos, simulando este mapa: Cobranza 1,978 · Contabilidad 1,164 · Tesorería 273 (+65
 *    sin categoría, que también son suyos) · Compras 184 · RH 68 · Logística 47 · Administración 32 · Mercadotecnia 4 ·
 *    Sistemas 2 · **sin área 117** (gasto de venta 115, gasto de dirección 2; todos con documento de Kepler). Suma = 3,934.
 *  · `finance.movement_categories` tiene un solo tenant.
 *
 * Aditiva e idempotente: dos columnas nulas, y sólo llena las que siguen nulas (un cambio hecho después en Admin no se
 * pisa al re-correr). La API desplegada no las lee.
 *
 * @param { import("knex").Knex } knex
 */

// categoría → departamento (identity.departments.code)
const MAPA = [
  ['cobranza', 'credito_cobranza'],
  ['compra_mercancia', 'compras'], ['gasto_logistico_compras', 'compras'], ['anticipo_proveedor', 'compras'],
  ['nomina', 'rh'], ['imss_sua', 'rh'], ['pension_alimenticia', 'rh'], ['caja_ahorro', 'rh'],
  ['gasto_logistico', 'logistica'],
  ['renta', 'administracion'], ['servicios', 'administracion'], ['gasto_local', 'administracion'],
  ['gasto_admin', 'administracion'], ['mobiliario_equipo', 'administracion'], ['papeleria', 'administracion'],
  ['tecnologia', 'sistemas'],
  ['publicidad', 'mercadotecnia'],
  ['comision_bancaria', 'contabilidad'], ['iva_acreditable', 'contabilidad'], ['impuestos', 'contabilidad'],
  ['gasto_contable', 'contabilidad'], ['no_deducible', 'contabilidad'],
  ['traspaso_entre_cuentas', 'tesoreria'], ['sin_clasificar', 'tesoreria'], ['compra_tarjeta', 'tesoreria'],
  ['pago_credito', 'tesoreria'], ['activo_fijo', 'tesoreria'], ['gasto_financiero', 'tesoreria'],
  ['devolucion_spei', 'tesoreria'], ['compra_factoraje', 'tesoreria'], ['pago_factoraje', 'tesoreria'],
  ['traslado_valores', 'tesoreria'],
];

// Lo que no tiene a quién ir: la pregunta queda en la fila.
const POR_DEFINIR = [
  ['gasto_venta', 'Por definir: no hay departamento «Comercial» en identity.departments. Mientras, la asigna Tesorería.'],
  ['comisiones_venta', 'Por definir: no hay departamento «Comercial» en identity.departments. Mientras, la asigna Tesorería.'],
  ['gasto_direccion', 'Por definir: no hay departamento «Dirección» en identity.departments. Mientras, la asigna Tesorería.'],
  ['otros_gastos', 'Por definir: «otros gastos» no dice de qué área es. Mientras, la asigna Tesorería.'],
  ['ingreso_devolucion', 'Por definir: ¿devolución de proveedor (Compras) o de cliente (Cobranza)? Mientras, la asigna Tesorería.'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const fin = () => knex.schema.withSchema('finance');
  if (!(await fin().hasColumn('movement_categories', 'owner_department_code'))) {
    await knex.raw(`ALTER TABLE finance.movement_categories ADD COLUMN owner_department_code text`);
  }
  if (!(await fin().hasColumn('movement_categories', 'owner_note'))) {
    await knex.raw(`ALTER TABLE finance.movement_categories ADD COLUMN owner_note text`);
  }
  await knex.raw(`COMMENT ON COLUMN finance.movement_categories.owner_department_code IS
    '[BFU.4.5.1] Área que explica los movimientos de esta categoría (identity.departments.code). Nula = por definir; la asigna Tesorería.'`);

  for (const [code, dep] of MAPA) {
    await knex.raw(`
      UPDATE finance.movement_categories mc
         SET owner_department_code = :dep, updated_at = now()
       WHERE mc.code = :code
         AND mc.owner_department_code IS NULL
         AND EXISTS (SELECT 1 FROM identity.departments d
                      WHERE d.tenant_id = mc.tenant_id AND d.code = :dep AND d.deleted_at IS NULL)`, { code, dep });
  }
  for (const [code, note] of POR_DEFINIR) {
    await knex.raw(`
      UPDATE finance.movement_categories
         SET owner_note = :note, updated_at = now()
       WHERE code = :code AND owner_department_code IS NULL AND owner_note IS NULL`, { code, note });
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: se niega si alguien ya cambió un área a mano. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasColumn('movement_categories', 'owner_department_code'))) return;
  const esperado = new Map(MAPA);
  const { rows } = await knex.raw(`
    SELECT code, owner_department_code FROM finance.movement_categories WHERE owner_department_code IS NOT NULL`);
  const tocadas = rows.filter((r) => esperado.get(r.code) !== r.owner_department_code);
  if (tocadas.length > 0) {
    throw new Error(`[BFU.4.5.1] ${tocadas.length} categorías tienen un área puesta después (${tocadas.map((r) => r.code).join(', ')}): no se deshace sin perderla`);
  }
  await knex.raw(`ALTER TABLE finance.movement_categories DROP COLUMN IF EXISTS owner_note`);
  await knex.raw(`ALTER TABLE finance.movement_categories DROP COLUMN IF EXISTS owner_department_code`);
};
