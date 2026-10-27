'use strict';
/**
 * `[LE.1.9]` — Conteos, hallazgos y la cola de excepciones del libro de efectivo (Fase LE; reglas
 * B11, B17, B18, B41, B46). Lo que E3 necesita para comparar el libro contra sus testigos.
 *
 * ── Por qué (medido 2026-10-27) ──────────────────────────────────────────────────────────────
 *  · Tres tablas de conteo físico en el sistema viejo, las tres VACÍAS (`cash_arqueos`,
 *    `caos_conteos_fisicos`, `caos_cash_counts`): ningún arqueo deja rastro comparable.
 *  · La reconstrucción (LE.3.4) dejó un residuo de $49,860 en septiembre que hoy no tiene dónde
 *    vivir con dueño y antigüedad: ése es un hallazgo.
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `counts` + `count_pieces`: un conteo (de una persona o de la máquina) es INMUTABLE y se compara
 *    contra el saldo de la cuenta HASTA un asiento (`upto_seq`, bajo el candado del libro). La base
 *    guarda contado y esperado por denominación; la diferencia la calcula ella (arqueo ciego: quien
 *    cuenta manda piezas, nunca una diferencia).
 *  · `findings`: toda diferencia es un hallazgo con monto, cuenta, antigüedad y dueño. Se cierra
 *    SÓLO con un asiento (que ya pasó por sus cuatro ojos) o con una nota que autoriza OTRA persona.
 *    Uno cerrado no se reabre ni se edita.
 *  · `external_queue`: el hecho de fuera que no se puede asentar (sin regla, hueco en la
 *    numeración) se guarda una vez por (fuente, referencia) y espera a que alguien lo resuelva:
 *    nunca se pierde y nunca se fuerza (B41).
 *  · `close_day` ahora: (1) NO cierra si la cabecera de algún saldo no es la suma de sus líneas
 *    (`v_descuadre_interno`, I10), y (2) abre un hallazgo por cada Suspenso distinto de cero (B46).
 *
 * Idempotente. Prueba: `database/tests/test-newdb-cashbook-conteos.js`.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = `
CREATE TABLE IF NOT EXISTS cashbook.counts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  account_id           uuid NOT NULL REFERENCES cashbook.accounts(id),
  kind                 text NOT NULL CHECK (kind IN ('cierre','sorpresa','relevo','maquina')),
  source               text NOT NULL CHECK (source IN ('persona','maquina')),
  source_ref           text,
  counted_by           uuid,
  counted_by_employee  uuid,
  witness_by           uuid,
  service_name         text,
  blind                boolean NOT NULL,
  upto_seq             bigint NOT NULL,
  counted_at           timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  total_minor          bigint NOT NULL,
  expected_minor       bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by           uuid,
  CONSTRAINT cashbook_conteo_quien CHECK ((source = 'persona' AND counted_by IS NOT NULL AND kind <> 'maquina')
    OR (source = 'maquina' AND service_name IS NOT NULL AND kind = 'maquina')),
  CONSTRAINT cashbook_conteo_sorpresa_con_testigo CHECK (kind <> 'sorpresa' OR (witness_by IS NOT NULL AND witness_by IS DISTINCT FROM counted_by)),
  CONSTRAINT cashbook_conteo_unico_por_fuente UNIQUE (tenant_id, source, source_ref)
);

CREATE TABLE IF NOT EXISTS cashbook.count_pieces (
  count_id   uuid NOT NULL REFERENCES cashbook.counts(id),
  tenant_id  uuid NOT NULL,
  currency   char(3) NOT NULL,
  denom_key  text NOT NULL,
  counted    bigint NOT NULL CHECK (counted >= 0),
  expected   bigint NOT NULL,
  PRIMARY KEY (count_id, denom_key),
  FOREIGN KEY (currency, denom_key) REFERENCES cashbook.denominations (currency, denom_key)
);

CREATE TABLE IF NOT EXISTS cashbook.findings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  source                 text NOT NULL CHECK (source IN ('conteo','cierre','feed','reconstruccion','otro')),
  account_id             uuid REFERENCES cashbook.accounts(id),
  count_id               uuid REFERENCES cashbook.counts(id),
  business_date          date,
  amount_minor           bigint NOT NULL,
  detail                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  owner_user             uuid,
  state                  text NOT NULL DEFAULT 'abierto' CHECK (state IN ('abierto','cerrado')),
  opened_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at              timestamptz,
  closed_by              uuid,
  closed_by_employee     uuid,
  closing_entry_id       uuid REFERENCES cashbook.entries(id),
  closing_note           text,
  closing_authorized_by  uuid,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by             uuid,
  CONSTRAINT cashbook_hallazgo_cierre_completo CHECK ((state = 'cerrado') = (closed_at IS NOT NULL AND closed_by IS NOT NULL)),
  CONSTRAINT cashbook_hallazgo_se_cierra_con_algo CHECK (state <> 'cerrado' OR closing_entry_id IS NOT NULL
    OR (length(trim(coalesce(closing_note, ''))) > 0 AND closing_authorized_by IS NOT NULL AND closing_authorized_by <> closed_by))
);
CREATE INDEX IF NOT EXISTS ix_cashbook_hallazgos_abiertos ON cashbook.findings (tenant_id, opened_at) WHERE state = 'abierto';

CREATE TABLE IF NOT EXISTS cashbook.external_queue (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  source               text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]*$'),
  event_ref            text NOT NULL,
  payload              jsonb NOT NULL,
  reason               text NOT NULL CHECK (length(trim(reason)) > 0),
  state                text NOT NULL DEFAULT 'pendiente' CHECK (state IN ('pendiente','resuelto')),
  resolved_at          timestamptz,
  resolved_by          uuid,
  resolution_entry_id  uuid REFERENCES cashbook.entries(id),
  resolution_note      text,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by           uuid,
  CONSTRAINT cashbook_excepcion_unica UNIQUE (tenant_id, source, event_ref),
  CONSTRAINT cashbook_excepcion_resuelta CHECK ((state = 'resuelto') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL
    AND (resolution_entry_id IS NOT NULL OR length(trim(coalesce(resolution_note, ''))) > 0)))
);
`;

const NUEVAS = ['counts', 'count_pieces', 'findings', 'external_queue'];

const FUNCIONES = `
-- Un conteo, contra el saldo HASTA el último asiento (bajo el candado del libro). Devuelve la
-- diferencia DESPUÉS de guardarlo: quien cuenta nunca manda una diferencia, manda piezas (B11).
CREATE OR REPLACE FUNCTION cashbook.register_count(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  v_acc record; v_seq bigint; v_id uuid; v_ya record; pz record;
  v_total bigint := 0; v_esperado bigint := 0; v_hallazgo uuid; v_dif jsonb := '{}'::jsonb;
  v_source text := coalesce(p->>'source', 'persona');
BEGIN
  INSERT INTO cashbook.seq_counters (tenant_id) VALUES (v_t) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT last_seq INTO v_seq FROM cashbook.seq_counters WHERE tenant_id = v_t FOR UPDATE;

  IF nullif(p->>'source_ref', '') IS NOT NULL THEN
    SELECT c.id, c.total_minor, c.expected_minor INTO v_ya FROM cashbook.counts c
     WHERE c.tenant_id = v_t AND c.source = v_source AND c.source_ref = p->>'source_ref';
    IF FOUND THEN
      RETURN jsonb_build_object('count_id', v_ya.id, 'total_minor', v_ya.total_minor::text, 'expected_minor', v_ya.expected_minor::text,
        'difference_minor', (v_ya.total_minor - v_ya.expected_minor)::text, 'finding_id',
        (SELECT f.id FROM cashbook.findings f WHERE f.count_id = v_ya.id), 'repetido', true);
    END IF;
  END IF;

  SELECT a.* INTO v_acc FROM cashbook.accounts a WHERE a.tenant_id = v_t AND a.code = p->>'account';
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_cuenta_inexistente', coalesce(p->>'account', '(vacía)')); END IF;
  IF NOT v_acc.tracks_pieces THEN PERFORM cashbook._falla('cashbook_cuenta_sin_desglose', v_acc.code || ' no se cuenta por pieza'); END IF;
  IF jsonb_typeof(p->'pieces') IS DISTINCT FROM 'object' THEN PERFORM cashbook._falla('cashbook_conteo_sin_piezas', 'un conteo trae piezas por denominación'); END IF;
  IF nullif(p->>'counted_at', '') IS NULL OR (p->>'counted_at')::timestamptz > clock_timestamp() + interval '5 minutes' THEN
    PERFORM cashbook._falla('cashbook_fecha_futura', coalesce(p->>'counted_at', '(sin hora del conteo)'));
  END IF;

  INSERT INTO cashbook.counts (tenant_id, account_id, kind, source, source_ref, counted_by, counted_by_employee, witness_by,
         service_name, blind, upto_seq, counted_at, total_minor, expected_minor, created_by)
  VALUES (v_t, v_acc.id, p->>'kind', v_source, nullif(p->>'source_ref', ''), nullif(p->>'counted_by', '')::uuid,
         nullif(p->>'counted_by_employee', '')::uuid, nullif(p->>'witness_by', '')::uuid, nullif(p->>'service', ''),
         coalesce((p->>'blind')::boolean, true), v_seq, (p->>'counted_at')::timestamptz, 0, 0, nullif(p->>'counted_by', '')::uuid)
  RETURNING id INTO v_id;

  -- Lo contado, validado contra el catálogo.
  FOR pz IN SELECT key, value FROM jsonb_each_text(p->'pieces') LOOP
    IF pz.value !~ '^[0-9]{1,9}$' THEN PERFORM cashbook._falla('cashbook_pieza_invalida', pz.key || ' = ' || pz.value); END IF;
    IF NOT EXISTS (SELECT 1 FROM cashbook.denominations d WHERE d.currency = v_acc.currency AND d.denom_key = pz.key) THEN
      PERFORM cashbook._falla('cashbook_denominacion_fuera_de_catalogo', v_acc.currency || ' ' || pz.key);
    END IF;
  END LOOP;

  -- Contado y esperado por denominación (la unión de las dos listas).
  INSERT INTO cashbook.count_pieces (count_id, tenant_id, currency, denom_key, counted, expected)
  SELECT v_id, v_t, v_acc.currency, k, coalesce(c.n, 0), coalesce(b.pieces, 0)
    FROM (SELECT key AS k FROM jsonb_each_text(p->'pieces')
          UNION SELECT denom_key FROM cashbook.account_piece_balances WHERE account_id = v_acc.id AND pieces <> 0) llaves
    LEFT JOIN (SELECT key, value::bigint AS n FROM jsonb_each_text(p->'pieces')) c ON c.key = llaves.k
    LEFT JOIN cashbook.account_piece_balances b ON b.account_id = v_acc.id AND b.denom_key = llaves.k;

  SELECT coalesce(sum(cp.counted * d.value_minor), 0), coalesce(sum(cp.expected * d.value_minor), 0),
         coalesce(jsonb_object_agg(cp.denom_key, (cp.counted - cp.expected)::text) FILTER (WHERE cp.counted <> cp.expected), '{}'::jsonb)
    INTO v_total, v_esperado, v_dif
    FROM cashbook.count_pieces cp JOIN cashbook.denominations d ON d.currency = cp.currency AND d.denom_key = cp.denom_key
   WHERE cp.count_id = v_id;
  -- El único UPDATE que admite un conteo: los totales, en la misma transacción que lo crea.
  PERFORM set_config('cashbook.sellando_conteo', v_id::text, true);
  UPDATE cashbook.counts SET total_minor = v_total, expected_minor = v_esperado WHERE id = v_id;
  PERFORM set_config('cashbook.sellando_conteo', '', true);

  IF v_dif <> '{}'::jsonb THEN
    INSERT INTO cashbook.findings (tenant_id, source, account_id, count_id, business_date, amount_minor, detail, owner_user, created_by)
    VALUES (v_t, 'conteo', v_acc.id, v_id,
            (SELECT business_date FROM cashbook.business_days WHERE tenant_id = v_t AND state = 'abierta'),
            v_total - v_esperado, jsonb_build_object('piezas', v_dif, 'kind', p->>'kind', 'upto_seq', v_seq),
            nullif(p->>'owner_user', '')::uuid, nullif(p->>'counted_by', '')::uuid)
    RETURNING id INTO v_hallazgo;
  END IF;
  RETURN jsonb_build_object('count_id', v_id, 'total_minor', v_total::text, 'expected_minor', v_esperado::text,
    'difference_minor', (v_total - v_esperado)::text, 'difference_pieces', v_dif, 'finding_id', v_hallazgo, 'upto_seq', v_seq::text);
END $fn$;

-- Un hallazgo se cierra con un asiento (que ya pasó sus cuatro ojos) o con una nota que autoriza OTRA persona.
CREATE OR REPLACE FUNCTION cashbook.close_finding(p_id uuid, p_user uuid, p_employee uuid, p_entry uuid, p_note text, p_authorizer uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); f record;
BEGIN
  SELECT * INTO f FROM cashbook.findings WHERE id = p_id AND tenant_id = v_t FOR UPDATE;
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_hallazgo_inexistente', p_id::text); END IF;
  IF f.state <> 'abierto' THEN PERFORM cashbook._falla('cashbook_estado_final', 'el hallazgo ya está cerrado'); END IF;
  IF p_user IS NULL THEN PERFORM cashbook._falla('cashbook_asiento_actor', 'cierra una persona'); END IF;
  IF p_entry IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cashbook.entries e WHERE e.id = p_entry AND e.tenant_id = v_t) THEN
    PERFORM cashbook._falla('cashbook_asiento_inexistente', p_entry::text);
  END IF;
  UPDATE cashbook.findings SET state = 'cerrado', closed_at = clock_timestamp(), closed_by = p_user, closed_by_employee = p_employee,
         closing_entry_id = p_entry, closing_note = nullif(trim(coalesce(p_note, '')), ''), closing_authorized_by = p_authorizer,
         updated_at = clock_timestamp(), updated_by = p_user
   WHERE id = p_id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.enqueue_external(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); v_id uuid;
BEGIN
  INSERT INTO cashbook.external_queue (tenant_id, source, event_ref, payload, reason, created_by)
  VALUES (v_t, p->>'source', p->>'event_ref', coalesce(p->'payload', '{}'::jsonb), p->>'reason', nullif(p->>'user_id', '')::uuid)
  ON CONFLICT (tenant_id, source, event_ref) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM cashbook.external_queue WHERE tenant_id = v_t AND source = p->>'source' AND event_ref = p->>'event_ref';
  END IF;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.resolve_external(p_id uuid, p_user uuid, p_entry uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); q record;
BEGIN
  SELECT * INTO q FROM cashbook.external_queue WHERE id = p_id AND tenant_id = v_t FOR UPDATE;
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_excepcion_inexistente', p_id::text); END IF;
  IF q.state <> 'pendiente' THEN PERFORM cashbook._falla('cashbook_estado_final', 'la excepción ya está resuelta'); END IF;
  UPDATE cashbook.external_queue SET state = 'resuelto', resolved_at = clock_timestamp(), resolved_by = p_user,
         resolution_entry_id = p_entry, resolution_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = clock_timestamp(), updated_by = p_user
   WHERE id = p_id;
END $fn$;

-- El cierre: no cierra con descuadre interno (I10) y abre un hallazgo por cada Suspenso ≠ 0 (B46).
CREATE OR REPLACE FUNCTION cashbook.close_day(p_date date, p_user uuid, p_employee uuid, p_auth uuid, p_auth_employee uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); c record; s record;
BEGIN
  IF p_user IS NULL OR p_auth IS NULL THEN PERFORM cashbook._falla('cashbook_cierre_completo', 'cierra una persona y autoriza otra'); END IF;
  INSERT INTO cashbook.seq_counters (tenant_id) VALUES (v_t) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT last_seq, last_hash INTO c FROM cashbook.seq_counters WHERE tenant_id = v_t FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM cashbook.business_days WHERE tenant_id = v_t AND business_date = p_date AND state = 'abierta') THEN
    PERFORM cashbook._falla('cashbook_sin_jornada_abierta', p_date || ' no es la jornada abierta');
  END IF;
  IF EXISTS (SELECT 1 FROM cashbook.v_descuadre_interno WHERE tenant_id = v_t) THEN
    PERFORM cashbook._falla('cashbook_descuadre_interno', 'la cabecera de algún saldo no es la suma de sus líneas: no se cierra, es un incidente (B37)');
  END IF;
  FOR s IN SELECT a.id, a.code, b.balance_minor FROM cashbook.accounts a JOIN cashbook.account_balances b ON b.account_id = a.id
            WHERE a.tenant_id = v_t AND a.class = 'sistema' AND a.code LIKE 'SUSPENSO%' AND b.balance_minor <> 0 LOOP
    INSERT INTO cashbook.findings (tenant_id, source, account_id, business_date, amount_minor, detail, created_by)
    VALUES (v_t, 'cierre', s.id, p_date, s.balance_minor,
            jsonb_build_object('motivo', s.code || ' distinto de cero al cierre: dinero sin explicación (B46)', 'closing_seq', c.last_seq), p_user);
  END LOOP;
  UPDATE cashbook.business_days
     SET state = 'cerrada', closed_at = clock_timestamp(), closed_by = p_user, closed_by_employee = p_employee,
         authorized_by = p_auth, authorized_by_employee = p_auth_employee, closing_seq = c.last_seq,
         closing_hash = c.last_hash, updated_at = clock_timestamp(), updated_by = p_user
   WHERE tenant_id = v_t AND business_date = p_date;
END $fn$;

-- Un conteo no cambia; el único UPDATE es el de sus totales al crearlo (marca de sesión local).
CREATE OR REPLACE FUNCTION cashbook.conteo_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('cashbook.sellando_conteo', true) = OLD.id::text
     AND (to_jsonb(NEW) - 'total_minor' - 'expected_minor') = (to_jsonb(OLD) - 'total_minor' - 'expected_minor') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable',
    DETAIL = TG_OP || ' sobre cashbook.counts: un conteo no se corrige, se cuenta otra vez';
END $fn$;

-- Un hallazgo cerrado o una excepción resuelta ya no cambian.
CREATE OR REPLACE FUNCTION cashbook.cerrado_es_final() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable', DETAIL = 'DELETE sobre cashbook.' || TG_TABLE_NAME;
  END IF;
  IF OLD.state IN ('cerrado', 'resuelto') THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_ESTADO_FINAL', ERRCODE = '23514', CONSTRAINT = 'cashbook_estado_final',
      DETAIL = 'cashbook.' || TG_TABLE_NAME || ' en estado ' || OLD.state || ' ya no cambia';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_cashbook_conteos_inmutable ON cashbook.counts;
CREATE TRIGGER trg_cashbook_conteos_inmutable BEFORE UPDATE OR DELETE ON cashbook.counts FOR EACH ROW EXECUTE FUNCTION cashbook.conteo_inmutable();
DROP TRIGGER IF EXISTS trg_cashbook_piezas_conteo_inmutable ON cashbook.count_pieces;
CREATE TRIGGER trg_cashbook_piezas_conteo_inmutable BEFORE UPDATE OR DELETE ON cashbook.count_pieces FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable();
DROP TRIGGER IF EXISTS trg_cashbook_hallazgos_final ON cashbook.findings;
CREATE TRIGGER trg_cashbook_hallazgos_final BEFORE UPDATE OR DELETE ON cashbook.findings FOR EACH ROW EXECUTE FUNCTION cashbook.cerrado_es_final();
DROP TRIGGER IF EXISTS trg_cashbook_excepciones_final ON cashbook.external_queue;
CREATE TRIGGER trg_cashbook_excepciones_final BEFORE UPDATE OR DELETE ON cashbook.external_queue FOR EACH ROW EXECUTE FUNCTION cashbook.cerrado_es_final();

CREATE OR REPLACE VIEW cashbook.v_hallazgos_abiertos WITH (security_invoker = true) AS
SELECT f.tenant_id, f.id, f.source, a.code AS account_code, f.business_date, f.amount_minor,
       (f.amount_minor::numeric / 100)::numeric(18,2) AS amount, f.detail, f.owner_user, f.opened_at,
       (current_date - f.opened_at::date) AS dias_abierto
  FROM cashbook.findings f LEFT JOIN cashbook.accounts a ON a.id = f.account_id
 WHERE f.state = 'abierto';
`;

/** El `close_day` de `20261027111930`, para que `down` deje la función EXACTAMENTE como estaba. */
const CLOSE_DAY_ANTERIOR = `
CREATE OR REPLACE FUNCTION cashbook.close_day(p_date date, p_user uuid, p_employee uuid, p_auth uuid, p_auth_employee uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); c record;
BEGIN
  IF p_user IS NULL OR p_auth IS NULL THEN PERFORM cashbook._falla('cashbook_cierre_completo', 'cierra una persona y autoriza otra'); END IF;
  INSERT INTO cashbook.seq_counters (tenant_id) VALUES (v_t) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT last_seq, last_hash INTO c FROM cashbook.seq_counters WHERE tenant_id = v_t FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM cashbook.business_days WHERE tenant_id = v_t AND business_date = p_date AND state = 'abierta') THEN
    PERFORM cashbook._falla('cashbook_sin_jornada_abierta', p_date || ' no es la jornada abierta');
  END IF;
  UPDATE cashbook.business_days
     SET state = 'cerrada', closed_at = clock_timestamp(), closed_by = p_user, closed_by_employee = p_employee,
         authorized_by = p_auth, authorized_by_employee = p_auth_employee, closing_seq = c.last_seq,
         closing_hash = c.last_hash, updated_at = clock_timestamp(), updated_by = p_user
   WHERE tenant_id = v_t AND business_date = p_date;
END $fn$;
`;

const PUBLICAS = ['register_count(jsonb)', 'close_finding(uuid, uuid, uuid, uuid, text, uuid)', 'enqueue_external(jsonb)',
  'resolve_external(uuid, uuid, uuid, text)'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook._post(jsonb, uuid, uuid, uuid)') IS NOT NULL AS hay`);
  if (!h.hay) throw new Error('[LE.1.9] falta el libro (20261027111930): se aplica después.');

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(TABLAS);
  for (const t of NUEVAS) {
    await knex.raw(`ALTER TABLE cashbook.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE cashbook.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON cashbook.${t}`);
    await knex.raw(`CREATE POLICY tenant_isolation ON cashbook.${t}
      USING (tenant_id = cashbook.current_tenant()) WITH CHECK (tenant_id = cashbook.current_tenant())`);
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_sin_truncate ON cashbook.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_sin_truncate BEFORE TRUNCATE ON cashbook.${t}
      FOR EACH STATEMENT EXECUTE FUNCTION cashbook.sin_truncate()`);
  }
  await knex.raw(FUNCIONES);
  const { rows: [hist] } = await knex.raw(`SELECT to_regprocedure('analytics.log_master_data_change()') IS NOT NULL AS f`);
  if (hist.f) {
    for (const [t, cols] of Object.entries({
      findings: "'state', 'closed_by', 'closing_entry_id', 'closing_note', 'closing_authorized_by'",
      external_queue: "'state', 'resolved_by', 'resolution_entry_id', 'resolution_note'",
    })) {
      await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON cashbook.${t}`);
      await knex.raw(`CREATE TRIGGER trg_master_data_history AFTER UPDATE OR DELETE ON cashbook.${t}
        FOR EACH ROW EXECUTE FUNCTION analytics.log_master_data_change(${cols})`);
    }
  }
  await knex.raw(`RESET ROLE`);

  for (const t of [...NUEVAS, 'v_hallazgos_abiertos']) {
    await knex.raw(`REVOKE ALL ON cashbook.${t} FROM PUBLIC`);
    await knex.raw(`REVOKE ALL ON cashbook.${t} FROM app_runtime`);
    await knex.raw(`GRANT SELECT ON cashbook.${t} TO app_runtime`);
  }
  for (const f of [...PUBLICAS, 'close_day(date, uuid, uuid, uuid, uuid)']) {
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
  for (const f of ['conteo_inmutable()', 'cerrado_es_final()']) await knex.raw(`REVOKE ALL ON FUNCTION cashbook.${f} FROM PUBLIC`);
  const { rows: [ro] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') AS hay`);
  if (ro.hay) for (const t of [...NUEVAS, 'v_hallazgos_abiertos']) await knex.raw(`GRANT SELECT ON cashbook.${t} TO dev_ro`);
};

/** Sólo con las tablas nuevas vacías: un conteo o un hallazgo no se borran (B23). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [c] } = await knex.raw(`SELECT
      (SELECT count(*) FROM cashbook.counts) + (SELECT count(*) FROM cashbook.findings) + (SELECT count(*) FROM cashbook.external_queue) AS n`);
  if (Number(c.n) > 0) throw new Error(`[LE.1.9] hay ${c.n} conteos/hallazgos/excepciones: no se bajan, se congelan (B23).`);
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(CLOSE_DAY_ANTERIOR);
  await knex.raw(`DROP VIEW IF EXISTS cashbook.v_hallazgos_abiertos`);
  // Primero las tablas (se llevan sus triggers), después las funciones de las que dependían.
  for (const t of ['external_queue', 'findings', 'count_pieces', 'counts']) await knex.raw(`DROP TABLE IF EXISTS cashbook.${t}`);
  for (const f of [...PUBLICAS, 'conteo_inmutable()', 'cerrado_es_final()']) await knex.raw(`DROP FUNCTION IF EXISTS cashbook.${f}`);
  await knex.raw(`RESET ROLE`);
};
