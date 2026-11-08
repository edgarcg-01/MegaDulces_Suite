'use strict';
/**
 * `[ALC.2.8]` — **La escritura directa del alta en Kepler, preparada y APAGADA** (D1-b).
 *
 * Pedido de Francisco (2026-11-07): *«preparamos todo para que nuestra escritura directa a cada una
 * de las bases de Kepler llegue bien y Edgar sólo tenga que hacer configuración final»*.
 *
 * Tres cosas, ninguna escribe en Kepler:
 *  1. **La solicitud guarda lo que Kepler pide en `kdfedir`** y que la Suite no capturaba: el uso de
 *     CFDI (`kdfedir.c16`) y la forma de pago (`c14`). Y el rastro de la escritura: la clave
 *     reservada, quién y cuándo lo intentó, cuándo quedaron las 10 bases y el resultado de cada una.
 *     Todas **nullable** (ningún camino de inserción viejo se rompe; regla 14).
 *  2. **El interruptor** `commercial.kepler_push_switch` admite el tipo `cliente`, sembrado
 *     **apagado** en las nueve sucursales con tope de **1 alta por día** (el canario de D1-b).
 *  3. **La llave** `COMMERCIAL_ALTA_CLIENTES_KEPLER` («Dar de alta clientes en Kepler») al rol
 *     `credito_cobranza` (+ `superadmin`): Francisco, 2026-11-07, *«ahora no permitimos que todos
 *     los usuarios den de alta clientes»*. Capturar la solicitud sigue abierto; escribir en el ERP no.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-07) ──
 *  · `kepler_push_switch_tipo_ck` = compra, traspaso, telemarketing (27 renglones; ninguno `cliente`).
 *  · `customer_onboarding_requests`: 0 filas; `GRANT SELECT, INSERT, UPDATE` a `app_runtime` a nivel
 *    TABLA (mig 20261104235236): las columnas nuevas quedan cubiertas.
 *  · Rol `credito_cobranza`: 3 personas (2 primarias, 1 secundaria). Sin la llave nueva (no existía).
 *
 * ⚠️ Lección de `[ALC.3.5.1]`: cada columna se pregunta a `information_schema` por separado (un
 *    `knex.schema` reusado devolvía respuestas viejas) y el CHECK no puede dar NULL.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[alc_escritura_directa_kepler]';
const TABLA = 'customer_onboarding_requests';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const LLAVE = 'COMMERCIAL_ALTA_CLIENTES_KEPLER';
const ROLES = ['credito_cobranza', 'superadmin'];
const COLUMNAS = [
  ['uso_cfdi', 'text'],
  ['payment_form', 'text'],
  ['kepler_code', 'text'],
  ['kepler_write_started_at', 'timestamptz'],
  ['kepler_write_by', 'uuid'],
  ['kepler_written_at', 'timestamptz'],
  ['kepler_write_result', 'jsonb'],
];
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La solicitud ──────────────────────────────────────────────────────────────────────
  const falta = async (c) => {
    const { rows } = await knex.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'commercial' AND table_name = ? AND column_name = ?`,
      [TABLA, c],
    );
    return rows.length === 0;
  };
  for (const [col, tipo] of COLUMNAS) {
    if (await falta(col)) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN ${col} ${tipo}`);
  }
  // Escrita en Kepler ⇒ tiene clave. Las dos ramas son booleanas: nunca da NULL.
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_kepler_ck`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${TABLA}_kepler_ck
                    CHECK ((kepler_written_at IS NULL) OR (kepler_code IS NOT NULL))`);
  // Una clave reservada es de UNA solicitud: dos altas simultáneas no pueden llevarse la misma.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${TABLA}_kepler_code
                    ON commercial.${TABLA} (tenant_id, kepler_code)
                    WHERE kepler_code IS NOT NULL AND deleted_at IS NULL`);

  // ── 2. El interruptor ────────────────────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck
                    CHECK (tipo IN ('compra','traspaso','telemarketing','cliente'))`);
  // Con FORCE RLS, el insert necesita el tenant en la sesión. ON CONFLICT DO NOTHING: re-correr no
  // pisa lo que alguien ya encendió.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: 'cliente', encendida: false, tope_dia: 1,
      nota: '[ALC.2.8] Alta de clientes en Kepler (D1-b): apagada hasta el ensayo contra las 10 bases y los GRANT; canario de 1 por día',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = 'cliente'`);
  console.log(`  ${TAG} interruptor 'cliente': ${sw.n} renglón(es), ${sw.encendidas} encendido(s)`);

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
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL
      ORDER BY 1`,
    [LLAVE],
  );
  // Regla 20: una llave declarada y sin dueño es un botón que nadie puede pulsar. Se exige sólo si el
  // rol EXISTE en esta base: la base vacía del CI no lo tiene, y fallar ahí haría que el arranque
  // SALTE la migración entera — columnas incluidas — y rompa la prueba del alta (medido 2026-11-07
  // con `dev-bootstrap-empty-db.js`). Sin el rol se DECLARA, no se da por bueno.
  const { rows: existen } = await knex.raw(
    `SELECT role_name FROM identity.role_permissions WHERE role_name IN (${marcas(ROLES)}) AND role_name <> 'superadmin' AND deleted_at IS NULL`,
    ROLES,
  );
  if (hay.n > 0 && existen.length && !rows.length) throw new Error(`${TAG} Ningun rol (fuera de superadmin) quedo con ${LLAVE} (regla 20)`);
  if (!existen.length) console.log(`  ${TAG} ⚠️ NO MEDIDO: esta base no tiene el rol credito_cobranza — ${LLAVE} sólo queda en superadmin.`);
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: 'cliente' }).del();
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch DROP CONSTRAINT IF EXISTS kepler_push_switch_tipo_ck`);
  await knex.raw(`ALTER TABLE commercial.kepler_push_switch ADD CONSTRAINT kepler_push_switch_tipo_ck
                    CHECK (tipo IN ('compra','traspaso','telemarketing'))`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_${TABLA}_kepler_code`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${TABLA}_kepler_ck`);
  for (const [col] of [...COLUMNAS].reverse()) await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN IF EXISTS ${col}`);
};
