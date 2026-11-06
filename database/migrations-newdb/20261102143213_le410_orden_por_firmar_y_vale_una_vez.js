'use strict';
/**
 * `[LE.4.10]` — **La orden que espera la firma de Tesorería**, y el vale y el documento que se usan una vez.
 *
 * Pagar en la Ventanilla (V3, V4, D18): con un vale aprobado, la orden nace con su código; sin él,
 * nace «por firmar» y SIN código —el dinero no sale antes de la firma—. Firmar le da el código;
 * rechazar la anula con su motivo. Firma un puesto que firma caja (LE.4.9), nunca quien la pidió.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-02) ─────────────────────────────────────────
 *  · `cashbook.withdrawal_orders` (LE.1.14 + LE.2.9) aplicada y sin órdenes: los candados que se
 *    cambian llevan el nombre que Postgres les dio (`withdrawal_orders_amount_minor_check`,
 *    `withdrawal_orders_state_check`), leído de `pg_constraint`, no adivinado.
 *  · 915 pagos X-D-26 de la 0011 desde el 1-oct, ninguno con más de una pierna: el documento es una fila.
 *  · Vales `validada` desde el 1-oct: 1,374, y sólo 148 guardan quién los aprobó (`aprobado_at`). El
 *    cierre de Kepler valida vales que nadie firmó (`[GX.85]`): un vale ampara el pago sólo con firma.
 *
 * ── Qué cambia ───────────────────────────────────────────────────────────────────────────────
 *  · Estado `por_firmar` (sin `seq` ni `code` hasta la firma) y quién decidió, cuándo y por qué.
 *  · Un pago que es todo del cajón (menos de $20) lleva una orden de $0 de máquina: nace `usada`,
 *    y así el documento queda tomado aunque la máquina no entregue nada.
 *  · `act`: lo que la cajera capturó (piezas del cajón, quién recibe) para asentarlo al firmar.
 *  · Un documento, un vale y una `Idempotency-Key` se usan una vez (también mientras espera firma).
 *  · `issue_order` admite `por_firmar`, `act` e `idempotency_key`; nuevas `sign_order` y `reject_order`.
 *
 * Expand: columnas nuevas nulas y candados más anchos; `consume_order` no cambia (la API desplegada
 * la usa). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const ESTADOS_TOMADOS = `('por_firmar','vigente','usada')`;

const CANDADOS = `
ALTER TABLE cashbook.withdrawal_orders ALTER COLUMN seq DROP NOT NULL;
ALTER TABLE cashbook.withdrawal_orders ALTER COLUMN code DROP NOT NULL;
ALTER TABLE cashbook.withdrawal_orders ADD COLUMN IF NOT EXISTS act jsonb;
ALTER TABLE cashbook.withdrawal_orders ADD COLUMN IF NOT EXISTS idempotency_key uuid;
ALTER TABLE cashbook.withdrawal_orders ADD COLUMN IF NOT EXISTS decided_by uuid;
ALTER TABLE cashbook.withdrawal_orders ADD COLUMN IF NOT EXISTS decided_by_employee uuid;
ALTER TABLE cashbook.withdrawal_orders ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE cashbook.withdrawal_orders ADD COLUMN IF NOT EXISTS decision_note text;

ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS withdrawal_orders_amount_minor_check;
ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_monto;
ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_monto
  CHECK (amount_minor > 0 OR (kind = 'pago' AND amount_minor = 0));

ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS withdrawal_orders_state_check;
ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_estado;
ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_estado
  CHECK (state IN ('por_firmar','vigente','usada','vencida','anulada'));

-- Sin código hasta la firma; con código todo lo que la máquina puede usar o ya usó.
ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_codigo_al_firmar;
ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_codigo_al_firmar CHECK (
  (code IS NULL) = (seq IS NULL)
  AND (state <> 'por_firmar' OR code IS NULL)
  AND (state NOT IN ('vigente','usada') OR code IS NOT NULL));

ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_firma_otro;
ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_firma_otro
  CHECK (decided_by IS NULL OR decided_by <> issued_by);
ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_decision_completa;
ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_decision_completa
  CHECK ((decided_by IS NULL) = (decided_at IS NULL));
ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_rechazo_con_motivo;
ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_rechazo_con_motivo
  CHECK (NOT (state = 'anulada' AND decided_by IS NOT NULL) OR length(trim(coalesce(decision_note, ''))) > 0);

-- Con nombre \`cashbook_*\`: el traductor de errores de la API los dice con su frase.
DROP INDEX IF EXISTS cashbook.ux_cashbook_orden_documento_una_vez;
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_orden_documento_una_vez
  ON cashbook.withdrawal_orders (tenant_id, source_ref) WHERE source_ref IS NOT NULL AND state IN ${ESTADOS_TOMADOS};
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_orden_vale_una_vez
  ON cashbook.withdrawal_orders (tenant_id, (classification->>'vale'))
  WHERE classification->>'vale' IS NOT NULL AND state IN ${ESTADOS_TOMADOS};
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_orden_llave_unica
  ON cashbook.withdrawal_orders (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_cashbook_orden_por_firmar
  ON cashbook.withdrawal_orders (tenant_id, created_at) WHERE state = 'por_firmar';
`;

const FUNCIONES = `
-- El siguiente código libre, bajo el candado del inquilino (el mismo de LE.1.14).
CREATE OR REPLACE FUNCTION cashbook._codigo_libre(p_t uuid, OUT o_seq bigint, OUT o_code text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cashbook.withdrawal_orders:' || p_t::text));
  SELECT coalesce(max(seq), 0) + 1 INTO o_seq FROM cashbook.withdrawal_orders WHERE tenant_id = p_t;
  o_code := cashbook._codigo(o_seq);
  WHILE EXISTS (SELECT 1 FROM cashbook.withdrawal_orders WHERE tenant_id = p_t AND code = o_code AND state = 'vigente') LOOP
    o_seq := o_seq + 1; o_code := cashbook._codigo(o_seq);
  END LOOP;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.issue_order(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  v_user uuid := nullif(p->'actor'->>'user_id', '')::uuid;
  v_vence timestamptz := nullif(p->>'expires_at', '')::timestamptz;
  v_firmar boolean := coalesce((p->>'por_firmar')::boolean, false);
  v_amount bigint := (p->>'amount_minor')::bigint;
  v_key uuid := nullif(p->>'idempotency_key', '')::uuid;
  v_seq bigint; v_code text; v_id uuid; v_state text; ya cashbook.withdrawal_orders%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN PERFORM cashbook._falla('cashbook_orden_actor', 'una orden la emite una persona con su usuario'); END IF;
  IF v_vence IS NULL OR v_vence <= clock_timestamp() THEN PERFORM cashbook._falla('cashbook_orden_sin_plazo', 'toda orden vence (V2)'); END IF;
  -- Un reintento con la misma llave devuelve la misma orden; con otro contenido, se rechaza (B3).
  IF v_key IS NOT NULL THEN
    SELECT * INTO ya FROM cashbook.withdrawal_orders WHERE tenant_id = v_t AND idempotency_key = v_key;
    IF FOUND THEN
      IF ya.kind IS DISTINCT FROM p->>'kind' OR ya.source_ref IS DISTINCT FROM nullif(p->>'source_ref', '')
         OR ya.amount_minor <> v_amount OR ya.issued_by <> v_user THEN
        PERFORM cashbook._falla('cashbook_peticion_reusada', 'esa llave ya emitió otra orden');
      END IF;
      RETURN jsonb_build_object('id', ya.id, 'code', ya.code, 'seq', ya.seq, 'state', ya.state, 'repetida', true);
    END IF;
  END IF;
  IF v_firmar THEN
    v_state := 'por_firmar';
  ELSE
    SELECT o_seq, o_code INTO v_seq, v_code FROM cashbook._codigo_libre(v_t);
    v_state := CASE WHEN v_amount = 0 THEN 'usada' ELSE 'vigente' END;
  END IF;
  INSERT INTO cashbook.withdrawal_orders (tenant_id, seq, code, kind, amount_minor, classification, source_ref, request_id,
    issued_by, issued_by_employee, expires_at, state, act, idempotency_key, created_by, updated_by)
  VALUES (v_t, v_seq, v_code, p->>'kind', v_amount, p->'classification', nullif(p->>'source_ref', ''),
    nullif(p->>'request_id', '')::uuid, v_user, nullif(p->'actor'->>'employee_id', '')::uuid, v_vence, v_state,
    p->'act', v_key, v_user, v_user)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'seq', v_seq, 'state', v_state, 'repetida', false);
END $fn$;

-- La firma de Tesorería: un puesto que firma caja, nunca quien la pidió. Le da el código.
CREATE OR REPLACE FUNCTION cashbook.sign_order(p_id uuid, p_user uuid, p_employee uuid, p_expires_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  o cashbook.withdrawal_orders%ROWTYPE; v_seq bigint; v_code text; v_state text;
BEGIN
  SELECT * INTO o FROM cashbook.withdrawal_orders WHERE tenant_id = v_t AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_orden_inexistente', 'no existe esa orden'); END IF;
  IF o.state <> 'por_firmar' THEN PERFORM cashbook._falla('cashbook_orden_no_por_firmar', 'esa orden no espera firma: ' || o.state); END IF;
  IF o.expires_at < clock_timestamp() THEN PERFORM cashbook._falla('cashbook_orden_vencida', 'la orden venció sin firma: hay que pedirla otra vez'); END IF;
  IF p_user IS NULL OR p_user = o.issued_by THEN PERFORM cashbook._falla('cashbook_orden_firma_otro', 'quien pidió la orden no la firma'); END IF;
  IF cashbook._firma_de_caja(v_t, p_user) IS NULL THEN
    PERFORM cashbook._falla('cashbook_firma_por_puesto', 'para firmar una orden de caja hay que tener un puesto que firma caja y estar activo');
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= clock_timestamp() THEN PERFORM cashbook._falla('cashbook_orden_sin_plazo', 'toda orden vence (V2)'); END IF;
  SELECT o_seq, o_code INTO v_seq, v_code FROM cashbook._codigo_libre(v_t);
  v_state := CASE WHEN o.amount_minor = 0 THEN 'usada' ELSE 'vigente' END;
  UPDATE cashbook.withdrawal_orders
     SET seq = v_seq, code = v_code, state = v_state, expires_at = p_expires_at,
         decided_by = p_user, decided_by_employee = p_employee, decided_at = clock_timestamp(),
         updated_at = clock_timestamp(), updated_by = p_user
   WHERE id = o.id;
  RETURN jsonb_build_object('id', o.id, 'code', v_code, 'seq', v_seq, 'state', v_state, 'kind', o.kind,
    'amount_minor', o.amount_minor::text, 'source_ref', o.source_ref, 'classification', o.classification,
    'act', o.act, 'issued_by', o.issued_by, 'idempotency_key', o.idempotency_key);
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.reject_order(p_id uuid, p_user uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  o cashbook.withdrawal_orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM cashbook.withdrawal_orders WHERE tenant_id = v_t AND id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_orden_inexistente', 'no existe esa orden'); END IF;
  IF o.state <> 'por_firmar' THEN PERFORM cashbook._falla('cashbook_orden_no_por_firmar', 'esa orden no espera firma: ' || o.state); END IF;
  IF p_user IS NULL OR p_user = o.issued_by THEN PERFORM cashbook._falla('cashbook_orden_firma_otro', 'quien pidió la orden no la rechaza'); END IF;
  IF cashbook._firma_de_caja(v_t, p_user) IS NULL THEN
    PERFORM cashbook._falla('cashbook_firma_por_puesto', 'para rechazar una orden de caja hay que tener un puesto que firma caja y estar activo');
  END IF;
  IF length(trim(coalesce(p_note, ''))) = 0 THEN PERFORM cashbook._falla('cashbook_orden_rechazo_con_motivo', 'un rechazo dice por qué'); END IF;
  UPDATE cashbook.withdrawal_orders
     SET state = 'anulada', decided_by = p_user, decided_at = clock_timestamp(), decision_note = p_note,
         updated_at = clock_timestamp(), updated_by = p_user
   WHERE id = o.id;
END $fn$;

-- Vence lo vigente y lo que nadie firmó a tiempo.
CREATE OR REPLACE FUNCTION cashbook.expire_orders() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_n integer;
BEGIN
  UPDATE cashbook.withdrawal_orders SET state = 'vencida', updated_at = clock_timestamp()
   WHERE tenant_id = cashbook._tenant() AND state IN ('vigente','por_firmar') AND expires_at < clock_timestamp();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;
`;

const NUEVAS = ['sign_order(uuid, uuid, uuid, timestamptz)', 'reject_order(uuid, uuid, text)'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook.issue_order(jsonb)') IS NOT NULL AS ordenes,
    to_regprocedure('cashbook._firma_de_caja(uuid, uuid)') IS NOT NULL AS firma`);
  if (!h.ordenes) throw new Error('[LE.4.10] faltan las órdenes (20261102134515): se aplica después.');
  if (!h.firma) throw new Error('[LE.4.10] falta la firma por puesto (20261027162407): se aplica después.');

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(CANDADOS);
  await knex.raw(FUNCIONES);
  await knex.raw(`RESET ROLE`);

  await knex.raw(`REVOKE ALL ON FUNCTION cashbook._codigo_libre(uuid) FROM PUBLIC`);
  for (const f of NUEVAS) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
};

/** Sólo si ninguna orden usa lo nuevo: una orden emitida es historia del dinero (B23). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [c] } = await knex.raw(`SELECT count(*)::int AS n FROM cashbook.withdrawal_orders
    WHERE state = 'por_firmar' OR amount_minor = 0 OR code IS NULL OR decided_by IS NOT NULL`);
  if (c.n > 0) throw new Error(`[LE.4.10] hay ${c.n} órdenes que usan la firma o el pago de $0: no se deshace.`);
  for (const f of NUEVAS) await knex.raw(`DROP FUNCTION IF EXISTS cashbook.${f}`);
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(`DROP FUNCTION IF EXISTS cashbook._codigo_libre(uuid)`);
  for (const i of ['cashbook_orden_vale_una_vez', 'cashbook_orden_llave_unica', 'ix_cashbook_orden_por_firmar', 'cashbook_orden_documento_una_vez']) {
    await knex.raw(`DROP INDEX IF EXISTS cashbook.${i}`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cashbook_orden_documento_una_vez
    ON cashbook.withdrawal_orders (tenant_id, source_ref) WHERE source_ref IS NOT NULL AND state IN ('vigente','usada')`);
  for (const k of ['cashbook_orden_rechazo_con_motivo', 'cashbook_orden_decision_completa', 'cashbook_orden_firma_otro',
    'cashbook_orden_codigo_al_firmar', 'cashbook_orden_estado', 'cashbook_orden_monto']) {
    await knex.raw(`ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS ${k}`);
  }
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT withdrawal_orders_state_check
    CHECK (state IN ('vigente','usada','vencida','anulada'))`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT withdrawal_orders_amount_minor_check CHECK (amount_minor > 0)`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ALTER COLUMN code SET NOT NULL`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ALTER COLUMN seq SET NOT NULL`);
  // `issue_order` y `expire_orders` quedan en su forma ancha: sin órdenes nuevas, se comportan igual.
  await knex.raw(`RESET ROLE`);
};
