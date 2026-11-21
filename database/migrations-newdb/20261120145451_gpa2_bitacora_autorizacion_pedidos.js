'use strict';
/**
 * `[GP.A.2]` — **La bitácora de la autorización de pedidos TELEMARK, el interruptor y la llave de Crédito y cobranza.**
 *
 * Anexo EA de GP (§3, §5): la Suite autoriza en Kepler (`kdm1.c11` CREADO → AUTORIZADO, ADR-117 enmendado, D-A1
 * firmada por Edgar el 2026-11-20), sola cuando el pedido cumple la regla y a mano cuando Crédito y cobranza decide.
 * Kepler sólo guardará «SUITE» en su bitácora; **quién o qué decidió, con qué números y por qué** queda aquí.
 *
 * Nada de esto escribe en Kepler. Prepara, APAGADO, lo que la escritura necesita:
 *  1. `finance.order_authorizations` — una fila por decisión: autorizar, regresar (D-A7), rechazar o pasar a
 *     Dirección General. La de Kepler nace `pendiente` y se cierra con lo que contestó Kepler (`escrito`,
 *     `ya_estaba`, `apagado`, `rechazado`); rechazar y pasar a Dirección **no tocan Kepler** (el pedido sigue
 *     CREADO) y nacen `registrado`. Guarda lo que vio la regla (`regla`: decisión, motivos, números y parámetros).
 *     Una sola escritura en curso por pedido (índice único sobre `pendiente`): dos clics no escriben dos veces.
 *  2. El interruptor `commercial.kepler_push_switch` admite el tipo `autorizacion` (la bandeja ya lo lee), sembrado
 *     **apagado** en las nueve sucursales y **sin tope** (D-A14): encendido quiere decir que la Suite puede autorizar
 *     A MANO en esa sucursal; el automático sólo corre cuando alguien le pone un tope del día (la regla, condición 6,
 *     no deja pasar nada solo sin tope). Así el piloto a mano no enciende el automático por accidente. ⚠️ No es 0:
 *     `kepler_push_switch_tope_ck` exige vacío o mayor que 0 (lo encontró la simulación contra prod del 2026-11-20).
 *     Los tipos que ya existan se CONSERVAN: se leen de la restricción vigente.
 *  3. La llave `FINANCE_PEDIDOS_AUTORIZAR` («Autorizar pedidos de telemarketing») a `credito_cobranza`
 *     (+ `superadmin`). Dirección General recibe la suya con GP.A.6b.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-20) ──
 *  · `kepler_push_switch_tipo_ck` = cancela_oc, cancela_requisicion, cancela_solicitud_gasto, cliente, compra,
 *    comprobacion_gasto, solicitud_gasto, telemarketing, traspaso, telefono_cliente. Sin `autorizacion`.
 *  · `finance.order_authorizations` no existe.
 *  · El rol `credito_cobranza` existe (con FINANCE_RECEIVABLES_VER y FINANCE_CARTERA_TELEFONOS en true).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[gpa2_bitacora_autorizacion_pedidos]';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUCURSALES = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TIPO = 'autorizacion';
const LLAVE = 'FINANCE_PEDIDOS_AUTORIZAR';
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

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La bitácora ───────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS finance.order_authorizations (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        uuid NOT NULL,
      sucursal         text NOT NULL CHECK (sucursal ~ '^[0-9]{2}$'),
      serie            integer NOT NULL,
      folio            text NOT NULL,
      cliente_code     text NOT NULL,
      importe          numeric(14,2) NOT NULL,
      accion           text NOT NULL CHECK (accion IN ('autorizar', 'regresar', 'rechazar', 'escalar')),
      automatica       boolean NOT NULL DEFAULT false,
      motivo           text,
      regla            jsonb NOT NULL,
      estado           text NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente', 'escrito', 'ya_estaba', 'apagado', 'rechazado', 'registrado')),
      kepler_resultado jsonb,
      created_by       text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_by       text,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      -- Sólo autorizar puede ser automático; toda decisión de una persona lleva motivo (§3.6, «motivo obligatorio»).
      CONSTRAINT order_authorizations_automatica_ck CHECK (NOT automatica OR (accion = 'autorizar' AND created_by IS NULL)),
      CONSTRAINT order_authorizations_motivo_ck CHECK (automatica OR length(btrim(coalesce(motivo, ''))) > 0),
      CONSTRAINT order_authorizations_persona_ck CHECK (automatica OR created_by IS NOT NULL),
      -- Rechazar y pasar a Dirección no escriben en Kepler: nacen y se quedan «registrado»; las otras dos, nunca.
      CONSTRAINT order_authorizations_estado_ck CHECK ((accion IN ('rechazar', 'escalar')) = (estado = 'registrado'))
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_oa_pedido
                    ON finance.order_authorizations (tenant_id, sucursal, serie, folio, created_at DESC)`);
  // El tope del día (condición 6) cuenta las automáticas que sí se escribieron, por sucursal.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_oa_automaticas_dia
                    ON finance.order_authorizations (tenant_id, sucursal, created_at)
                    WHERE automatica AND estado = 'escrito'`);
  // Una sola escritura en curso por pedido: el segundo clic (o el automático a la vez) choca aquí.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_fin_oa_una_en_curso
                    ON finance.order_authorizations (tenant_id, sucursal, serie, folio)
                    WHERE estado = 'pendiente'`);
  await knex.raw(`ALTER TABLE finance.order_authorizations ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.order_authorizations FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'finance' AND tablename = 'order_authorizations' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.order_authorizations
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // UPDATE: la fila nace «pendiente» y se cierra con lo que contestó Kepler. Nunca se borra.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON finance.order_authorizations TO app_runtime;
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
      nota: '[GP.A.2] Autorizar pedidos TELEMARK en Kepler (kdm1.c11 CREADO → AUTORIZADO): apagado hasta el GRANT (GP.A.0d) y el ensayo. Sin tope = sólo a mano; el automático corre cuando se le pone un tope del día (D-A14)',
    })))
    .onConflict(['tenant_id', 'sucursal', 'tipo']).ignore();
  const { rows: [sw] } = await knex.raw(
    `SELECT count(*)::int n, count(*) FILTER (WHERE encendida)::int encendidas FROM commercial.kepler_push_switch WHERE tipo = ?`, [TIPO]);
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
  // Regla 20, con la misma salvedad que CXC.48: la base vacía del CI no tiene el rol, y eso se DECLARA.
  if (hay.n > 0 && existen.length && !rows.length) throw new Error(`${TAG} Ningún rol (fuera de superadmin) quedó con ${LLAVE} (regla 20)`);
  if (!existen.length) console.log(`  ${TAG} ⚠️ NO MEDIDO: esta base no tiene el rol credito_cobranza — ${LLAVE} sólo queda en superadmin.`);
  console.log(`  ${TAG} ${LLAVE}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. La bitácora se conserva si ya tiene decisiones (regla 5). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [LLAVE, LLAVE]);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex('commercial.kepler_push_switch').where({ tipo: TIPO }).del();
  const tipos = await tiposVigentes(knex);
  if (tipos.includes(TIPO)) await rehacerCheck(knex, tipos.filter((t) => t !== TIPO));
  const { rows: [t] } = await knex.raw(`SELECT to_regclass('finance.order_authorizations') IS NOT NULL AS hay`);
  if (!t.hay) return;
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int n FROM finance.order_authorizations`);
  if (n.n > 0) { console.log(`  ${TAG} finance.order_authorizations tiene ${n.n} decisión(es): se conserva`); return; }
  await knex.raw(`DROP TABLE IF EXISTS finance.order_authorizations`);
};
