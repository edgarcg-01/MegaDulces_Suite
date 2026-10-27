'use strict';
/**
 * `[LE.1.2]`–`[LE.1.8]` `[LE.1.10]` `[LE.1.11]` — El libro de efectivo de partida doble (Fase LE,
 * ADR-102/103): un libro VACÍO en el que es imposible escribir algo que rompa un invariante.
 *
 * ── Por qué (medido en pg-prod el 2026-10-27, `database/scripts/le-metricas.js`) ─────────────
 *  · 86 depósitos de CAOS · $1,703,230 explicados dos veces: el libro viejo es de entrada simple y
 *    cuatro mecanismos reconstruyen la posición del dinero sin conocerse entre sí.
 *  · 6 de 13 cortes con un esperado que no se puede ir a contar; 0 de 13 autorizados por otra persona.
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · Rol `cashbook_owner` (NOLOGIN) dueño del esquema `cashbook`. `app_runtime` NO tiene INSERT,
 *    UPDATE, DELETE ni TRUNCATE sobre ninguna tabla (B39): sólo SELECT y EXECUTE de las funciones
 *    públicas. Las funciones son SECURITY DEFINER con `search_path` fijo.
 *  · Catálogo de denominaciones, cuentas («bolsas») con su cabecera de saldo y de piezas, asientos +
 *    líneas + piezas, consecutivo sin huecos con cadena de hashes, jornadas, reglas de autorización
 *    por umbral (vacías hasta D3) y solicitudes con cuatro ojos.
 *  · Invariantes I1–I16 de §4.4 del plan (I17 hallazgos e I18 divisas llegan con E2/E3).
 *  · Vistas de lectura, saldo a una secuencia, verificador de la cadena y bitácora de DDL.
 *
 * ── Decisiones de diseño, declaradas ─────────────────────────────────────────────────────────
 *  · Dinero en CENTAVOS `bigint` (D9). Las vistas lo exponen también en pesos.
 *  · UN candado por tenant (la fila de `seq_counters`) serializa todo asiento: da consecutivo sin
 *    huecos, cadena de hashes lineal y cero deadlocks. Para una caja (cientos de asientos al día) el
 *    costo es nulo; si un día hay varias cajas, el candado pasa a ser por libro.
 *  · El hecho externo se identifica por (`event_kind`, `event_ref`, `event_version`). Una versión
 *    nueva sólo entra si la anterior ya tiene reversa (B42).
 *  · La identidad (usuario, empleado) la pone la API, que es quien autentica. La base garantiza que
 *    quien autoriza no es quien registró, por usuario Y por empleado cuando se conoce (B43). El
 *    vínculo usuario → empleado es deuda de LE.4.
 *  · Ajuste, faltante, sobrante y apertura SIEMPRE piden autorización (B10); los demás, sólo arriba
 *    del umbral de `authorization_rules` (vacía hasta que el PM fije el umbral de D3).
 *  · `denominations` y `ddl_audit` no llevan `tenant_id`: son catálogo nacional y bitácora de la
 *    estructura (como `tenants`), no datos de un tenant.
 *
 * ⚠️ Sólo objetos nuevos: no toma candados sobre tablas existentes. El event trigger de DDL exige
 *    superusuario (en prod las migraciones corren como `postgres`); sin él se declara NO MEDIDO.
 * ⛔ Ni un `?` en el SQL (knex lo convierte en parámetro: así se rompió `[CGA-A.55]`).
 *
 * Idempotente. Prueba: `database/tests/test-newdb-cashbook-libro.js`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT_MD = '00000000-0000-0000-0000-00000000d01c';

/** Las llaves de `libs/contracts/src/money/denominations.ts` (MXN) + billetes de dólar. */
const DENOMINACIONES = [
  ['MXN', '1000', 100000, 'billete'], ['MXN', '500', 50000, 'billete'], ['MXN', '200', 20000, 'billete'],
  ['MXN', '100', 10000, 'billete'], ['MXN', '50', 5000, 'billete'], ['MXN', '20', 2000, 'billete'],
  ['MXN', '20m', 2000, 'moneda'], ['MXN', '10', 1000, 'moneda'], ['MXN', '5', 500, 'moneda'],
  ['MXN', '2', 200, 'moneda'], ['MXN', '1', 100, 'moneda'], ['MXN', '0.5', 50, 'moneda'],
  ['USD', '100', 10000, 'billete'], ['USD', '50', 5000, 'billete'], ['USD', '20', 2000, 'billete'],
  ['USD', '10', 1000, 'billete'], ['USD', '5', 500, 'billete'], ['USD', '2', 200, 'billete'],
  ['USD', '1', 100, 'billete'],
];

/** El plan de cuentas fijo de §4.2. Las de persona, ruta y concepto se abren al usarse (E2). */
const CUENTAS_BASE = [
  // code, name, class, currency, tracks_pieces, allows_negative, witness
  ['CAJA_MXN', 'Caja General · pesos', 'fisica', 'MXN', true, false, 'arqueo ciego'],
  ['CAJA_USD', 'Caja General · dólares', 'fisica', 'USD', true, false, 'arqueo ciego'],
  ['CAJA_DOC', 'Caja General · documentos (cheques)', 'fisica', 'MXN', false, false, 'arqueo de documentos'],
  ['BOVEDA_CAOS', 'Bóveda CAOS', 'fisica', 'MXN', true, false, 'conteo de la máquina'],
  ['TRANSITO_BANCO', 'Valores en tránsito · banco', 'transito', 'MXN', false, false, 'estado de cuenta'],
  ['COBRANZA_KEPLER', 'Cobranza reconocida (Kepler)', 'contrapartida', 'MXN', false, true, 'cobranza de Kepler'],
  ['PUENTE_MXN', 'Cambio de divisas · MXN', 'puente', 'MXN', false, true, 'tipo de cambio guardado'],
  ['PUENTE_USD', 'Cambio de divisas · USD', 'puente', 'USD', false, true, 'tipo de cambio guardado'],
  ['APERTURA_MXN', 'Apertura · pesos', 'sistema', 'MXN', false, true, 'conteos de la fecha de apertura'],
  ['APERTURA_USD', 'Apertura · dólares', 'sistema', 'USD', false, true, 'conteos de la fecha de apertura'],
  ['SUSPENSO_MXN', 'Suspenso · pesos', 'sistema', 'MXN', false, true, 'debe ser 0 al cierre'],
  ['SUSPENSO_USD', 'Suspenso · dólares', 'sistema', 'USD', false, true, 'debe ser 0 al cierre'],
];

const SIEMPRE_AUTORIZA = ['ajuste', 'faltante', 'sobrante', 'apertura'];

// ── 1. Tablas ─────────────────────────────────────────────────────────────────────────────────
const TABLAS = `
CREATE TABLE IF NOT EXISTS cashbook.denominations (
  currency     char(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  denom_key    text    NOT NULL,
  value_minor  bigint  NOT NULL CHECK (value_minor > 0),
  family       text    NOT NULL CHECK (family IN ('billete','moneda')),
  PRIMARY KEY (currency, denom_key)
);

CREATE TABLE IF NOT EXISTS cashbook.accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  code             text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_:.-]*$'),
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  class            text NOT NULL CHECK (class IN ('fisica','custodia','por_rendir','transito','contrapartida','diferencia','puente','sistema')),
  currency         char(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  tracks_pieces    boolean NOT NULL,
  allows_negative  boolean NOT NULL,
  holder_kind      text NOT NULL DEFAULT 'ninguno' CHECK (holder_kind IN ('ninguno','empleado','ruta','concepto')),
  holder_ref       text,
  witness          text,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by       uuid,
  CONSTRAINT cashbook_cuenta_codigo UNIQUE (tenant_id, code),
  CONSTRAINT cashbook_cuenta_id_moneda UNIQUE (id, currency),
  CONSTRAINT cashbook_cuenta_fisica_no_negativa CHECK (class NOT IN ('fisica','custodia','transito') OR NOT allows_negative),
  CONSTRAINT cashbook_cuenta_titular CHECK ((holder_kind = 'ninguno') = (holder_ref IS NULL)),
  CONSTRAINT cashbook_cuenta_piezas_solo_fisica CHECK (NOT tracks_pieces OR class = 'fisica')
);

CREATE TABLE IF NOT EXISTS cashbook.account_balances (
  account_id       uuid PRIMARY KEY REFERENCES cashbook.accounts(id),
  tenant_id        uuid NOT NULL,
  balance_minor    bigint NOT NULL DEFAULT 0,
  allows_negative  boolean NOT NULL,
  last_seq         bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT cashbook_saldo_no_negativo CHECK (allows_negative OR balance_minor >= 0)
);

CREATE TABLE IF NOT EXISTS cashbook.account_piece_balances (
  account_id   uuid NOT NULL REFERENCES cashbook.accounts(id),
  tenant_id    uuid NOT NULL,
  currency     char(3) NOT NULL,
  denom_key    text NOT NULL,
  pieces       bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, denom_key),
  FOREIGN KEY (currency, denom_key) REFERENCES cashbook.denominations(currency, denom_key),
  CONSTRAINT cashbook_piezas_no_negativas CHECK (pieces >= 0)
);

CREATE TABLE IF NOT EXISTS cashbook.seq_counters (
  tenant_id   uuid PRIMARY KEY,
  last_seq    bigint NOT NULL DEFAULT 0,
  last_hash   text   NOT NULL DEFAULT 'GENESIS',
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS cashbook.business_days (
  id                      uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id               uuid NOT NULL,
  business_date           date NOT NULL,
  state                   text NOT NULL CHECK (state IN ('abierta','cerrada')),
  opened_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  opened_by               uuid NOT NULL,
  closed_at               timestamptz,
  closed_by               uuid,
  closed_by_employee      uuid,
  authorized_by           uuid,
  authorized_by_employee  uuid,
  closing_seq             bigint,
  closing_hash            text,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by              uuid,
  PRIMARY KEY (tenant_id, business_date),
  CONSTRAINT cashbook_cierre_completo CHECK ((state = 'cerrada') = (closed_at IS NOT NULL AND closed_by IS NOT NULL
    AND authorized_by IS NOT NULL AND closing_seq IS NOT NULL AND closing_hash IS NOT NULL)),
  CONSTRAINT cashbook_cierre_cuatro_ojos CHECK (authorized_by IS NULL OR (authorized_by IS DISTINCT FROM closed_by
    AND (authorized_by_employee IS NULL OR closed_by_employee IS NULL OR authorized_by_employee <> closed_by_employee)))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cashbook_una_jornada_abierta ON cashbook.business_days (tenant_id) WHERE state = 'abierta';

CREATE TABLE IF NOT EXISTS cashbook.entries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  seq                     bigint NOT NULL CHECK (seq >= 1),
  business_date           date NOT NULL,
  value_at                timestamptz NOT NULL,
  recorded_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_kind              text NOT NULL CHECK (event_kind ~ '^[a-z][a-z0-9_]*$'),
  event_ref               text,
  event_version           integer NOT NULL DEFAULT 1 CHECK (event_version >= 1),
  event_hash              text,
  request_id              uuid,
  request_hash            text,
  rule_version            text NOT NULL CHECK (length(trim(rule_version)) > 0),
  actor_kind              text NOT NULL CHECK (actor_kind IN ('persona','servicio')),
  created_by              uuid,
  created_by_employee     uuid,
  service_name            text,
  authorized_by           uuid,
  authorized_by_employee  uuid,
  authorized_at           timestamptz,
  reverses_entry_id       uuid REFERENCES cashbook.entries(id),
  reason                  text,
  prev_hash               text NOT NULL,
  hash                    text,
  CONSTRAINT cashbook_asiento_seq UNIQUE (tenant_id, seq),
  CONSTRAINT cashbook_asiento_una_reversa UNIQUE (reverses_entry_id),
  CONSTRAINT cashbook_asiento_actor CHECK ((actor_kind = 'persona' AND created_by IS NOT NULL AND service_name IS NULL)
    OR (actor_kind = 'servicio' AND service_name IS NOT NULL AND authorized_by IS NULL)),
  CONSTRAINT cashbook_autoriza_otro CHECK (authorized_by IS NULL OR (authorized_by IS DISTINCT FROM created_by
    AND (authorized_by_employee IS NULL OR created_by_employee IS NULL OR authorized_by_employee <> created_by_employee))),
  CONSTRAINT cashbook_autorizacion_completa CHECK ((authorized_by IS NULL) = (authorized_at IS NULL)),
  CONSTRAINT cashbook_peticion_con_huella CHECK ((request_id IS NULL) = (request_hash IS NULL)),
  CONSTRAINT cashbook_reversa_con_motivo CHECK (reverses_entry_id IS NULL
    OR (reason IS NOT NULL AND length(trim(reason)) > 0 AND authorized_by IS NOT NULL)),
  CONSTRAINT cashbook_asiento_jornada FOREIGN KEY (tenant_id, business_date) REFERENCES cashbook.business_days (tenant_id, business_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cashbook_evento ON cashbook.entries (tenant_id, event_kind, event_ref, event_version) WHERE event_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cashbook_peticion ON cashbook.entries (tenant_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cashbook.entry_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  entry_id      uuid NOT NULL REFERENCES cashbook.entries(id),
  line_no       smallint NOT NULL CHECK (line_no >= 1),
  account_id    uuid NOT NULL,
  currency      char(3) NOT NULL,
  amount_minor  bigint NOT NULL CONSTRAINT cashbook_linea_no_cero CHECK (amount_minor <> 0),
  CONSTRAINT cashbook_linea_unica UNIQUE (entry_id, line_no),
  CONSTRAINT cashbook_linea_moneda_de_su_cuenta FOREIGN KEY (account_id, currency) REFERENCES cashbook.accounts (id, currency)
);
CREATE INDEX IF NOT EXISTS ix_cashbook_lineas_cuenta ON cashbook.entry_lines (account_id, entry_id);

CREATE TABLE IF NOT EXISTS cashbook.entry_pieces (
  line_id    uuid NOT NULL REFERENCES cashbook.entry_lines(id),
  tenant_id  uuid NOT NULL,
  currency   char(3) NOT NULL,
  denom_key  text NOT NULL,
  pieces     bigint NOT NULL CONSTRAINT cashbook_pieza_no_cero CHECK (pieces <> 0),
  PRIMARY KEY (line_id, denom_key),
  FOREIGN KEY (currency, denom_key) REFERENCES cashbook.denominations (currency, denom_key)
);

CREATE TABLE IF NOT EXISTS cashbook.authorization_rules (
  id               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id        uuid NOT NULL,
  event_kind       text NOT NULL,
  threshold_minor  bigint NOT NULL CHECK (threshold_minor >= 0),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by       uuid,
  PRIMARY KEY (tenant_id, event_kind)
);

CREATE TABLE IF NOT EXISTS cashbook.requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  request_id              uuid NOT NULL,
  request_hash            text NOT NULL,
  payload                 jsonb NOT NULL,
  event_kind              text NOT NULL,
  gross_minor             bigint NOT NULL,
  registered_by           uuid NOT NULL,
  registered_by_employee  uuid,
  expires_at              timestamptz NOT NULL,
  state                   text NOT NULL DEFAULT 'pendiente' CHECK (state IN ('pendiente','autorizada','rechazada','vencida')),
  decided_by              uuid,
  decided_by_employee     uuid,
  decided_at              timestamptz,
  decision_note           text,
  entry_id                uuid REFERENCES cashbook.entries(id),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by              uuid,
  CONSTRAINT cashbook_solicitud_unica UNIQUE (tenant_id, request_id),
  CONSTRAINT cashbook_solicitud_decidida CHECK ((state = 'pendiente') = (decided_at IS NULL)),
  CONSTRAINT cashbook_solicitud_autorizada_con_asiento CHECK ((state = 'autorizada') = (entry_id IS NOT NULL)),
  CONSTRAINT cashbook_solicitud_rechazo_con_motivo CHECK (state <> 'rechazada' OR length(trim(coalesce(decision_note, ''))) > 0),
  CONSTRAINT cashbook_solicitud_decide_otro CHECK (decided_by IS NULL OR (decided_by <> registered_by
    AND (decided_by_employee IS NULL OR registered_by_employee IS NULL OR decided_by_employee <> registered_by_employee)))
);

CREATE TABLE IF NOT EXISTS cashbook.ddl_audit (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  happened_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  db_user          text NOT NULL DEFAULT current_user,
  session_user_    text NOT NULL DEFAULT session_user,
  command_tag      text NOT NULL,
  object_type      text,
  object_identity  text
);
`;

// ── 2. Funciones ──────────────────────────────────────────────────────────────────────────────
const FUNCIONES = `
CREATE OR REPLACE FUNCTION cashbook._falla(p_codigo text, p_detalle text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  RAISE EXCEPTION USING MESSAGE = upper(p_codigo), ERRCODE = '23514', CONSTRAINT = lower(p_codigo), DETAIL = coalesce(p_detalle, '');
END $fn$;

CREATE OR REPLACE FUNCTION cashbook._tenant() RETURNS uuid
LANGUAGE plpgsql STABLE AS $fn$
DECLARE v uuid := cashbook.current_tenant();
BEGIN
  IF v IS NULL THEN PERFORM cashbook._falla('cashbook_sin_tenant', 'fijá app.tenant_id antes de tocar el libro'); END IF;
  RETURN v;
END $fn$;

-- La forma canónica de un asiento: lo que firma la cadena. Lee las FILAS guardadas, así que el
-- verificador y el que registra usan exactamente el mismo texto.
CREATE OR REPLACE FUNCTION cashbook.canonical(p_entry uuid) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT concat_ws('|', e.tenant_id::text, e.seq::text, e.business_date::text,
           (extract(epoch FROM e.value_at) * 1000000)::bigint::text,
           (extract(epoch FROM e.recorded_at) * 1000000)::bigint::text,
           e.event_kind, coalesce(e.event_ref, ''), e.event_version::text, coalesce(e.event_hash, ''),
           coalesce(e.request_id::text, ''), coalesce(e.request_hash, ''), e.rule_version, e.actor_kind,
           coalesce(e.created_by::text, ''), coalesce(e.created_by_employee::text, ''), coalesce(e.service_name, ''),
           coalesce(e.authorized_by::text, ''), coalesce(e.authorized_by_employee::text, ''),
           coalesce((extract(epoch FROM e.authorized_at) * 1000000)::bigint::text, ''),
           coalesce(e.reverses_entry_id::text, ''), coalesce(e.reason, ''), e.prev_hash,
           coalesce((SELECT string_agg(l.line_no::text || ':' || l.account_id::text || ':' || l.currency || ':' || l.amount_minor::text
                       || '[' || coalesce((SELECT string_agg(p.denom_key || '=' || p.pieces::text, ',' ORDER BY p.denom_key)
                                             FROM cashbook.entry_pieces p WHERE p.line_id = l.id), '') || ']',
                       ';' ORDER BY l.line_no)
                       FROM cashbook.entry_lines l WHERE l.entry_id = e.id), ''))
    FROM cashbook.entries e WHERE e.id = p_entry
$fn$;

CREATE OR REPLACE FUNCTION cashbook._huella(p_texto text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$ SELECT encode(sha256(convert_to(p_texto, 'UTF8')), 'hex') $fn$;

-- El ÚNICO camino que escribe un asiento (B39). No se le da EXECUTE a la app: la app entra por
-- post_entry (sin autorización) o por authorize_request (con ella).
CREATE OR REPLACE FUNCTION cashbook._post(p jsonb, p_auth_user uuid, p_auth_employee uuid, p_reverses uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  v_kind text := p->>'event_kind';
  v_ref text := nullif(p->>'event_ref', '');
  v_ver int := coalesce((p->>'event_version')::int, 1);
  v_ehash text := nullif(p->>'event_hash', '');
  v_req uuid := nullif(p->>'request_id', '')::uuid;
  -- La huella la calcula la BASE sobre el contenido (jsonb normaliza orden y espacios): si la
  -- mandara el cliente, un reintento con otro monto y la misma huella pasaría como «el mismo».
  v_rhash text := CASE WHEN v_req IS NOT NULL THEN cashbook._huella((p - 'request_hash')::text) END;
  v_actor jsonb := coalesce(p->'actor', '{}'::jsonb);
  v_actor_kind text := coalesce(v_actor->>'kind', 'persona');
  v_user uuid := nullif(v_actor->>'user_id', '')::uuid;
  v_emp uuid := nullif(v_actor->>'employee_id', '')::uuid;
  v_service text := nullif(v_actor->>'service', '');
  v_value_at timestamptz;
  v_day date;
  v_last bigint; v_last_hash text; v_seq bigint;
  v_id uuid; v_existe record;
  v_gross bigint := 0; v_umbral bigint;
  el jsonb; v_n int := 0; v_acc record; v_amt bigint; v_line uuid;
  pz record; v_suma_piezas bigint; v_todas_con_piezas boolean := true; v_hay_piezas boolean;
  v_hash text;
BEGIN
  -- Forma (B25)
  IF v_kind IS NULL OR v_kind !~ '^[a-z][a-z0-9_]*$' THEN PERFORM cashbook._falla('cashbook_evento_invalido', coalesce(v_kind, '(vacío)')); END IF;
  IF nullif(p->>'rule_version', '') IS NULL THEN PERFORM cashbook._falla('cashbook_sin_version_de_regla', v_kind); END IF;
  IF nullif(p->>'value_at', '') IS NULL THEN PERFORM cashbook._falla('cashbook_sin_fecha_valor', v_kind); END IF;
  v_value_at := (p->>'value_at')::timestamptz;
  IF v_value_at > clock_timestamp() + interval '5 minutes' THEN
    PERFORM cashbook._falla('cashbook_fecha_futura', (p->>'value_at'));
  END IF;
  IF jsonb_typeof(p->'lines') IS DISTINCT FROM 'array' THEN PERFORM cashbook._falla('cashbook_asiento_minimo', 'sin líneas'); END IF;
  IF v_actor_kind = 'persona' AND v_user IS NULL THEN PERFORM cashbook._falla('cashbook_asiento_actor', 'una persona registra con su usuario'); END IF;
  IF v_actor_kind = 'servicio' AND v_service IS NULL THEN PERFORM cashbook._falla('cashbook_asiento_actor', 'un proceso registra con su nombre'); END IF;
  IF v_actor_kind NOT IN ('persona','servicio') THEN PERFORM cashbook._falla('cashbook_asiento_actor', v_actor_kind); END IF;

  -- El candado: serializa todo asiento del tenant (consecutivo, cadena e idempotencia sin carrera)
  INSERT INTO cashbook.seq_counters (tenant_id) VALUES (v_t) ON CONFLICT (tenant_id) DO NOTHING;
  SELECT last_seq, last_hash INTO v_last, v_last_hash FROM cashbook.seq_counters WHERE tenant_id = v_t FOR UPDATE;

  -- Idempotencia de la petición (I12)
  IF v_req IS NOT NULL THEN
    SELECT id, request_hash INTO v_existe FROM cashbook.entries WHERE tenant_id = v_t AND request_id = v_req;
    IF FOUND THEN
      IF v_existe.request_hash = v_rhash THEN RETURN v_existe.id; END IF;
      PERFORM cashbook._falla('cashbook_peticion_reusada', v_req::text || ' ya se registró con otro contenido');
    END IF;
  END IF;

  -- Un hecho, un registro; una versión nueva sólo sobre la reversa de la anterior (I11, B42)
  IF v_ref IS NOT NULL THEN
    SELECT id, event_hash INTO v_existe FROM cashbook.entries
     WHERE tenant_id = v_t AND event_kind = v_kind AND event_ref = v_ref AND event_version = v_ver;
    IF FOUND THEN
      IF v_existe.event_hash IS NOT DISTINCT FROM v_ehash THEN RETURN v_existe.id; END IF;
      PERFORM cashbook._falla('cashbook_evento_cambio', v_kind || '/' || v_ref || ' v' || v_ver || ' ya se registró con otro contenido: va una versión nueva');
    END IF;
    IF v_ver > 1 AND NOT EXISTS (
         SELECT 1 FROM cashbook.entries o
          WHERE o.tenant_id = v_t AND o.event_kind = v_kind AND o.event_ref = v_ref AND o.event_version = v_ver - 1
            AND EXISTS (SELECT 1 FROM cashbook.entries r WHERE r.reverses_entry_id = o.id)) THEN
      PERFORM cashbook._falla('cashbook_version_sin_reversa', v_kind || '/' || v_ref || ' v' || (v_ver - 1) || ' no existe o no tiene reversa');
    END IF;
  END IF;

  -- La jornada abierta (I14): la fecha de registro es la del día abierto; la fecha valor queda aparte
  SELECT business_date INTO v_day FROM cashbook.business_days WHERE tenant_id = v_t AND state = 'abierta';
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_sin_jornada_abierta', 'abrí la jornada antes de registrar'); END IF;
  IF nullif(p->>'business_date', '') IS NOT NULL AND (p->>'business_date')::date <> v_day THEN
    PERFORM cashbook._falla('cashbook_jornada_cerrada', 'el ' || (p->>'business_date') || ' no es la jornada abierta (' || v_day || '): el ajuste va al día abierto');
  END IF;

  v_seq := v_last + 1;
  INSERT INTO cashbook.entries (tenant_id, seq, business_date, value_at, event_kind, event_ref, event_version, event_hash,
         request_id, request_hash, rule_version, actor_kind, created_by, created_by_employee, service_name,
         authorized_by, authorized_by_employee, authorized_at, reverses_entry_id, reason, prev_hash)
  VALUES (v_t, v_seq, v_day, v_value_at, v_kind, v_ref, v_ver, v_ehash, v_req, v_rhash, p->>'rule_version', v_actor_kind,
         CASE WHEN v_actor_kind = 'persona' THEN v_user END, CASE WHEN v_actor_kind = 'persona' THEN v_emp END,
         CASE WHEN v_actor_kind = 'servicio' THEN v_service END,
         p_auth_user, p_auth_employee, CASE WHEN p_auth_user IS NOT NULL THEN clock_timestamp() END,
         p_reverses, nullif(trim(p->>'reason'), ''), v_last_hash)
  RETURNING id INTO v_id;

  FOR el IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
    v_n := v_n + 1;
    SELECT a.* INTO v_acc FROM cashbook.accounts a
     WHERE a.tenant_id = v_t AND (a.id::text = el->>'account_id' OR a.code = el->>'account');
    IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_cuenta_inexistente', coalesce(el->>'account', el->>'account_id', '(vacía)')); END IF;
    IF v_acc.closed_at IS NOT NULL AND p_reverses IS NULL THEN PERFORM cashbook._falla('cashbook_cuenta_cerrada', v_acc.code); END IF;
    IF coalesce(el->>'amount_minor', '') !~ '^-{0,1}[0-9]{1,15}$' THEN
      PERFORM cashbook._falla('cashbook_monto_invalido', v_acc.code || ': ' || coalesce(el->>'amount_minor', '(vacío)') || ' (centavos enteros)');
    END IF;
    v_amt := (el->>'amount_minor')::bigint;
    IF v_amt = 0 THEN PERFORM cashbook._falla('cashbook_linea_no_cero', v_acc.code); END IF;
    IF v_amt > 0 THEN v_gross := v_gross + v_amt; END IF;

    INSERT INTO cashbook.entry_lines (tenant_id, entry_id, line_no, account_id, currency, amount_minor)
    VALUES (v_t, v_id, v_n, v_acc.id, v_acc.currency, v_amt) RETURNING id INTO v_line;

    -- coalesce: sin la llave, jsonb_typeof da NULL y «NOT NULL» es NULL (el IF lo saltaba).
    v_hay_piezas := coalesce(jsonb_typeof(el->'pieces') = 'object' AND el->'pieces' <> '{}'::jsonb, false);
    IF v_acc.tracks_pieces THEN
      IF NOT v_hay_piezas THEN
        PERFORM cashbook._falla('cashbook_cuenta_exige_piezas', v_acc.code || ': un importe sin piezas no es un conteo (B16)');
      END IF;
      v_suma_piezas := 0;
      FOR pz IN SELECT key, value FROM jsonb_each_text(el->'pieces') LOOP
        IF pz.value !~ '^-{0,1}[0-9]{1,9}$' OR pz.value::bigint = 0 THEN
          PERFORM cashbook._falla('cashbook_pieza_invalida', v_acc.code || ': ' || pz.key || ' = ' || pz.value);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM cashbook.denominations d WHERE d.currency = v_acc.currency AND d.denom_key = pz.key) THEN
          PERFORM cashbook._falla('cashbook_denominacion_fuera_de_catalogo', v_acc.currency || ' ' || pz.key);
        END IF;
        INSERT INTO cashbook.entry_pieces (line_id, tenant_id, currency, denom_key, pieces)
        VALUES (v_line, v_t, v_acc.currency, pz.key, pz.value::bigint);
        v_suma_piezas := v_suma_piezas + pz.value::bigint * (SELECT d.value_minor FROM cashbook.denominations d
                                                              WHERE d.currency = v_acc.currency AND d.denom_key = pz.key);
        -- UPDATE y, si no hay fila, INSERT. No ON CONFLICT: Postgres evalúa el CHECK sobre la fila
        -- PROPUESTA (el delta, negativo en una salida) antes de ver el conflicto. Sin carrera: el
        -- candado del libro ya serializa.
        UPDATE cashbook.account_piece_balances SET pieces = pieces + pz.value::bigint, updated_at = clock_timestamp()
         WHERE account_id = v_acc.id AND denom_key = pz.key;
        IF NOT FOUND THEN
          INSERT INTO cashbook.account_piece_balances (account_id, tenant_id, currency, denom_key, pieces)
          VALUES (v_acc.id, v_t, v_acc.currency, pz.key, pz.value::bigint);
        END IF;
      END LOOP;
      IF v_suma_piezas <> v_amt THEN
        PERFORM cashbook._falla('cashbook_piezas_no_suman', v_acc.code || ': piezas ' || v_suma_piezas || ' ≠ línea ' || v_amt || ' (centavos)');
      END IF;
    ELSE
      v_todas_con_piezas := false;
      IF v_hay_piezas THEN PERFORM cashbook._falla('cashbook_cuenta_sin_desglose', v_acc.code || ' no lleva piezas'); END IF;
    END IF;

    UPDATE cashbook.account_balances
       SET balance_minor = balance_minor + v_amt, last_seq = v_seq, updated_at = clock_timestamp()
     WHERE account_id = v_acc.id;
  END LOOP;

  IF v_n < 2 THEN PERFORM cashbook._falla('cashbook_asiento_minimo', 'un asiento lleva al menos dos líneas'); END IF;
  IF EXISTS (SELECT 1 FROM cashbook.entry_lines WHERE entry_id = v_id GROUP BY currency HAVING sum(amount_minor) <> 0) THEN
    PERFORM cashbook._falla('cashbook_no_cuadra', (SELECT string_agg(currency || ' ' || s, ', ') FROM (
      SELECT currency, sum(amount_minor) s FROM cashbook.entry_lines WHERE entry_id = v_id GROUP BY currency HAVING sum(amount_minor) <> 0) x));
  END IF;
  -- I3: entre cuentas que cuentan piezas, cada billete que sale de una entra a otra
  IF v_todas_con_piezas AND EXISTS (
       SELECT 1 FROM cashbook.entry_pieces ep JOIN cashbook.entry_lines l ON l.id = ep.line_id
        WHERE l.entry_id = v_id GROUP BY ep.currency, ep.denom_key HAVING sum(ep.pieces) <> 0) THEN
    PERFORM cashbook._falla('cashbook_piezas_no_cuadran', (SELECT string_agg(currency || ' ' || denom_key || ' ' || s, ', ') FROM (
      SELECT ep.currency, ep.denom_key, sum(ep.pieces) s FROM cashbook.entry_pieces ep JOIN cashbook.entry_lines l ON l.id = ep.line_id
       WHERE l.entry_id = v_id GROUP BY 1, 2 HAVING sum(ep.pieces) <> 0) x));
  END IF;

  -- Cuatro ojos (B10): siempre para ajuste/faltante/sobrante/apertura; para lo demás, arriba del umbral
  IF p_auth_user IS NULL THEN
    IF v_kind = ANY (ARRAY['ajuste','faltante','sobrante','apertura','reversa']) THEN
      PERFORM cashbook._falla('cashbook_requiere_autorizacion', v_kind || ' siempre lo autoriza otra persona');
    END IF;
    SELECT threshold_minor INTO v_umbral FROM cashbook.authorization_rules WHERE tenant_id = v_t AND event_kind = v_kind;
    IF FOUND AND v_gross >= v_umbral THEN
      PERFORM cashbook._falla('cashbook_requiere_autorizacion', v_kind || ' de ' || v_gross || ' centavos ≥ umbral ' || v_umbral);
    END IF;
  ELSIF v_actor_kind = 'servicio' THEN
    PERFORM cashbook._falla('cashbook_asiento_actor', 'lo que registra un proceso no se autoriza (B14)');
  END IF;

  -- Sello y cadena (I7, I8)
  v_hash := cashbook._huella(cashbook.canonical(v_id));
  UPDATE cashbook.entries SET hash = v_hash WHERE id = v_id;
  UPDATE cashbook.seq_counters SET last_seq = v_seq, last_hash = v_hash, updated_at = clock_timestamp() WHERE tenant_id = v_t;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.post_entry(p jsonb) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
  SELECT cashbook._post(p, NULL, NULL, NULL)
$fn$;

-- El espejo exacto de un asiento (para su reversa).
CREATE OR REPLACE FUNCTION cashbook._espejo(p_entry uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_id', l.account_id::text,
           'amount_minor', (-l.amount_minor)::text,
           'pieces', coalesce((SELECT jsonb_object_agg(p.denom_key, (-p.pieces)::text) FROM cashbook.entry_pieces p WHERE p.line_id = l.id), '{}'::jsonb))
         ORDER BY l.line_no), '[]'::jsonb)
    FROM cashbook.entry_lines l WHERE l.entry_id = p_entry
$fn$;

CREATE OR REPLACE FUNCTION cashbook.create_request(p jsonb, p_expires_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  v_req uuid := nullif(p->>'request_id', '')::uuid;
  v_rhash text := cashbook._huella((p - 'request_hash')::text);
  v_user uuid := nullif(p->'actor'->>'user_id', '')::uuid;
  v_kind text := coalesce(p->>'event_kind', CASE WHEN nullif(p->>'reverses_entry_id', '') IS NOT NULL THEN 'reversa' END);
  v_existe record; v_id uuid; v_gross bigint;
BEGIN
  IF v_req IS NULL THEN PERFORM cashbook._falla('cashbook_peticion_con_huella', 'una solicitud lleva request_id'); END IF;
  IF v_user IS NULL OR coalesce(p->'actor'->>'kind', 'persona') <> 'persona' THEN
    PERFORM cashbook._falla('cashbook_asiento_actor', 'una solicitud la registra una persona con su usuario');
  END IF;
  IF v_kind IS NULL THEN PERFORM cashbook._falla('cashbook_evento_invalido', 'la solicitud no dice qué registra'); END IF;
  IF p_expires_at IS NULL OR p_expires_at <= clock_timestamp() THEN
    PERFORM cashbook._falla('cashbook_solicitud_sin_plazo', 'toda solicitud vence (B45)');
  END IF;
  IF v_kind = 'reversa' AND nullif(trim(p->>'reason'), '') IS NULL THEN
    PERFORM cashbook._falla('cashbook_reversa_con_motivo', 'una reversa dice por qué');
  END IF;
  SELECT id, request_hash INTO v_existe FROM cashbook.requests WHERE tenant_id = v_t AND request_id = v_req;
  IF FOUND THEN
    IF v_existe.request_hash = v_rhash THEN RETURN v_existe.id; END IF;
    PERFORM cashbook._falla('cashbook_peticion_reusada', v_req::text || ' ya se registró con otro contenido');
  END IF;
  SELECT coalesce(sum(greatest((x->>'amount_minor')::bigint, 0)), 0) INTO v_gross
    FROM jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) x
   WHERE coalesce(x->>'amount_minor', '') ~ '^-{0,1}[0-9]{1,15}$';
  INSERT INTO cashbook.requests (tenant_id, request_id, request_hash, payload, event_kind, gross_minor,
         registered_by, registered_by_employee, expires_at, created_by)
  VALUES (v_t, v_req, v_rhash, p, v_kind, v_gross, v_user, nullif(p->'actor'->>'employee_id', '')::uuid, p_expires_at, v_user)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.authorize_request(p_request uuid, p_user uuid, p_employee uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE
  v_t uuid := cashbook._tenant();
  r cashbook.requests%ROWTYPE; v_entry uuid; v_orig record; p jsonb;
BEGIN
  IF p_user IS NULL THEN PERFORM cashbook._falla('cashbook_asiento_actor', 'autoriza una persona con su usuario'); END IF;
  SELECT * INTO r FROM cashbook.requests WHERE id = p_request AND tenant_id = v_t FOR UPDATE;
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_solicitud_inexistente', p_request::text); END IF;
  IF r.state <> 'pendiente' THEN PERFORM cashbook._falla('cashbook_solicitud_no_pendiente', r.state); END IF;
  IF r.expires_at <= clock_timestamp() THEN PERFORM cashbook._falla('cashbook_solicitud_vencida', r.expires_at::text); END IF;
  IF p_user = r.registered_by OR (p_employee IS NOT NULL AND p_employee = r.registered_by_employee) THEN
    PERFORM cashbook._falla('cashbook_autoriza_quien_registra', 'quien registró no autoriza lo suyo (B10, B43)');
  END IF;

  IF r.event_kind = 'reversa' THEN
    SELECT e.* INTO v_orig FROM cashbook.entries e WHERE e.tenant_id = v_t AND e.id = (r.payload->>'reverses_entry_id')::uuid;
    IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_asiento_inexistente', r.payload->>'reverses_entry_id'); END IF;
    IF v_orig.reverses_entry_id IS NOT NULL THEN PERFORM cashbook._falla('cashbook_reversa_de_reversa', v_orig.id::text); END IF;
    IF EXISTS (SELECT 1 FROM cashbook.entries x WHERE x.reverses_entry_id = v_orig.id) THEN
      PERFORM cashbook._falla('cashbook_asiento_una_reversa', v_orig.id::text || ' ya tiene reversa');
    END IF;
    p := jsonb_build_object('event_kind', 'reversa', 'event_ref', v_orig.id::text, 'rule_version', 'reversa-1',
           'value_at', clock_timestamp()::text, 'reason', r.payload->>'reason',
           'request_id', r.request_id::text, 'request_hash', r.request_hash,
           'actor', r.payload->'actor', 'lines', cashbook._espejo(v_orig.id));
    v_entry := cashbook._post(p, p_user, p_employee, v_orig.id);
  ELSE
    v_entry := cashbook._post(r.payload, p_user, p_employee, NULL);
  END IF;

  UPDATE cashbook.requests SET state = 'autorizada', decided_by = p_user, decided_by_employee = p_employee,
         decided_at = clock_timestamp(), entry_id = v_entry, updated_at = clock_timestamp(), updated_by = p_user
   WHERE id = r.id;
  RETURN v_entry;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.reject_request(p_request uuid, p_user uuid, p_employee uuid, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); r cashbook.requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM cashbook.requests WHERE id = p_request AND tenant_id = v_t FOR UPDATE;
  IF NOT FOUND THEN PERFORM cashbook._falla('cashbook_solicitud_inexistente', p_request::text); END IF;
  IF r.state <> 'pendiente' THEN PERFORM cashbook._falla('cashbook_solicitud_no_pendiente', r.state); END IF;
  IF p_user IS NULL OR p_user = r.registered_by OR (p_employee IS NOT NULL AND p_employee = r.registered_by_employee) THEN
    PERFORM cashbook._falla('cashbook_autoriza_quien_registra', 'quien registró no decide sobre lo suyo');
  END IF;
  IF length(trim(coalesce(p_note, ''))) = 0 THEN PERFORM cashbook._falla('cashbook_solicitud_rechazo_con_motivo', ''); END IF;
  UPDATE cashbook.requests SET state = 'rechazada', decided_by = p_user, decided_by_employee = p_employee,
         decided_at = clock_timestamp(), decision_note = p_note, updated_at = clock_timestamp(), updated_by = p_user
   WHERE id = r.id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.expire_requests() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); n integer;
BEGIN
  UPDATE cashbook.requests SET state = 'vencida', decided_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE tenant_id = v_t AND state = 'pendiente' AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.open_account(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); v_id uuid;
BEGIN
  INSERT INTO cashbook.accounts (tenant_id, code, name, class, currency, tracks_pieces, allows_negative,
         holder_kind, holder_ref, witness, created_by, updated_by)
  VALUES (v_t, p->>'code', p->>'name', p->>'class', p->>'currency', (p->>'tracks_pieces')::boolean,
         (p->>'allows_negative')::boolean, coalesce(p->>'holder_kind', 'ninguno'), nullif(p->>'holder_ref', ''),
         nullif(p->>'witness', ''), nullif(p->>'user_id', '')::uuid, nullif(p->>'user_id', '')::uuid)
  RETURNING id INTO v_id;
  INSERT INTO cashbook.account_balances (account_id, tenant_id, allows_negative)
  VALUES (v_id, v_t, (p->>'allows_negative')::boolean);
  RETURN v_id;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.open_day(p_date date, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
DECLARE v_t uuid := cashbook._tenant(); v_ultima date;
BEGIN
  IF p_user IS NULL THEN PERFORM cashbook._falla('cashbook_asiento_actor', 'abre la jornada una persona'); END IF;
  INSERT INTO cashbook.seq_counters (tenant_id) VALUES (v_t) ON CONFLICT (tenant_id) DO NOTHING;
  PERFORM 1 FROM cashbook.seq_counters WHERE tenant_id = v_t FOR UPDATE;
  IF EXISTS (SELECT 1 FROM cashbook.business_days WHERE tenant_id = v_t AND state = 'abierta') THEN
    PERFORM cashbook._falla('cashbook_ya_hay_jornada_abierta', 'sin cierre de la jornada abierta no se opera otra (B20)');
  END IF;
  SELECT max(business_date) INTO v_ultima FROM cashbook.business_days WHERE tenant_id = v_t;
  IF v_ultima IS NOT NULL AND p_date <= v_ultima THEN
    PERFORM cashbook._falla('cashbook_jornada_anterior', p_date || ' no es posterior a la última jornada (' || v_ultima || ')');
  END IF;
  INSERT INTO cashbook.business_days (tenant_id, business_date, state, opened_by, created_by, updated_by)
  VALUES (v_t, p_date, 'abierta', p_user, p_user, p_user);
END $fn$;

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

-- Saldo de cada cuenta HASTA un asiento: lo que el corte y el arqueo comparan (B40).
CREATE OR REPLACE FUNCTION cashbook.balances_at(p_seq bigint)
RETURNS TABLE (account_id uuid, code text, currency char(3), balance_minor bigint)
LANGUAGE sql STABLE AS $fn$
  SELECT a.id, a.code, a.currency, coalesce(sum(l.amount_minor), 0)::bigint
    FROM cashbook.accounts a
    LEFT JOIN cashbook.entry_lines l ON l.account_id = a.id
     AND EXISTS (SELECT 1 FROM cashbook.entries e WHERE e.id = l.entry_id AND e.seq <= p_seq)
   WHERE a.tenant_id = cashbook.current_tenant()
   GROUP BY a.id, a.code, a.currency
$fn$;

-- Recorre la cadena: cada problema, una fila. Vacía = íntegra (I7, I8).
CREATE OR REPLACE FUNCTION cashbook.verify_chain()
RETURNS TABLE (seq bigint, problema text)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE v_t uuid := cashbook._tenant(); e record; v_prev text := 'GENESIS'; v_esperado bigint := 1; c record;
BEGIN
  FOR e IN SELECT x.id, x.seq, x.prev_hash, x.hash FROM cashbook.entries x WHERE x.tenant_id = v_t ORDER BY x.seq LOOP
    IF e.seq <> v_esperado THEN seq := e.seq; problema := 'hueco: se esperaba ' || v_esperado; RETURN NEXT; END IF;
    IF e.prev_hash <> v_prev THEN seq := e.seq; problema := 'eslabón roto: prev_hash no es el hash anterior'; RETURN NEXT; END IF;
    IF e.hash IS NULL OR e.hash <> cashbook._huella(cashbook.canonical(e.id)) THEN
      seq := e.seq; problema := 'contenido alterado: el hash no corresponde a las filas'; RETURN NEXT;
    END IF;
    v_prev := e.hash; v_esperado := e.seq + 1;
  END LOOP;
  SELECT * INTO c FROM cashbook.seq_counters WHERE tenant_id = v_t;
  IF FOUND AND (c.last_seq <> v_esperado - 1 OR c.last_hash <> v_prev) THEN
    seq := c.last_seq; problema := 'el contador no coincide con el último asiento'; RETURN NEXT;
  END IF;
END $fn$;
`;

// ── 3. Candados de estructura (triggers) ─────────────────────────────────────────────────────
const CANDADOS = `
-- Sólo se agrega (I6). Vale también para el dueño: quitarlo es DDL y queda en ddl_audit.
CREATE OR REPLACE FUNCTION cashbook.inmutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Anidado: PL/pgSQL no corta el AND, y en las otras tablas OLD no tiene «hash».
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'entries' THEN
    IF OLD.hash IS NULL AND NEW.hash IS NOT NULL AND (to_jsonb(NEW) - 'hash') = (to_jsonb(OLD) - 'hash') THEN
      RETURN NEW;   -- el sello, una sola vez, dentro de la misma transacción que lo crea
    END IF;
  END IF;
  RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable',
    DETAIL = TG_OP || ' sobre cashbook.' || TG_TABLE_NAME || ': el libro sólo se agrega; se corrige con una reversa';
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.linea_de_asiento_abierto() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_sellado boolean;
BEGIN
  IF TG_TABLE_NAME = 'entry_lines' THEN
    SELECT hash IS NOT NULL INTO v_sellado FROM cashbook.entries WHERE id = NEW.entry_id;
  ELSE
    SELECT e.hash IS NOT NULL INTO v_sellado FROM cashbook.entry_lines l JOIN cashbook.entries e ON e.id = l.entry_id WHERE l.id = NEW.line_id;
  END IF;
  IF v_sellado THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable',
      DETAIL = 'no se agregan líneas ni piezas a un asiento sellado';
  END IF;
  RETURN NEW;
END $fn$;

-- Segunda línea de defensa (I1, I5, sello): al confirmar, todo asiento cuadra y está sellado,
-- aunque alguien lo haya insertado sin pasar por _post.
CREATE OR REPLACE FUNCTION cashbook.asiento_cuadra() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_hash text; v_n int;
BEGIN
  SELECT hash INTO v_hash FROM cashbook.entries WHERE id = NEW.id;
  SELECT count(*) INTO v_n FROM cashbook.entry_lines WHERE entry_id = NEW.id;
  IF v_hash IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_ASIENTO_SIN_SELLO', ERRCODE = '23514', CONSTRAINT = 'cashbook_asiento_sin_sello', DETAIL = NEW.id::text;
  END IF;
  IF v_n < 2 OR EXISTS (SELECT 1 FROM cashbook.entry_lines WHERE entry_id = NEW.id GROUP BY currency HAVING sum(amount_minor) <> 0) THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_NO_CUADRA', ERRCODE = '23514', CONSTRAINT = 'cashbook_no_cuadra', DETAIL = NEW.id::text;
  END IF;
  RETURN NULL;
END $fn$;

-- Una cuenta no cambia de clase, moneda ni reglas; se cierra y se abre otra.
CREATE OR REPLACE FUNCTION cashbook.cuenta_estable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.tenant_id <> OLD.tenant_id OR NEW.code <> OLD.code OR NEW.class <> OLD.class
     OR NEW.currency <> OLD.currency OR NEW.tracks_pieces <> OLD.tracks_pieces OR NEW.allows_negative <> OLD.allows_negative
     OR NEW.holder_kind <> OLD.holder_kind OR NEW.holder_ref IS DISTINCT FROM OLD.holder_ref
     OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_CUENTA_ESTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_cuenta_estable',
      DETAIL = 'una cuenta no cambia de identidad ni se reabre: se cierra y se abre otra';
  END IF;
  RETURN NEW;
END $fn$;

-- Una jornada cerrada no se toca; una solicitud decidida, tampoco.
CREATE OR REPLACE FUNCTION cashbook.estado_final() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable', DETAIL = 'DELETE sobre cashbook.' || TG_TABLE_NAME;
  END IF;
  IF (TG_TABLE_NAME = 'business_days' AND OLD.state = 'cerrada') OR (TG_TABLE_NAME = 'requests' AND OLD.state <> 'pendiente') THEN
    RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_ESTADO_FINAL', ERRCODE = '23514', CONSTRAINT = 'cashbook_estado_final',
      DETAIL = 'cashbook.' || TG_TABLE_NAME || ' en estado ' || OLD.state || ' ya no cambia';
  END IF;
  -- Anidado a propósito: PL/pgSQL no corta el AND, y business_days no tiene payload.
  IF TG_TABLE_NAME = 'requests' THEN
    IF NEW.payload <> OLD.payload OR NEW.request_hash <> OLD.request_hash
       OR NEW.registered_by <> OLD.registered_by OR NEW.event_kind <> OLD.event_kind THEN
      RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable',
        DETAIL = 'lo que se pidió no cambia: se rechaza y se pide otra vez';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION cashbook.sin_truncate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'CASHBOOK_INMUTABLE', ERRCODE = '23514', CONSTRAINT = 'cashbook_inmutable', DETAIL = 'TRUNCATE sobre cashbook.' || TG_TABLE_NAME;
END $fn$;

DROP TRIGGER IF EXISTS trg_cashbook_entries_inmutable ON cashbook.entries;
CREATE TRIGGER trg_cashbook_entries_inmutable BEFORE UPDATE OR DELETE ON cashbook.entries FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable();
DROP TRIGGER IF EXISTS trg_cashbook_lines_inmutable ON cashbook.entry_lines;
CREATE TRIGGER trg_cashbook_lines_inmutable BEFORE UPDATE OR DELETE ON cashbook.entry_lines FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable();
DROP TRIGGER IF EXISTS trg_cashbook_pieces_inmutable ON cashbook.entry_pieces;
CREATE TRIGGER trg_cashbook_pieces_inmutable BEFORE UPDATE OR DELETE ON cashbook.entry_pieces FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable();
DROP TRIGGER IF EXISTS trg_cashbook_lines_abierto ON cashbook.entry_lines;
CREATE TRIGGER trg_cashbook_lines_abierto BEFORE INSERT ON cashbook.entry_lines FOR EACH ROW EXECUTE FUNCTION cashbook.linea_de_asiento_abierto();
DROP TRIGGER IF EXISTS trg_cashbook_pieces_abierto ON cashbook.entry_pieces;
CREATE TRIGGER trg_cashbook_pieces_abierto BEFORE INSERT ON cashbook.entry_pieces FOR EACH ROW EXECUTE FUNCTION cashbook.linea_de_asiento_abierto();
DROP TRIGGER IF EXISTS trg_cashbook_asiento_cuadra ON cashbook.entries;
CREATE CONSTRAINT TRIGGER trg_cashbook_asiento_cuadra AFTER INSERT ON cashbook.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cashbook.asiento_cuadra();
DROP TRIGGER IF EXISTS trg_cashbook_cuenta_estable ON cashbook.accounts;
CREATE TRIGGER trg_cashbook_cuenta_estable BEFORE UPDATE OR DELETE ON cashbook.accounts FOR EACH ROW EXECUTE FUNCTION cashbook.cuenta_estable();
DROP TRIGGER IF EXISTS trg_cashbook_dias_final ON cashbook.business_days;
CREATE TRIGGER trg_cashbook_dias_final BEFORE UPDATE OR DELETE ON cashbook.business_days FOR EACH ROW EXECUTE FUNCTION cashbook.estado_final();
DROP TRIGGER IF EXISTS trg_cashbook_solicitudes_final ON cashbook.requests;
CREATE TRIGGER trg_cashbook_solicitudes_final BEFORE UPDATE OR DELETE ON cashbook.requests FOR EACH ROW EXECUTE FUNCTION cashbook.estado_final();
DROP TRIGGER IF EXISTS trg_cashbook_saldos_sin_borrar ON cashbook.account_balances;
CREATE TRIGGER trg_cashbook_saldos_sin_borrar BEFORE DELETE ON cashbook.account_balances FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable();
DROP TRIGGER IF EXISTS trg_cashbook_piezas_sin_borrar ON cashbook.account_piece_balances;
CREATE TRIGGER trg_cashbook_piezas_sin_borrar BEFORE DELETE ON cashbook.account_piece_balances FOR EACH ROW EXECUTE FUNCTION cashbook.inmutable();
`;

const TABLAS_DEL_LIBRO = ['accounts', 'account_balances', 'account_piece_balances', 'seq_counters', 'business_days',
  'entries', 'entry_lines', 'entry_pieces', 'authorization_rules', 'requests'];

const VISTAS = `
CREATE OR REPLACE VIEW cashbook.v_saldos WITH (security_invoker = true) AS
SELECT a.tenant_id, a.id AS account_id, a.code, a.name, a.class, a.currency, a.holder_kind, a.holder_ref,
       b.balance_minor, (b.balance_minor::numeric / 100)::numeric(18,2) AS balance, b.last_seq, a.closed_at
  FROM cashbook.accounts a JOIN cashbook.account_balances b ON b.account_id = a.id;

CREATE OR REPLACE VIEW cashbook.v_saldos_piezas WITH (security_invoker = true) AS
SELECT a.tenant_id, a.id AS account_id, a.code, p.currency, p.denom_key, d.family, d.value_minor, p.pieces,
       (p.pieces * d.value_minor) AS amount_minor
  FROM cashbook.account_piece_balances p
  JOIN cashbook.accounts a ON a.id = p.account_id
  JOIN cashbook.denominations d ON d.currency = p.currency AND d.denom_key = p.denom_key;

CREATE OR REPLACE VIEW cashbook.v_mayor WITH (security_invoker = true) AS
SELECT e.tenant_id, e.seq, e.business_date, e.value_at, e.recorded_at, e.event_kind, e.event_ref, e.event_version,
       e.actor_kind, e.created_by, e.service_name, e.authorized_by, e.reverses_entry_id, e.reason, e.rule_version,
       l.line_no, a.code AS account_code, l.currency, l.amount_minor, e.id AS entry_id, l.id AS line_id
  FROM cashbook.entries e JOIN cashbook.entry_lines l ON l.entry_id = e.id JOIN cashbook.accounts a ON a.id = l.account_id;

-- I10: la cabecera es la suma de las líneas. Debe dar CERO filas; el cierre diario lo exige.
CREATE OR REPLACE VIEW cashbook.v_descuadre_interno WITH (security_invoker = true) AS
SELECT b.tenant_id, b.account_id, NULL::text AS denom_key, b.balance_minor AS cabecera, coalesce(s.suma, 0)::bigint AS suma_de_lineas
  FROM cashbook.account_balances b
  LEFT JOIN (SELECT account_id, sum(amount_minor) AS suma FROM cashbook.entry_lines GROUP BY 1) s ON s.account_id = b.account_id
 WHERE b.balance_minor <> coalesce(s.suma, 0)
UNION ALL
SELECT p.tenant_id, p.account_id, p.denom_key, p.pieces, coalesce(s.suma, 0)::bigint
  FROM cashbook.account_piece_balances p
  LEFT JOIN (SELECT l.account_id, ep.denom_key, sum(ep.pieces) AS suma
               FROM cashbook.entry_pieces ep JOIN cashbook.entry_lines l ON l.id = ep.line_id GROUP BY 1, 2) s
    ON s.account_id = p.account_id AND s.denom_key = p.denom_key
 WHERE p.pieces <> coalesce(s.suma, 0);
`;

const FUNCIONES_PUBLICAS = ['post_entry(jsonb)', 'create_request(jsonb, timestamptz)', 'authorize_request(uuid, uuid, uuid)',
  'reject_request(uuid, uuid, uuid, text)', 'expire_requests()', 'open_account(jsonb)', 'open_day(date, uuid)',
  'close_day(date, uuid, uuid, uuid, uuid)', 'balances_at(bigint)', 'verify_chain()', 'canonical(uuid)'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [yo] } = await knex.raw(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`);

  // ── Rol dueño y esquema ────────────────────────────────────────────────────────────────────
  await knex.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cashbook_owner') THEN
      CREATE ROLE cashbook_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF; END $$`);
  await knex.raw(`ALTER ROLE cashbook_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS cashbook AUTHORIZATION cashbook_owner`);
  await knex.raw(`REVOKE ALL ON SCHEMA cashbook FROM PUBLIC`);
  // La bitácora genérica (VP.3.1) corre con los permisos de quien escribe: el dueño necesita insertar ahí.
  const { rows: [hist] } = await knex.raw(`SELECT to_regclass('analytics.master_data_history') IS NOT NULL AS t,
      to_regprocedure('analytics.log_master_data_change()') IS NOT NULL AS f`);
  if (hist.t && hist.f) {
    await knex.raw(`GRANT USAGE ON SCHEMA analytics TO cashbook_owner`);
    await knex.raw(`GRANT INSERT ON analytics.master_data_history TO cashbook_owner`);
    await knex.raw(`GRANT USAGE ON SEQUENCE analytics.master_data_history_id_seq TO cashbook_owner`);
  }

  // ── Todo lo que sigue lo crea el DUEÑO, no el superusuario ─────────────────────────────────
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  // La MISMA expresión que `current_tenant_id()` del arranque, en el esquema del libro: esa función
  // quedó en `public` en prod y en `identity` en la base de prueba (según el search_path de quien la
  // creó). El libro no depende de dónde quedó.
  await knex.raw(`CREATE OR REPLACE FUNCTION cashbook.current_tenant() RETURNS uuid
    LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $fn$`);
  await knex.raw(TABLAS);
  for (const t of TABLAS_DEL_LIBRO) {
    await knex.raw(`ALTER TABLE cashbook.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE cashbook.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON cashbook.${t}`);
    await knex.raw(`CREATE POLICY tenant_isolation ON cashbook.${t}
      USING (tenant_id = cashbook.current_tenant()) WITH CHECK (tenant_id = cashbook.current_tenant())`);
  }
  await knex.raw(FUNCIONES);
  await knex.raw(CANDADOS);
  for (const t of TABLAS_DEL_LIBRO) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_cashbook_sin_truncate ON cashbook.${t}`);
    await knex.raw(`CREATE TRIGGER trg_cashbook_sin_truncate BEFORE TRUNCATE ON cashbook.${t}
      FOR EACH STATEMENT EXECUTE FUNCTION cashbook.sin_truncate()`);
  }
  await knex.raw(VISTAS);
  if (hist.t && hist.f) {
    const vigiladas = {
      accounts: "'name', 'witness', 'closed_at'",
      authorization_rules: "'threshold_minor'",
      business_days: "'state', 'closed_by', 'authorized_by', 'closing_seq', 'closing_hash'",
      requests: "'state', 'decided_by', 'decision_note', 'entry_id'",
    };
    for (const [t, cols] of Object.entries(vigiladas)) {
      await knex.raw(`DROP TRIGGER IF EXISTS trg_master_data_history ON cashbook.${t}`);
      await knex.raw(`CREATE TRIGGER trg_master_data_history AFTER UPDATE OR DELETE ON cashbook.${t}
        FOR EACH ROW EXECUTE FUNCTION analytics.log_master_data_change(${cols})`);
    }
  }

  // ── Catálogos ──────────────────────────────────────────────────────────────────────────────
  const den = DENOMINACIONES.map(([c, k, v, f]) => `('${c}', '${k}', ${v}, '${f}')`).join(', ');
  await knex.raw(`INSERT INTO cashbook.denominations (currency, denom_key, value_minor, family) VALUES ${den}
    ON CONFLICT (currency, denom_key) DO NOTHING`);
  await knex.raw(`SELECT set_config('app.tenant_id', '${TENANT_MD}', true)`);
  for (const [code, name, clase, cur, piezas, neg, testigo] of CUENTAS_BASE) {
    await knex.raw(`SELECT cashbook.open_account(jsonb_build_object('code', '${code}', 'name', '${name}', 'class', '${clase}',
        'currency', '${cur}', 'tracks_pieces', ${piezas}, 'allows_negative', ${neg}, 'witness', '${testigo}'))
      WHERE NOT EXISTS (SELECT 1 FROM cashbook.accounts WHERE tenant_id = '${TENANT_MD}' AND code = '${code}')`);
  }
  await knex.raw(`RESET ROLE`);

  // ── Privilegios: la app LEE y llama funciones; nunca escribe una tabla (B39) ───────────────
  await knex.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA cashbook FROM PUBLIC`);
  await knex.raw(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cashbook FROM PUBLIC`);
  await knex.raw(`GRANT USAGE ON SCHEMA cashbook TO app_runtime`);
  await knex.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA cashbook FROM app_runtime`);
  await knex.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA cashbook TO app_runtime`);
  await knex.raw(`REVOKE SELECT ON cashbook.ddl_audit FROM app_runtime`);
  for (const f of FUNCIONES_PUBLICAS) await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  // Las internas las usan las públicas (SECURITY DEFINER, como el dueño) y las vistas del lector.
  for (const f of ['current_tenant()', '_tenant()', '_huella(text)', '_falla(text, text)']) {
    await knex.raw(`GRANT EXECUTE ON FUNCTION cashbook.${f} TO app_runtime`);
  }
  const { rows: [ro] } = await knex.raw(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') AS hay`);
  if (ro.hay) {
    await knex.raw(`GRANT USAGE ON SCHEMA cashbook TO dev_ro`);
    await knex.raw(`GRANT SELECT ON ALL TABLES IN SCHEMA cashbook TO dev_ro`);
  }

  // ── Bitácora de DDL (B21): quitar un candado es DDL, y queda escrito ───────────────────────
  if (yo.su) {
    await knex.raw(`
      CREATE OR REPLACE FUNCTION cashbook.registrar_ddl() RETURNS event_trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, cashbook, pg_temp AS $fn$
      DECLARE r record;
      BEGIN
        IF TG_EVENT = 'sql_drop' THEN
          FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() WHERE schema_name = 'cashbook' LOOP
            INSERT INTO cashbook.ddl_audit (command_tag, object_type, object_identity) VALUES (TG_TAG, r.object_type, r.object_identity);
          END LOOP;
        ELSE
          FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE schema_name = 'cashbook' LOOP
            INSERT INTO cashbook.ddl_audit (command_tag, object_type, object_identity) VALUES (r.command_tag, r.object_type, r.object_identity);
          END LOOP;
        END IF;
      END $fn$`);
    await knex.raw(`REVOKE ALL ON FUNCTION cashbook.registrar_ddl() FROM PUBLIC`);
    await knex.raw(`DROP EVENT TRIGGER IF EXISTS cashbook_ddl_fin`);
    await knex.raw(`CREATE EVENT TRIGGER cashbook_ddl_fin ON ddl_command_end EXECUTE FUNCTION cashbook.registrar_ddl()`);
    await knex.raw(`DROP EVENT TRIGGER IF EXISTS cashbook_ddl_borrado`);
    await knex.raw(`CREATE EVENT TRIGGER cashbook_ddl_borrado ON sql_drop EXECUTE FUNCTION cashbook.registrar_ddl()`);
  } else {
    // eslint-disable-next-line no-console
    console.log('  ⚠️ [LE.1.11] NO MEDIDO: sin superusuario no se crea la bitácora de DDL del libro.');
  }

  const { rows: [n] } = await knex.raw(`SELECT
      (SELECT count(*) FROM cashbook.denominations)::int AS denominaciones,
      (SELECT count(*) FROM cashbook.accounts WHERE tenant_id = '${TENANT_MD}')::int AS cuentas`);
  // eslint-disable-next-line no-console
  console.log(`  ✓ [LE.1] libro creado: ${n.denominaciones} denominaciones, ${n.cuentas} cuentas base, cero asientos`);
};

/**
 * Quita el libro SÓLO si está vacío. Un libro con asientos no se baja: se congela (B23, retención).
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regclass('cashbook.entries') IS NOT NULL AS hay`);
  if (h.hay) {
    const { rows: [c] } = await knex.raw(`SELECT count(*)::int AS n FROM cashbook.entries`);
    if (c.n > 0) throw new Error(`[LE.1] el libro tiene ${c.n} asientos: no se baja, se congela (B23).`);
  }
  await knex.raw(`DROP EVENT TRIGGER IF EXISTS cashbook_ddl_fin`);
  await knex.raw(`DROP EVENT TRIGGER IF EXISTS cashbook_ddl_borrado`);
  await knex.raw(`DROP SCHEMA IF EXISTS cashbook CASCADE`);
  await knex.raw(`DO $$ BEGIN
    IF to_regclass('analytics.master_data_history') IS NOT NULL THEN
      REVOKE INSERT ON analytics.master_data_history FROM cashbook_owner;
      REVOKE USAGE ON SEQUENCE analytics.master_data_history_id_seq FROM cashbook_owner;
      REVOKE USAGE ON SCHEMA analytics FROM cashbook_owner;
    END IF;
    DROP ROLE IF EXISTS cashbook_owner;
  EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'cashbook_owner tiene objetos en otra base: el rol se queda';
  END $$`);
};
