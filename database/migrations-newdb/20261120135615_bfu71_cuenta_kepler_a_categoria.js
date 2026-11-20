'use strict';
/**
 * `[BFU.7.1]` — **La categoría de un movimiento del banco sale de la cuenta contable de Kepler** (motor de categoría,
 * anexo BFU E7; Edgar, 2026-11-20: «no necesito parches, necesito un motor que cubra el 100 %»).
 *
 * `finance.category_kepler_accounts`: prefijo de cuenta de Kepler (`kdc126.c1`: `611-003`, `601`…) → categoría de
 * Bancos; gana el prefijo MÁS LARGO (`611-003` comisión bancaria antes que `611` gasto de venta). Es dato propio (la
 * decisión contable de a qué categoría va cada cuenta), no una copia: el catálogo de cuentas sigue en `kepler_ods`.
 *
 * Y las categorías que faltaban para que toda cuenta de gasto tenga a dónde ir, con el NOMBRE del mayor en Kepler
 * (`kdc126`), no inventado: 514 logística de compras, 602 logística, 603 local, 604 mobiliario, 605/613 tecnología,
 * 606 publicidad, 607 contables, 609 dirección, 610 papelería, 611 venta, 612 no deducibles, 659 otros, 702
 * financieros; 150/160 activo y 107 anticipos (grupo `financiero`: no son gasto del periodo).
 *
 * ── Lo medido antes (sólo lectura, pg-prod, 2026-11-20) ─────────────────────────────────────
 *  · Control contra el árbitro (la categoría que Tesorería puso en el libro, ago–oct 2026, categorías del mismo
 *    significado): 3,994 retiros casados con su documento; el mapeo coincide en 93.6 %; con los documentos BARAJADOS
 *    entre movimientos, 36.4 % (placebo). Por pase: exacto 93.2 %, tolerancia 97.5 %, cruzado 87.7 %.
 *  · Noviembre: de 148 retiros sin categoría, 67 tienen cuenta de Kepler y les faltaba sólo este mapeo.
 *
 * `[BFU.7.4]` Y en `finance.bank_movements`, lo que deja el motor en cada renglón de la descarga: `category_reason` (el
 * motivo, de una lista cerrada, cuando NO hay categoría: nunca un «sin clasificar» mudo) y `category_evidence` (de dónde
 * salió: fuente, cuenta de Kepler, departamento, documentos, pase, responsable). Columnas nulas: se agregan sin reescribir.
 *
 * Aditiva e idempotente: tabla nueva, columnas nulas y filas que no existían; la API desplegada no las lee.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

// code, nombre (del mayor en Kepler), group_key, kepler_account, sort_order
const CATEGORIAS = [
  ['gasto_logistico_compras', 'Gastos logísticos de compras', 'gasto', '514', 181],
  ['gasto_logistico', 'Gastos logísticos', 'gasto', '602', 182],
  ['gasto_local', 'Gastos de local', 'gasto', '603', 183],
  ['mobiliario_equipo', 'Gastos en mobiliario y equipo', 'gasto', '604', 184],
  ['tecnologia', 'Gasto en tecnología', 'gasto', '605/613', 185],
  ['publicidad', 'Publicidad y promoción', 'gasto', '606', 186],
  ['gasto_contable', 'Gastos contables', 'gasto', '607', 187],
  ['gasto_direccion', 'Gastos de dirección', 'gasto', '609', 188],
  ['papeleria', 'Papelería', 'gasto', '610', 189],
  ['gasto_venta', 'Gastos de venta', 'gasto', '611', 190],
  ['no_deducible', 'Otros gastos no deducibles', 'gasto', '612', 191],
  ['otros_gastos', 'Otros gastos', 'gasto', '659', 192],
  ['gasto_financiero', 'Gastos financieros', 'gasto', '702', 193],
  ['activo_fijo', 'Activo fijo', 'financiero', '150/160', 194],
  ['anticipo_proveedor', 'Anticipo a proveedores', 'financiero', '107', 195],
];

// prefijo de cuenta de Kepler → categoría (gana el más largo). Las subcuentas por su nombre en kdc126.
const MAPA = [
  ['511', 'compra_mercancia'], ['201', 'compra_mercancia'], ['514', 'gasto_logistico_compras'],
  ['601', 'nomina'], ['601-013', 'caja_ahorro'], ['601-015', 'imss_sua'], ['762', 'imss_sua'],
  ['602', 'gasto_logistico'], ['603', 'gasto_local'], ['603-001', 'renta'],
  ['603-002', 'servicios'], ['603-003', 'servicios'], ['603-004', 'servicios'], ['603-005', 'servicios'],
  ['604', 'mobiliario_equipo'], ['605', 'tecnologia'], ['613', 'tecnologia'], ['606', 'publicidad'],
  ['607', 'gasto_contable'], ['608', 'gasto_admin'], ['609', 'gasto_direccion'], ['610', 'papeleria'],
  ['611', 'gasto_venta'], ['611-003', 'comision_bancaria'], ['611-008', 'traslado_valores'],
  ['612', 'no_deducible'], ['659', 'otros_gastos'],
  ['702', 'gasto_financiero'], ['702-002', 'comision_bancaria'], ['702-003', 'comision_bancaria'],
  ['760', 'impuestos'], ['761', 'impuestos'], ['763', 'impuestos'], ['764', 'impuestos'], ['205', 'impuestos'], ['209', 'impuestos'],
  ['122', 'impuestos'], ['122-001', 'iva_acreditable'],
  ['150', 'activo_fijo'], ['160', 'activo_fijo'], ['107', 'anticipo_proveedor'],
  ['202', 'pago_credito'], ['220', 'pago_credito'], ['210-002', 'pago_credito'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable('category_kepler_accounts'))) {
    await knex.raw(`
      CREATE TABLE finance.category_kepler_accounts (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        account_prefix text NOT NULL,                 -- cuenta de Kepler (kdc126.c1) o su prefijo: '611-003', '601'
        category_code  text NOT NULL,                 -- finance.movement_categories.code
        note           text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        created_by     text,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     text,
        CONSTRAINT category_kepler_accounts_prefijo_ck CHECK (account_prefix ~ '^[0-9]{3}(-[0-9]{3})?$'),
        CONSTRAINT category_kepler_accounts_uno UNIQUE (tenant_id, account_prefix)
      )`);
    await knex.raw('ALTER TABLE finance.category_kepler_accounts ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE finance.category_kepler_accounts FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'finance' AND tablename = 'category_kepler_accounts' AND policyname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.category_kepler_accounts
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
  }
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON finance.category_kepler_accounts TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON finance.category_kepler_accounts TO dev_ro;
      END IF;
    END $$`);

  await knex.raw(`ALTER TABLE finance.bank_movements ADD COLUMN IF NOT EXISTS category_reason text,
    ADD COLUMN IF NOT EXISTS category_evidence jsonb`);

  // Las categorías y el mapeo se siembran sólo donde existe el tenant de Mega Dulces (prod, CI, desarrollo).
  const hayCategorias = (await knex.raw(`SELECT count(*)::int n FROM finance.movement_categories WHERE tenant_id = ?`, [MEGA])).rows[0].n > 0;
  if (!hayCategorias) { console.log('[BFU.7.1] sin catálogo de categorías del tenant: tabla creada, sin siembra'); return; }
  let nuevas = 0;
  for (const [code, name, group, cuenta, orden] of CATEGORIAS) {
    const r = await knex.raw(`
      INSERT INTO finance.movement_categories (tenant_id, code, name, flow, kepler_account, group_key, kepler_note, sort_order, active)
      VALUES (?, ?, ?, 'out', ?, ?, ?, ?, true) ON CONFLICT (tenant_id, code) DO NOTHING`,
    [MEGA, code, name, cuenta, group, `Mayor ${cuenta} de Kepler (kdc126). BFU.7.1, 2026-11-20`, orden]);
    nuevas += r.rowCount;
  }
  let mapeos = 0;
  for (const [prefijo, cat] of MAPA) {
    const r = await knex.raw(`
      INSERT INTO finance.category_kepler_accounts (tenant_id, account_prefix, category_code, note, created_by, updated_by)
      SELECT ?, ?, ?, 'BFU.7.1: del catálogo de cuentas de Kepler (kdc126)', 'migracion BFU.7.1', 'migracion BFU.7.1'
       WHERE EXISTS (SELECT 1 FROM finance.movement_categories WHERE tenant_id = ? AND code = ?)
      ON CONFLICT (tenant_id, account_prefix) DO NOTHING`, [MEGA, prefijo, cat, MEGA, cat]);
    mapeos += r.rowCount;
  }
  const { rows: [sin] } = await knex.raw(`
    SELECT count(*)::int n FROM unnest(?::text[]) c WHERE NOT EXISTS (SELECT 1 FROM finance.movement_categories WHERE tenant_id = ? AND code = c)`,
  [MAPA.map(([, c]) => c), MEGA]);
  if (sin.n > 0) throw new Error(`[BFU.7.1] ${sin.n} renglón(es) del mapeo apuntan a una categoría que no existe`);
  console.log(`[BFU.7.1] ${nuevas} categorías nuevas, ${mapeos} cuentas de Kepler mapeadas (de ${MAPA.length})`);
};

/**
 * Deshace el mapeo y las categorías nuevas, sólo si ningún movimiento las usa. ⛔ Las columnas `category_reason` y
 * `category_evidence` NO se borran (regla: no borrar columnas en prod sin confirmación): quedan nulas si se deshace.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const codes = CATEGORIAS.map(([c]) => c);
  const { rows: [r] } = await knex.raw(`
    SELECT count(*)::int n FROM finance.bank_movements bm JOIN finance.movement_categories mc ON mc.id = bm.category_id
     WHERE mc.tenant_id = ? AND mc.code = ANY(?::text[])`, [MEGA, codes]);
  if (r.n > 0) throw new Error(`[BFU.7.1] ${r.n} movimientos usan las categorías nuevas: no se puede deshacer sin perderlas`);
  await knex.raw('DROP TABLE IF EXISTS finance.category_kepler_accounts');
  await knex.raw(`DELETE FROM finance.movement_categories WHERE tenant_id = ? AND code = ANY(?::text[])`, [MEGA, codes]);
};
