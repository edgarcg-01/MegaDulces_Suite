'use strict';
/**
 * `[CXC.48]` — **Los teléfonos de la cartera: el del cliente se corrige en Kepler y el del vendedor en la Suite.**
 *
 * Edgar, 2026-11-20: *«agreguemos el apartado para actualizar los números de teléfono e insertarlos en Kepler
 * (dependiendo en cuántas sucursales esté dado de alta se actualiza), y el del vendedor»*.
 *
 * Nada de esto escribe en Kepler. Prepara, APAGADO, lo que la escritura necesita:
 *  1. `finance.customer_phone_changes` — quién pidió el cambio, el antes y el después y lo que contestó cada base de
 *     Kepler. La bitácora de Kepler (`kdlogmov`) sólo dirá «SUITE»; la persona queda aquí.
 *  2. `commercial.seller_phones` — el teléfono del vendedor, por (sucursal, clave de `kduv`). Es dato PROPIO de la
 *     Suite: en `kduv` no hay ninguna columna con teléfono (medido el 2026-11-20: de c8 a c21 todas vacías en las 400
 *     filas) y sin la forma de Kepler no se sabe cuál lo sería. No se adivina (regla 10).
 *  3. El interruptor `commercial.kepler_push_switch` admite el tipo `telefono_cliente`, sembrado **apagado** en las
 *     nueve sucursales con tope de 5 por día (el canario). Los tipos que ya existan se CONSERVAN: se leen de la
 *     restricción vigente, no de una lista escrita aquí que otra migración pudo haber ampliado.
 *  4. La llave `FINANCE_CARTERA_TELEFONOS` («Corregir teléfonos de la cartera») a `credito_cobranza` (+ `superadmin`).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ──
 *  · `kdud.c7` es el teléfono: la forma de clientes de Kepler (`md_cat_cli.kpl`) registra en `kdlogmov` la columna `7`
 *    con valores de teléfono (373 cambios en las 9 sucursales); es la columna que ya lee la cartera.
 *  · Un cambio hecho en una sucursal NO llega a las otras: el cliente 30172 se editó hoy en la 05 y las otras 7 bases
 *    siguen con lo anterior. Por eso la Suite escribe en cada base donde está la clave.
 *  · De ~3,000 claves, 2,401 están en las 9 sucursales; 2,013 de ellas sin teléfono.
 *  · `kepler_push_switch_tipo_ck` = cancela_oc, cancela_requisicion, cancela_solicitud_gasto, cliente, compra,
 *    comprobacion_gasto, solicitud_gasto, telemarketing, traspaso.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[cxc48_telefonos_cartera]';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'telefono_cliente';
const LLAVE = 'FINANCE_CARTERA_TELEFONOS';
const ROLES = ['credito_cobranza', 'superadmin'];
const marcas = (xs) => xs.map(() => '?').join(',');

/** Los tipos de la restricción vigente (de `CHECK ((tipo = ANY (ARRAY['a'::text, ...])))`). */
async function tiposVigentes(knex) {
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'commercial.kepler_push_switch'::regclass AND conname = 'kepler_push_switch_tipo_ck'`);
  if (!rows.length) return [];
  return [...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
}

async function rehacerCheck(knex, tipos) {
  const lista = tipos.map((t) => `'${t.replace(/[^a-z_]/g, '')}'`).join(',');
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck CHECK (tipo IN (${lista}))`);
}

const politica = (esquema, tabla) => `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='${esquema}' AND tablename='${tabla}' AND policyname='tenant_isolation') THEN
      CREATE POLICY tenant_isolation ON ${esquema}.${tabla}
        USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
    END IF;
  END $$`;
const permisos = (esquema, tabla, privs) => `
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
      GRANT ${privs} ON ${esquema}.${tabla} TO app_runtime;
    END IF;
  END $$`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El rastro del cambio de teléfono del cliente ──────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS finance.customer_phone_changes (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id          uuid NOT NULL,
      sucursal           text NOT NULL,
      cliente_code       text NOT NULL,
      telefono_anterior  text,
      telefono_nuevo     text NOT NULL,
      estado             text NOT NULL DEFAULT 'pendiente'
                           CHECK (estado IN ('pendiente', 'escrito', 'parcial', 'rechazado')),
      resultado          jsonb,
      created_by         text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_by         text,
      updated_at         timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_cpc_cuenta
                    ON finance.customer_phone_changes (tenant_id, cliente_code, created_at DESC)`);
  await knex.raw(`ALTER TABLE finance.customer_phone_changes ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.customer_phone_changes FORCE ROW LEVEL SECURITY`);
  await knex.raw(politica('finance', 'customer_phone_changes'));
  // UPDATE: el renglón nace «pendiente» y se cierra con lo que contestó Kepler. Nunca se borra.
  await knex.raw(permisos('finance', 'customer_phone_changes', 'SELECT, INSERT, UPDATE'));

  // ── 2. El teléfono del vendedor (dato propio: Kepler no lo tiene) ────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS commercial.seller_phones (
      tenant_id      uuid NOT NULL,
      sucursal       text NOT NULL CHECK (sucursal ~ '^[0-9]{2}$'),
      vendedor_code  text NOT NULL,
      telefono       text NOT NULL CHECK (telefono ~ '^[0-9]{10}$'),
      created_by     text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_by     text,
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, vendedor_code)
    )`);
  await knex.raw(`ALTER TABLE commercial.seller_phones ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.seller_phones FORCE ROW LEVEL SECURITY`);
  await knex.raw(politica('commercial', 'seller_phones'));
  await knex.raw(permisos('commercial', 'seller_phones', 'SELECT, INSERT, UPDATE'));

  // ── 3. El interruptor ────────────────────────────────────────────────────────────────────────
  const tipos = await tiposVigentes(knex);
  if (!tipos.length) throw new Error(`${TAG} no encontré kepler_push_switch_tipo_ck: no rehago una restricción que no leí`);
  if (!tipos.includes(TIPO)) await rehacerCheck(knex, [...tipos, TIPO]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: TIPO, encendida: false, tope_dia: 5,
      nota: '[CXC.48] Teléfono del cliente en Kepler (kdud.c7 en cada base donde está la clave): apagado hasta los GRANT y el ensayo; canario de 5 por día',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  console.log(`  ${TAG} interruptor '${TIPO}': ${sw.n} renglón(es), ${sw.encendidas} encendido(s); tipos: ${(await tiposVigentes(knex)).join(', ')}`);

  // ── 4. La llave ──────────────────────────────────────────────────────────────────────────────
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
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`, [LLAVE]);
  const { rows: existen } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions WHERE role_name IN (${marcas(ROLES)}) AND role_name <> 'superadmin' AND deleted_at IS NULL`,
    ROLES,
  );
  // Regla 20, con la misma salvedad que ALC: la base vacía del CI no tiene el rol, y eso se DECLARA.
  if (hay.n > 0 && existen.length && !rows.length) throw new Error(`${TAG} Ningún rol (fuera de superadmin) quedó con ${LLAVE} (regla 20)`);
  if (!existen.length) console.log(`  ${TAG} ⚠️ NO MEDIDO: esta base no tiene el rol credito_cobranza — ${LLAVE} sólo queda en superadmin.`);
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: TIPO }).del();
  const tipos = await tiposVigentes(knex);
  if (tipos.includes(TIPO)) await rehacerCheck(knex, tipos.filter((t) => t !== TIPO));
  await knex.raw(`DROP TABLE IF EXISTS commercial.seller_phones`);
  await knex.raw(`DROP TABLE IF EXISTS finance.customer_phone_changes`);
};
