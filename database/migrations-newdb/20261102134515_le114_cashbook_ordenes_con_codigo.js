'use strict';
/**
 * `[LE.1.14]` — **Las órdenes con código**: lo que autoriza a sacar dinero de la máquina (V2, ADR-112).
 *
 * Una orden (pagar un X-D-26, custodia, reposición, fondo o depósito del cajón) lleva un código que
 * la cajera teclea al inicio de la referencia de CAOS. El carril de la máquina lo lee
 * (`codigo-orden.ts`) y asienta el retiro contra la orden; sin código, Suspenso con nombre.
 *
 * ⚠️ Se aparta del plan a propósito: LE.1.14 decía «`requests.code`». En `cashbook.requests`,
 * «autorizada» EXIGE el asiento (`cashbook_solicitud_autorizada_con_asiento`), y el asiento de un
 * retiro nace cuando la máquina entrega, no cuando se firma. La orden es otra cosa: un permiso con
 * saldo que se consume. Si pidió firma de Tesorería (V4), apunta a su solicitud.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-02) ─────────────────────────────────────────
 *  · 148 retiros desde el 1-oct; referencia de 10 a 42 caracteres; el formato `XXXX-D` al inicio
 *    aparece 0 veces en toda la historia de la máquina.
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `cashbook.withdrawal_orders`: una fila por orden, con su saldo (`used_minor` ≤ `amount_minor`),
 *    su vigencia y su clasificación. Un código vigente es único; un documento de Kepler se paga una vez.
 *  · `cashbook._codigo(seq)`: el MISMO algoritmo que `armarCodigo()` (paridad probada en
 *    `test-newdb-cashbook-ordenes.js`).
 *  · `issue_order(jsonb)`, `consume_order(text, bigint, timestamptz)`, `expire_orders()`: las únicas
 *    escrituras (D10: `app_runtime` sólo lee el libro).
 *
 * Tabla nueva y funciones nuevas: la API desplegada no las usa todavía (expand/contract).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = `
CREATE TABLE IF NOT EXISTS cashbook.withdrawal_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  seq                 bigint NOT NULL,
  code                text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{4}-[0-9]$'),
  kind                text NOT NULL CHECK (kind IN ('pago','custodia','reposicion','fondo_cajon','deposito_cajon')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  used_minor          bigint NOT NULL DEFAULT 0,
  classification      jsonb NOT NULL CHECK (classification->>'tipo' IN ('cajon','custodia','banco')),
  source_ref          text,
  request_id          uuid,
  issued_by           uuid NOT NULL,
  issued_by_employee  uuid,
  expires_at          timestamptz NOT NULL,
  state               text NOT NULL DEFAULT 'vigente' CHECK (state IN ('vigente','usada','vencida','anulada')),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by          uuid,
  CONSTRAINT cashbook_orden_saldo CHECK (used_minor >= 0 AND used_minor <= amount_minor),
  CONSTRAINT cashbook_orden_usada_es_completa CHECK ((state = 'usada') = (used_minor = amount_minor)),
  CONSTRAINT cashbook_orden_pago_con_documento CHECK (kind <> 'pago' OR source_ref IS NOT NULL),
  CONSTRAINT cashbook_orden_seq_unica UNIQUE (tenant_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cashbook_orden_codigo_vigente
  ON cashbook.withdrawal_orders (tenant_id, code) WHERE state = 'vigente';
CREATE UNIQUE INDEX IF NOT EXISTS ux_cashbook_orden_documento_una_vez
  ON cashbook.withdrawal_orders (tenant_id, source_ref) WHERE source_ref IS NOT NULL AND state IN ('vigente','usada');
`;

const FUNCIONES = `
-- El mismo algoritmo que armarCodigo() en libs/finance/src/lib/cashbook/codigo-orden.ts.
CREATE OR REPLACE FUNCTION cashbook._codigo(p_seq bigint) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  pesos int[] := ARRAY[3, 7, 9, 1];
  x bigint := (p_seq * 747353 + 12345) % 1048576;
  cuerpo text := ''; s int := 0; i int;
BEGIN
  FOR i IN 1..4 LOOP cuerpo := substr(a, (x % 32)::int + 1, 1) || cuerpo; x := x / 32; END LOOP;
  FOR i IN 1..4 LOOP s := s + (strpos(a, substr(cuerpo, i, 1))) * pesos[i]; END LOOP;
  RETURN cuerpo || '-' || (s % 10)::text;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.issue_order(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  v_user uuid := nullif(p->'actor'->>'user_id', '')::uuid;
  v_seq bigint; v_code text; v_id uuid; v_vence timestamptz := nullif(p->>'expires_at', '')::timestamptz;
BEGIN
  IF v_user IS NULL THEN PERFORM cashbook._falla('cashbook_orden_actor', 'una orden la emite una persona con su usuario'); END IF;
  IF v_vence IS NULL OR v_vence <= clock_timestamp() THEN PERFORM cashbook._falla('cashbook_orden_sin_plazo', 'toda orden vence (V2)'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cashbook.withdrawal_orders:' || v_t::text));
  SELECT coalesce(max(seq), 0) + 1 INTO v_seq FROM cashbook.withdrawal_orders WHERE tenant_id = v_t;
  v_code := cashbook._codigo(v_seq);
  -- Un código vigente no se repite: si el ciclo diera uno vivo, se salta al siguiente.
  WHILE EXISTS (SELECT 1 FROM cashbook.withdrawal_orders WHERE tenant_id = v_t AND code = v_code AND state = 'vigente') LOOP
    v_seq := v_seq + 1; v_code := cashbook._codigo(v_seq);
  END LOOP;
  INSERT INTO cashbook.withdrawal_orders (tenant_id, seq, code, kind, amount_minor, classification, source_ref, request_id,
    issued_by, issued_by_employee, expires_at, created_by, updated_by)
  VALUES (v_t, v_seq, v_code, p->>'kind', (p->>'amount_minor')::bigint, p->'classification', nullif(p->>'source_ref', ''),
    nullif(p->>'request_id', '')::uuid, v_user, nullif(p->'actor'->>'employee_id', '')::uuid, v_vence, v_user, v_user)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'seq', v_seq);
END $fn$;

-- La máquina entregó con un código: se descuenta del saldo de la orden, o se dice por qué no.
CREATE OR REPLACE FUNCTION cashbook.consume_order(p_code text, p_amount_minor bigint, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  o cashbook.withdrawal_orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM cashbook.withdrawal_orders WHERE tenant_id = v_t AND code = upper(p_code) AND state = 'vigente' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'motivo', 'desconocido'); END IF;
  IF p_at > o.expires_at THEN RETURN jsonb_build_object('ok', false, 'motivo', 'vencido'); END IF;
  IF p_amount_minor <= 0 OR o.used_minor + p_amount_minor > o.amount_minor THEN RETURN jsonb_build_object('ok', false, 'motivo', 'de_mas'); END IF;
  UPDATE cashbook.withdrawal_orders
     SET used_minor = used_minor + p_amount_minor,
         state = CASE WHEN used_minor + p_amount_minor = amount_minor THEN 'usada' ELSE 'vigente' END,
         updated_at = clock_timestamp()
   WHERE id = o.id;
  RETURN jsonb_build_object('ok', true, 'order_id', o.id, 'kind', o.kind, 'classification', o.classification,
    'source_ref', o.source_ref, 'remaining_minor', o.amount_minor - o.used_minor - p_amount_minor);
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.expire_orders() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_n integer;
BEGIN
  UPDATE cashbook.withdrawal_orders SET state = 'vencida', updated_at = clock_timestamp()
   WHERE tenant_id = cashbook._tenant() AND state = 'vigente' AND expires_at < clock_timestamp();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;
`;

const PUBLICAS = ['issue_order(jsonb)', 'consume_order(text, bigint, timestamptz)', 'expire_orders()'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook._tenant()') IS NOT NULL AS hay`);
  if (!h.hay) throw new Error('[LE.1.14] falta el libro (20261027111930): se aplica después.');

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(TABLA);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON cashbook.withdrawal_orders`);
  await knex.raw(`CREATE POLICY tenant_isolation ON cashbook.withdrawal_orders
    USING (tenant_id = cashbook.current_tenant()) WITH CHECK (tenant_id = cashbook.current_tenant())`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_sin_truncate ON cashbook.withdrawal_orders`);
  await knex.raw(`CREATE TRIGGER trg_cashbook_sin_truncate BEFORE TRUNCATE ON cashbook.withdrawal_orders
    FOR EACH STATEMENT EXECUTE FUNCTION cashbook.sin_truncate()`);
  await knex.raw(FUNCIONES);
  await knex.raw(`RESET ROLE`);

  await knex.raw(`REVOKE ALL ON cashbook.withdrawal_orders FROM PUBLIC`);
  await knex.raw(`REVOKE ALL ON cashbook.withdrawal_orders FROM app_runtime`);
  await knex.raw(`GRANT SELECT ON cashbook.withdrawal_orders TO app_runtime`);
  await knex.raw(`REVOKE ALL ON FUNCTION cashbook._codigo(bigint) FROM PUBLIC`);
  for (const f of PUBLICAS) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
  const { rows: [ro] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') AS hay`);
  if (ro.hay) await knex.raw(`GRANT SELECT ON cashbook.withdrawal_orders TO dev_ro`);
};

/** Sólo con la tabla vacía: una orden emitida es historia del dinero (B23). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [n] } = await knex.raw(`SELECT to_regclass('cashbook.withdrawal_orders') IS NOT NULL AS hay`);
  if (n.hay) {
    const { rows: [c] } = await knex.raw(`SELECT count(*)::int AS n FROM cashbook.withdrawal_orders`);
    if (c.n > 0) throw new Error(`[LE.1.14] hay ${c.n} órdenes emitidas: no se deshace.`);
  }
  for (const f of [...PUBLICAS, '_codigo(bigint)']) await knex.raw(`DROP FUNCTION IF EXISTS cashbook.${f}`);
  await knex.raw(`DROP TABLE IF EXISTS cashbook.withdrawal_orders`);
};
