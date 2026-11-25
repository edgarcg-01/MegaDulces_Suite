'use strict';
/**
 * `[GP.R.2]` — **El registro del Ajuste Abono, su interruptor y la llave de Crédito y cobranza.**
 *
 * Anexo RC de GP: la Suite cierra en Kepler los restos de centavos de las facturas de clientes con el **Ajuste
 * Abono `U-A-30`** que el ERP ya trae, en vez del «Cobro» de centavos que se usa hoy —un cobro que dice que entró
 * dinero y no entró— (74 de ésos en 60 días contra **cero** Ajustes Abono). D-R1 firmada por Edgar el 2026-11-24:
 * el tope es **$10** y se cierra solo hasta ahí.
 *
 * ⛔ **Nada de esto escribe en Kepler.** Prepara, APAGADO, lo que la escritura necesitará:
 *  1. `finance.customer_credit_adjustments` — una fila por ajuste: el cliente, las facturas que cerró con su resto
 *     exacto, quién o qué lo decidió, y lo que contestó Kepler. Kepler sólo guardará «SUITE» como capturista;
 *     **quién, por qué y sobre qué facturas** queda aquí. Sin esto, un ajuste en Kepler es un número que dentro de
 *     tres meses nadie puede explicar — que es justo el problema que este anexo existe para no repetir.
 *  2. El interruptor `commercial.kepler_push_switch` admite el tipo `ajuste_abono`, sembrado **apagado** en las
 *     nueve sucursales y **sin tope**: encendido quiere decir que la Suite puede cerrar restos A MANO en esa
 *     sucursal; el automático corre sólo cuando alguien le pone un tope del día. ⚠️ No es 0: `kepler_push_switch_tope_ck`
 *     exige vacío o mayor que 0. Los tipos que ya existan se CONSERVAN: se leen de la restricción vigente.
 *  3. La llave `FINANCE_RESTOS_CERRAR` («Cerrar restos de centavos de clientes») a `credito_cobranza`
 *     (+ `superadmin`), que es quien decide hoy (regla 20).
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156) ──
 *  · 2026-11-24: `kepler_push_switch_tipo_ck` trae 11 tipos y **ninguno es `ajuste_abono`**; no existe ninguna tabla
 *    de `finance` que se parezca a un registro de ajustes (se buscaron 3 nombres).
 *  · 2026-11-24, **escribiendo** (ensayo con ROLLBACK, `ops/prod/ensayo-ajuste-abono/`): la huella son tres tablas
 *    —`kdm1` + `kdue` + `kdm5`—, el folio sale del contador `KFUA3001.<sucursal>`, y el saldo de la factura bajó de
 *    $7.20 a **$0.00**. ⛔ Y **`kdm1.c11` es `varchar(20)`**: por eso `referencia` se acota a 20 aquí también — si la
 *    Suite guardara una más larga, no cabría en Kepler y el ajuste moriría al escribirse.
 *  · Las cinco tablas de Kepler tienen **cero disparadores**: lo que mueve el PROGRAMA al postear (acumulados,
 *    póliza) **no se midió** y por eso `kepler_resultado` lo guardará tal cual en vez de suponerlo.
 *
 * ⬜ **Abierto, y no lo decide esta migración:** D-R2 (¿Contabilidad quiere la póliza del redondeo? el Ajuste Abono
 * **no deja póliza**: la cartera baja y los libros no se enteran) y D-R3 (¿Crédito y cobranza deja de usar los
 * «Cobros» de centavos?).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[gpr2_registro_ajuste_abono]';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'ajuste_abono';
const LLAVE = 'FINANCE_RESTOS_CERRAR';
const ROLES = ['credito_cobranza', 'superadmin'];
/** `md.kdm1.c11` es `varchar(20)` (medido escribiendo el 2026-11-24). */
const REFERENCIA_MAX = 20;
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

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. El registro ───────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS finance.customer_credit_adjustments (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        uuid NOT NULL,
      sucursal         text NOT NULL CHECK (sucursal ~ '^[0-9]{2}$'),
      cliente_code     text NOT NULL,
      -- La llave de idempotencia que va a kdm1.c11, que es varchar(20): si no cabe allá, no se guarda acá.
      referencia       text NOT NULL CHECK (length(btrim(referencia)) BETWEEN 1 AND ${REFERENCIA_MAX}),
      importe          numeric(14,2) NOT NULL CHECK (importe > 0),
      -- Las facturas que cerró, con su resto exacto: [{tipo, serie, folio, importe, saldo}]
      facturas         jsonb NOT NULL CHECK (jsonb_typeof(facturas) = 'array' AND jsonb_array_length(facturas) > 0),
      automatica       boolean NOT NULL DEFAULT false,
      motivo           text,
      estado           text NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente', 'escrito', 'apagado', 'rechazado')),
      -- Lo que Kepler contestó, TAL CUAL (incluido el folio que dio y lo que el ensayo no pudo medir).
      kepler_folio     text,
      kepler_resultado jsonb,
      created_by       text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_by       text,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      -- Sólo el automático va sin persona; toda decisión de alguien lleva motivo y nombre.
      CONSTRAINT cca_automatica_ck CHECK (NOT automatica OR created_by IS NULL),
      CONSTRAINT cca_motivo_ck     CHECK (automatica OR length(btrim(coalesce(motivo, ''))) > 0),
      CONSTRAINT cca_persona_ck    CHECK (automatica OR created_by IS NOT NULL),
      -- Sólo un ajuste escrito puede traer folio de Kepler, y si lo trae tiene que estar escrito.
      CONSTRAINT cca_folio_ck      CHECK ((kepler_folio IS NOT NULL) = (estado = 'escrito'))
    )`);
  // La idempotencia: la misma referencia no se escribe dos veces, ni aunque el clic se repita.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_cca_referencia
                    ON finance.customer_credit_adjustments (tenant_id, referencia)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_cca_cliente
                    ON finance.customer_credit_adjustments (tenant_id, sucursal, cliente_code, created_at DESC)`);
  // Un solo ajuste en curso por cliente: el segundo clic (o el automático a la vez) choca aquí.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_cca_una_en_curso
                    ON finance.customer_credit_adjustments (tenant_id, sucursal, cliente_code)
                    WHERE estado = 'pendiente'`);
  // El tope del día del automático, por sucursal.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_cca_automaticas_dia
                    ON finance.customer_credit_adjustments (tenant_id, sucursal, created_at)
                    WHERE automatica AND estado = 'escrito'`);
  await knex.raw(`ALTER TABLE finance.customer_credit_adjustments ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.customer_credit_adjustments FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'finance' AND tablename = 'customer_credit_adjustments' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.customer_credit_adjustments
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // UPDATE: la fila nace «pendiente» y se cierra con lo que contestó Kepler. Nunca se borra.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON finance.customer_credit_adjustments TO app_runtime;
      END IF;
    END $$`);

  // ── 2. El interruptor ────────────────────────────────────────────────────────────────────────
  const tipos = await tiposVigentes(knex);
  if (!tipos.length) throw new Error(`${TAG} no encontré kepler_push_switch_tipo_ck: no rehago una restricción que no leí`);
  if (!tipos.includes(TIPO)) await rehacerCheck(knex, [...tipos, TIPO]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch')
    .insert(SUCURSALES.map((s) => ({
      tenant_id: TENANT, sucursal: s, tipo: TIPO, encendida: false, tope_dia: null,
      nota: '[GP.R.2] Cerrar restos de centavos con el Ajuste Abono U-A-30 (kdm1 + kdue + kdm5): apagado hasta el adaptador (GP.R.3). Sin tope = sólo a mano; el automático corre cuando se le pone un tope del día. Tope del resto: $10 (D-R1)',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
  if (sw.encendidas > 0) throw new Error(`${TAG} el interruptor '${TIPO}' nació con ${sw.encendidas} encendido(s): tiene que nacer APAGADO`);
  console.log(`  ${TAG} interruptor '${TIPO}': ${sw.n} renglón(es), ${sw.encendidas} encendido(s); tipos: ${(await tiposVigentes(knex)).join(', ')}`);

  // ── 3. La llave ──────────────────────────────────────────────────────────────────────────────
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
  // Regla 20, con la misma salvedad que GP.A.2: la base vacía del CI no tiene el rol, y eso se DECLARA.
  if (hay.n > 0 && existen.length && !rows.length) throw new Error(`${TAG} Ningún rol (fuera de superadmin) quedó con ${LLAVE} (regla 20)`);
  if (!existen.length) console.log(`  ${TAG} ⚠️ NO MEDIDO: esta base no tiene el rol credito_cobranza — ${LLAVE} sólo queda en superadmin.`);
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. El registro se conserva si ya tiene ajustes (regla 5). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: TIPO }).del();
  const tipos = await tiposVigentes(knex);
  if (tipos.includes(TIPO)) await rehacerCheck(knex, tipos.filter((t) => t !== TIPO));
  const { rows: [t] } = await knex.raw(`SELECT to_regclass('finance.customer_credit_adjustments') IS NOT NULL AS hay`);
  if (!t.hay) return;
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM finance.customer_credit_adjustments`);
  if (n.n > 0) { console.log(`  ${TAG} finance.customer_credit_adjustments tiene ${n.n} ajuste(s): se conserva`); return; }
  await knex.raw(`DROP TABLE IF EXISTS finance.customer_credit_adjustments`);
};
