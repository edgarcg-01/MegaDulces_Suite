'use strict';
/**
 * `[LE.6.12]` — **Un documento de Kepler entra a UN solo libro** (D40, PM 2026-11-05).
 *
 * Mientras Captura (`finance.cash_ledger`) y la Ventanilla (`cashbook`) convivan, el mismo X-D-26,
 * X-D-60 o U-A-5 no puede registrarse en los dos. La Ventanilla ya le preguntaba al libro viejo antes
 * de asentar; el viejo NUNCA le preguntaba al nuevo: la vista de pendientes no menciona `cashbook`
 * (§5.6 del plan), así que lo pagado en la Ventanilla seguía en la cola de Captura, del lote y del
 * autollenado. La regla baja a la base, en los dos sentidos, con un candado por documento para que dos
 * personas no lo registren al mismo tiempo en las dos pantallas:
 *
 *  · `finance.caja_documento_lock(tenant, ref)`: el candado de transacción del documento, el MISMO en
 *    los dos lados (la segunda escritura espera a que la primera termine y entonces ya la ve).
 *  · `finance.caja_documento_en_captura(tenant, ref)`: el folio vivo del libro viejo que lo trae
 *    (`origen_ref` o `declared_doc_ref`, sin cancelados), o NULL.
 *  · `cashbook.documento_tomado(ref)`: qué lo tomó en el libro nuevo —orden de pago o de reposición
 *    viva, asiento de cobro o de rendición sin reversa, o solicitud que espera—, o NULL.
 *  · `finance.cash_ledger`: alta, o cambio que lo vuelve vivo o le cambia el documento →
 *    `caja_documento_en_el_libro_chk`. Cerrar un corte (registrado → en_corte) no se vuelve a revisar.
 *  · `cashbook.withdrawal_orders`, `cashbook.entries` y `cashbook.requests` (alta) →
 *    `cashbook_documento_en_captura`.
 *
 * ── Lo medido antes (copia de prod del 2026-11-05 11:12, sólo lectura) ──────────────────────────
 *  · 0 roles y 0 personas con `FINANCE_CAJA_VENTANILLA`: hoy nadie registra pagos ni cobros en el
 *    libro nuevo, así que ningún renglón existente queda en conflicto. La regla mira altas.
 *  · Captura registra ~30 movimientos al día (4 cuentas). El rechazo nuevo sólo aparece cuando el
 *    documento ya está en el otro libro.
 *
 * ⚠️ Límite declarado: el libro nuevo se lee con su RLS, por el inquilino de la sesión
 * (`app.tenant_id`, que la API siempre pone). Un alta en `finance.cash_ledger` hecha fuera de ese
 * contexto (una corrección por SQL) no se puede decidir y no se frena.
 *
 * Expand/contract: no exige nada que la API desplegada no mande; sólo rechaza el doble registro. El
 * libro nuevo sigue sin permiso de escritura para `app_runtime` (D10). Idempotente.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_LE_LIBRO_DE_EFECTIVO.md` §5.6–§5.7.
 *
 * @param { import("knex").Knex } knex
 */

// Lo de `finance`: lo crea quien aplica la migración (el dueño del esquema), como `finance.caja_llave`.
const FINANCE = `
CREATE OR REPLACE FUNCTION finance.caja_documento_lock(p_tenant uuid, p_ref text) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $fn$
  SELECT pg_advisory_xact_lock(hashtextextended('caja-doc:' || p_tenant::text || ':' || p_ref, 0))
$fn$;

CREATE OR REPLACE FUNCTION finance.caja_documento_en_captura(p_tenant uuid, p_ref text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT l.folio FROM finance.cash_ledger l
   WHERE l.tenant_id = p_tenant AND (l.origen_ref = p_ref OR l.declared_doc_ref = p_ref)
     AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
   ORDER BY l.created_at LIMIT 1
$fn$;
`;

// Lo de `cashbook`: lo crea su dueño (D10).
const CASHBOOK = `
CREATE OR REPLACE FUNCTION cashbook.documento_tomado(p_ref text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
  SELECT coalesce(
    (SELECT 'orden de ' || o.kind || ' ' || o.state FROM cashbook.withdrawal_orders o
      WHERE o.tenant_id = cashbook.current_tenant() AND o.state IN ('por_firmar', 'vigente', 'usada')
        AND (o.source_ref = p_ref OR coalesce(o.act->'documentos', '[]'::jsonb) @> jsonb_build_array(p_ref))
      LIMIT 1),
    (SELECT 'asiento ' || e.event_kind FROM cashbook.entries e
      WHERE e.tenant_id = cashbook.current_tenant() AND e.event_ref IN ('cobro:' || p_ref, 'rinde:' || p_ref)
        AND NOT EXISTS (SELECT 1 FROM cashbook.entries r WHERE r.tenant_id = e.tenant_id AND r.reverses_entry_id = e.id)
      LIMIT 1),
    (SELECT 'solicitud ' || q.state FROM cashbook.requests q
      WHERE q.tenant_id = cashbook.current_tenant() AND q.state IN ('pendiente', 'autorizada')
        AND q.payload->>'event_ref' IN ('cobro:' || p_ref, 'rinde:' || p_ref)
      LIMIT 1))
$fn$;

-- Un documento que Captura ya tiene no entra al libro nuevo. Sólo los que parecen de Kepler (llave con «|»).
CREATE OR REPLACE FUNCTION cashbook._documento_libre_en_captura(p_ref text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid; v_folio text;
BEGIN
  IF nullif(btrim(p_ref), '') IS NULL OR position('|' in p_ref) = 0 THEN RETURN; END IF;
  v_t := cashbook._tenant();
  PERFORM finance.caja_documento_lock(v_t, p_ref);
  v_folio := finance.caja_documento_en_captura(v_t, p_ref);
  IF v_folio IS NOT NULL THEN
    PERFORM cashbook._falla('cashbook_documento_en_captura',
      format('el %s ya está registrado en Captura con el folio %s: un documento entra a un solo libro', p_ref, v_folio));
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.orden_un_solo_libro() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_ref text;
BEGIN
  IF NEW.state NOT IN ('por_firmar', 'vigente', 'usada') THEN RETURN NEW; END IF;
  FOR v_ref IN
    SELECT DISTINCT r FROM (
      SELECT NEW.source_ref AS r
      UNION ALL
      SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.act->'documentos') = 'array' THEN NEW.act->'documentos' ELSE '[]'::jsonb END)
    ) x WHERE r IS NOT NULL ORDER BY 1
  LOOP
    PERFORM cashbook._documento_libre_en_captura(v_ref);
  END LOOP;
  RETURN NEW;
END $fn$;

-- Un asiento o una solicitud de cobro o de rendición toman su documento; una reversa no toma nada.
CREATE OR REPLACE FUNCTION cashbook.asiento_un_solo_libro() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_ref text;
BEGIN
  IF TG_TABLE_NAME = 'entries' THEN
    IF NEW.reverses_entry_id IS NOT NULL THEN RETURN NEW; END IF;
    v_ref := NEW.event_ref;
  ELSE
    v_ref := NEW.payload->>'event_ref';
  END IF;
  IF v_ref LIKE 'cobro:%' OR v_ref LIKE 'rinde:%' THEN
    PERFORM cashbook._documento_libre_en_captura(substr(v_ref, position(':' in v_ref) + 1));
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_cashbook_orden_un_solo_libro ON cashbook.withdrawal_orders;
CREATE TRIGGER trg_cashbook_orden_un_solo_libro BEFORE INSERT ON cashbook.withdrawal_orders
  FOR EACH ROW EXECUTE FUNCTION cashbook.orden_un_solo_libro();
DROP TRIGGER IF EXISTS trg_cashbook_asiento_un_solo_libro ON cashbook.entries;
CREATE TRIGGER trg_cashbook_asiento_un_solo_libro BEFORE INSERT ON cashbook.entries
  FOR EACH ROW EXECUTE FUNCTION cashbook.asiento_un_solo_libro();
DROP TRIGGER IF EXISTS trg_cashbook_solicitud_un_solo_libro ON cashbook.requests;
CREATE TRIGGER trg_cashbook_solicitud_un_solo_libro BEFORE INSERT ON cashbook.requests
  FOR EACH ROW EXECUTE FUNCTION cashbook.asiento_un_solo_libro();
`;

// El disparador del libro viejo: lo crea el dueño de `finance.cash_ledger`.
const CAPTURA = `
CREATE OR REPLACE FUNCTION finance.cash_ledger_un_solo_libro() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE v_ref text; v_tomado text;
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.estado = 'cancelado' THEN RETURN NEW; END IF;
  -- Un renglón que ya estaba vivo y no cambió de documento no se vuelve a revisar (cerrar un corte).
  IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND OLD.estado <> 'cancelado'
     AND OLD.origen_ref IS NOT DISTINCT FROM NEW.origen_ref
     AND OLD.declared_doc_ref IS NOT DISTINCT FROM NEW.declared_doc_ref THEN
    RETURN NEW;
  END IF;
  -- El libro nuevo se lee por el inquilino de la sesión (su RLS); fuera de él no se puede decidir.
  IF cashbook.current_tenant() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;
  FOR v_ref IN
    SELECT DISTINCT r FROM unnest(ARRAY[NEW.origen_ref, NEW.declared_doc_ref]) r
     WHERE nullif(btrim(r), '') IS NOT NULL ORDER BY 1
  LOOP
    PERFORM finance.caja_documento_lock(NEW.tenant_id, v_ref);
    v_tomado := cashbook.documento_tomado(v_ref);
    IF v_tomado IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'caja_documento_en_el_libro_chk',
        MESSAGE = 'CAJA_DOCUMENTO_EN_EL_LIBRO',
        DETAIL = format('el %s ya se registró en la Ventanilla (%s): un documento entra a un solo libro', v_ref, v_tomado);
    END IF;
  END LOOP;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_cash_ledger_un_solo_libro ON finance.cash_ledger;
CREATE TRIGGER trg_cash_ledger_un_solo_libro
  BEFORE INSERT OR UPDATE OF origen_ref, declared_doc_ref, estado, deleted_at ON finance.cash_ledger
  FOR EACH ROW EXECUTE FUNCTION finance.cash_ledger_un_solo_libro();
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regclass('cashbook.withdrawal_orders') IS NOT NULL AS ordenes,
    to_regprocedure('cashbook._falla(text, text)') IS NOT NULL AS falla,
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cashbook_owner') AS dueno`);
  if (!h.ordenes || !h.falla || !h.dueno) throw new Error('[LE.6.12] falta el libro nuevo (LE.1 y LE.1.14): se aplica después.');

  await knex.raw(FINANCE);
  await knex.raw(`REVOKE ALL ON FUNCTION finance.caja_documento_lock(uuid, text) FROM PUBLIC`);
  await knex.raw(`REVOKE ALL ON FUNCTION finance.caja_documento_en_captura(uuid, text) FROM PUBLIC`);
  await knex.raw(`GRANT USAGE ON SCHEMA finance TO cashbook_owner`);
  for (const rol of ['app_runtime', 'cashbook_owner']) {
    const { rows: [r] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ?) AS hay`, [rol]);
    if (!r.hay) continue;
    await knex.raw(`GRANT EXECUTE ON FUNCTION finance.caja_documento_lock(uuid, text) TO ${rol}`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION finance.caja_documento_en_captura(uuid, text) TO ${rol}`);
  }

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(CASHBOOK);
  await knex.raw(`RESET ROLE`);
  await knex.raw(`REVOKE ALL ON FUNCTION cashbook.documento_tomado(text) FROM PUBLIC`);
  await knex.raw(`REVOKE ALL ON FUNCTION cashbook._documento_libre_en_captura(text) FROM PUBLIC`);
  const { rows: [app] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS hay`);
  if (app.hay) await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.documento_tomado(text) TO app_runtime`);
  const { rows: [ro] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') AS hay`);
  if (ro.hay) await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.documento_tomado(text) TO dev_ro`);

  await knex.raw(CAPTURA);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: disparadores y funciones; no hay datos. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_un_solo_libro ON finance.cash_ledger`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.cash_ledger_un_solo_libro()`);
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_orden_un_solo_libro ON cashbook.withdrawal_orders`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_asiento_un_solo_libro ON cashbook.entries`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_solicitud_un_solo_libro ON cashbook.requests`);
  await knex.raw(`DROP FUNCTION IF EXISTS cashbook.orden_un_solo_libro()`);
  await knex.raw(`DROP FUNCTION IF EXISTS cashbook.asiento_un_solo_libro()`);
  await knex.raw(`DROP FUNCTION IF EXISTS cashbook._documento_libre_en_captura(text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS cashbook.documento_tomado(text)`);
  await knex.raw(`RESET ROLE`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caja_documento_en_captura(uuid, text)`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caja_documento_lock(uuid, text)`);
};
