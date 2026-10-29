'use strict';
/**
 * `[CGA-A.65]` — La hoja de gastos de zona: lo que hoy es el Excel «Formato de autorización de gastos
 * 1.0» (área «ZONA MORELIA»), armado solo desde Kepler y firmado en la Suite.
 *
 * Edgar, 2026-10-29: *«no queremos impresiones, solo quiero que se automatice el proceso tanto del
 * excel como a la hora de pagar»*. La hoja ABIERTA no se guarda: se deriva de Kepler cada vez
 * (`hoja-gastos.query.ts` + `hoja-gastos.engine.ts`). Lo que se guarda es lo que una PERSONA decide
 * —cerrarla, aprobarla, rechazarla— con su foto de los renglones: lo aprobado no cambia aunque
 * Kepler cambie después (datos propios, la excepción legítima a derive-no-copy).
 *
 * ── Medido antes (prod, sólo lectura, 2026-10-29) ───────────────────────────────────────────
 *  · Con la regla del motor, la consulta real saca 6 de 6 días de octubre iguales al centavo que su
 *    depósito en el banco. Hoy, la primera hoja de Morelia serían 14 pagos.
 *  · Las dos hojas en papel tienen la firma de finanzas en blanco, y en una la misma persona pidió
 *    y autorizó: aquí la base lo impide (cuatro ojos).
 *
 * ── Qué crea ─────────────────────────────────────────────────────────────────────────────────
 *  · `finance.expense_sheets`: una hoja cerrada, con su número (folio «HG-n»), su zona, la venta de
 *    la que salió el dinero, su total y quién la cerró, aprobó, rechazó, canceló o pagó. Estados:
 *    cerrada → aprobada → pagada, o cerrada → rechazada | cancelada. El pago es UNO (Edgar,
 *    2026-10-29: «todo lo de reposición es que salga de un solo movimiento de CAOS»): el retiro que
 *    la paga entera y lo que puso el cajón (menos de $500), o el cajón entero por excepción.
 *  · `finance.expense_sheet_lines`: sus renglones (el pago de Kepler por su `origen_ref`, la misma
 *    llave que el libro de Caja General), con su importe al cerrar. Un pago, en UNA sola hoja
 *    vigente; al rechazar o cancelar, sus renglones dejan de ser vigentes y vuelven a la hoja abierta.
 *
 * ── Lo que la base sostiene (cada regla con su negativa en `test-newdb-hoja-gastos.js`) ──────────
 *  · cuatro ojos: quien cerró no aprueba ni rechaza, y quien aprobó no paga;
 *  · las transiciones: sólo desde «cerrada», y sin aprobación no se paga («si no está aprobada no
 *    se puede pagar», Edgar); lo resuelto no se reabre, y al pagar sólo se escribe el pago;
 *  · un retiro de CAOS paga UNA sola hoja, y el retiro más el cajón son la hoja;
 *  · el renglón no cambia (sólo deja de ser vigente cuando su hoja se rechaza o se cancela);
 *  · el total y el número de renglones de la hoja son la suma de sus renglones (al confirmar).
 *
 * ⛔ Esta migración NO escribe en el libro viejo de Caja General (`cash_ledger`, `caos_cash_links`).
 *    Al pagar, el servicio usa los escritores que ya existen (el lote y el alta de vínculo): ninguno
 *    nuevo, la misma excepción a LE.0.4 que `[CGA-A.61]`. Ni un `?` en el SQL (knex lo toma como
 *    binding). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = `
CREATE TABLE IF NOT EXISTS finance.expense_sheets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  numero           integer NOT NULL CHECK (numero > 0),
  folio            text GENERATED ALWAYS AS ('HG-' || numero::text) STORED,
  zona             text NOT NULL CHECK (zona ~ '^[a-z][a-z0-9_]*$'),
  venta_del_dia    date NOT NULL,
  estado           text NOT NULL DEFAULT 'cerrada' CHECK (estado IN ('cerrada', 'aprobada', 'rechazada', 'cancelada', 'pagada')),
  total            numeric(14,2) NOT NULL CHECK (total > 0),
  renglones        integer NOT NULL CHECK (renglones > 0),
  client_key       text NOT NULL CHECK (length(btrim(client_key)) BETWEEN 8 AND 200),
  cerrada_por      uuid NOT NULL,
  cerrada_at       timestamptz NOT NULL DEFAULT now(),
  aprobada_por     uuid,
  aprobada_at      timestamptz,
  rechazada_por    uuid,
  rechazada_at     timestamptz,
  cancelada_por    uuid,
  cancelada_at     timestamptz,
  motivo           text,
  -- El pago: UN retiro de CAOS (con la diferencia del cajón) o, por excepción, el cajón entero.
  medio            text CHECK (medio IN ('caos', 'cajon')),
  pagada_por       uuid,
  pagada_at        timestamptz,
  caos_device      text,
  caos_external_id bigint,
  caos_total       numeric(14,2),
  cajon            numeric(14,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT ux_expense_sheet_numero UNIQUE (tenant_id, numero),
  CONSTRAINT ux_expense_sheet_client_key UNIQUE (tenant_id, client_key),
  CONSTRAINT expense_sheet_aprobada CHECK ((estado IN ('aprobada', 'pagada')) = (aprobada_por IS NOT NULL AND aprobada_at IS NOT NULL)),
  CONSTRAINT expense_sheet_rechazada CHECK ((estado = 'rechazada') = (rechazada_por IS NOT NULL AND rechazada_at IS NOT NULL)),
  CONSTRAINT expense_sheet_cancelada CHECK ((estado = 'cancelada') = (cancelada_por IS NOT NULL AND cancelada_at IS NOT NULL)),
  CONSTRAINT expense_sheet_motivo CHECK (estado NOT IN ('rechazada', 'cancelada') OR length(btrim(coalesce(motivo, ''))) >= 10),
  CONSTRAINT expense_sheet_cuatro_ojos CHECK (aprobada_por IS DISTINCT FROM cerrada_por AND rechazada_por IS DISTINCT FROM cerrada_por),
  CONSTRAINT expense_sheet_pagada CHECK ((estado = 'pagada') = (pagada_por IS NOT NULL AND pagada_at IS NOT NULL AND medio IS NOT NULL AND cajon IS NOT NULL)),
  -- Con un retiro: el retiro más el cajón son la hoja, y el cajón pone menos de 500 pesos. Con el cajón: todo.
  CONSTRAINT expense_sheet_medio CHECK (medio IS NULL
    OR (medio = 'caos' AND caos_device IS NOT NULL AND caos_external_id IS NOT NULL AND caos_total > 0
        AND cajon >= 0 AND cajon < 500 AND caos_total + cajon = total)
    OR (medio = 'cajon' AND caos_device IS NULL AND caos_external_id IS NULL AND caos_total IS NULL AND cajon = total)),
  -- Quien aprobó la hoja no la paga.
  CONSTRAINT expense_sheet_paga_otro CHECK (pagada_por IS NULL OR pagada_por IS DISTINCT FROM aprobada_por)
);
CREATE INDEX IF NOT EXISTS ix_expense_sheets_zona ON finance.expense_sheets (tenant_id, zona, estado, cerrada_at DESC);
-- ⭐ Un retiro de CAOS paga UNA sola hoja.
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_sheet_retiro ON finance.expense_sheets (tenant_id, caos_device, caos_external_id)
  WHERE caos_external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance.expense_sheet_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  sheet_id         uuid NOT NULL REFERENCES finance.expense_sheets(id),
  origen_ref       text NOT NULL CHECK (origen_ref ~ '^[0-9]{2}[|][^|]+[|][^|]+[|]0011$'),
  sucursal         text NOT NULL,
  doc_tipo         text NOT NULL,
  folio            text NOT NULL,
  fecha_pago       date NOT NULL,
  fecha_captura    date,
  beneficiario     text,
  clave            text,
  centro           text,
  clase            text NOT NULL CHECK (clase IN ('proveedor', 'gasto', 'sin_clave')),
  importe          numeric(14,2) NOT NULL CHECK (importe > 0),
  vigente          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid
);
-- ⭐ Un pago de Kepler va en UNA sola hoja vigente.
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_sheet_line_vigente ON finance.expense_sheet_lines (tenant_id, origen_ref) WHERE vigente;
CREATE INDEX IF NOT EXISTS ix_expense_sheet_lines_sheet ON finance.expense_sheet_lines (tenant_id, sheet_id);
`;

const REGLAS = `
-- Las transiciones: cerrada → aprobada | rechazada | cancelada, y aprobada → pagada. Sin aprobación no
-- se paga, y lo resuelto no se reabre ni se edita.
CREATE OR REPLACE FUNCTION finance.expense_sheets_transicion() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.numero IS DISTINCT FROM OLD.numero
     OR NEW.zona IS DISTINCT FROM OLD.zona OR NEW.venta_del_dia IS DISTINCT FROM OLD.venta_del_dia
     OR NEW.total IS DISTINCT FROM OLD.total OR NEW.renglones IS DISTINCT FROM OLD.renglones
     OR NEW.cerrada_por IS DISTINCT FROM OLD.cerrada_por OR NEW.cerrada_at IS DISTINCT FROM OLD.cerrada_at
     OR NEW.client_key IS DISTINCT FROM OLD.client_key THEN
    RAISE EXCEPTION 'expense_sheet_inmutable: la hoja % no se edita; se rechaza o se cancela', OLD.numero
      USING ERRCODE = 'check_violation';
  END IF;
  -- Edgar, 2026-10-29: «si no está aprobada no se puede pagar».
  IF NEW.estado = 'pagada' AND OLD.estado IS DISTINCT FROM 'pagada' AND OLD.estado <> 'aprobada' THEN
    RAISE EXCEPTION 'expense_sheet_sin_aprobar: la hoja % está %; sólo una aprobada se paga', OLD.numero, OLD.estado
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.estado = 'aprobada' AND NEW.estado = 'pagada' THEN
    -- Al pagarla sólo se escribe el pago: lo aprobado no cambia.
    IF (to_jsonb(NEW) - 'updated_at' - 'updated_by' - 'estado' - 'medio' - 'pagada_por' - 'pagada_at'
          - 'caos_device' - 'caos_external_id' - 'caos_total' - 'cajon')
       IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'updated_by' - 'estado' - 'medio' - 'pagada_por' - 'pagada_at'
          - 'caos_device' - 'caos_external_id' - 'caos_total' - 'cajon') THEN
      RAISE EXCEPTION 'expense_sheet_resuelta: al pagar la hoja % sólo se escribe su pago', OLD.numero
        USING ERRCODE = 'check_violation';
    END IF;
  -- Resuelta (aprobada, rechazada, cancelada o pagada) ya no se toca: ni el estado ni quién firmó ni el motivo.
  ELSIF OLD.estado <> 'cerrada'
     AND (to_jsonb(NEW) - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'expense_sheet_resuelta: la hoja % ya está %', OLD.numero, OLD.estado
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_expense_sheets_transicion ON finance.expense_sheets;
CREATE TRIGGER trg_expense_sheets_transicion BEFORE UPDATE ON finance.expense_sheets
  FOR EACH ROW EXECUTE FUNCTION finance.expense_sheets_transicion();

-- El renglón no cambia: sólo deja de ser vigente, y sólo si su hoja se rechazó o se canceló.
CREATE OR REPLACE FUNCTION finance.expense_sheet_lines_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_estado text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expense_sheet_line_inmutable: un renglón de hoja no se borra' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'vigente' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'vigente' - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'expense_sheet_line_inmutable: el renglón % no se edita', OLD.origen_ref USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.vigente IS DISTINCT FROM OLD.vigente THEN
    SELECT s.estado INTO v_estado FROM finance.expense_sheets s WHERE s.id = NEW.sheet_id;
    IF NEW.vigente OR v_estado NOT IN ('rechazada', 'cancelada') THEN
      RAISE EXCEPTION 'expense_sheet_line_vigencia: sólo deja de ser vigente cuando su hoja se rechaza o se cancela (está %)', v_estado
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_expense_sheet_lines_inmutable ON finance.expense_sheet_lines;
CREATE TRIGGER trg_expense_sheet_lines_inmutable BEFORE UPDATE OR DELETE ON finance.expense_sheet_lines
  FOR EACH ROW EXECUTE FUNCTION finance.expense_sheet_lines_inmutable();

-- El total y los renglones de la hoja son la suma de sus renglones. Se revisa AL CONFIRMAR: la hoja
-- y sus renglones se escriben en la misma transacción.
CREATE OR REPLACE FUNCTION finance.expense_sheets_cuadre() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_id uuid; v_total numeric; v_n integer; v_suma numeric; v_cuenta integer;
BEGIN
  v_id := CASE WHEN TG_TABLE_NAME = 'expense_sheets' THEN NEW.id ELSE NEW.sheet_id END;
  SELECT s.total, s.renglones INTO v_total, v_n FROM finance.expense_sheets s WHERE s.id = v_id;
  SELECT coalesce(sum(l.importe), 0), count(*) INTO v_suma, v_cuenta FROM finance.expense_sheet_lines l WHERE l.sheet_id = v_id;
  IF v_total IS DISTINCT FROM v_suma OR v_n IS DISTINCT FROM v_cuenta THEN
    RAISE EXCEPTION 'expense_sheet_descuadre: la hoja dice % en % renglones y sus renglones suman % en %', v_total, v_n, v_suma, v_cuenta
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS trg_expense_sheets_cuadre ON finance.expense_sheets;
CREATE CONSTRAINT TRIGGER trg_expense_sheets_cuadre AFTER INSERT ON finance.expense_sheets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.expense_sheets_cuadre();
DROP TRIGGER IF EXISTS trg_expense_sheet_lines_cuadre ON finance.expense_sheet_lines;
CREATE CONSTRAINT TRIGGER trg_expense_sheet_lines_cuadre AFTER INSERT ON finance.expense_sheet_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance.expense_sheets_cuadre();
`;

async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname = 'finance' AND tablename = '${table}' AND policyname = 'tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Sin DELETE: una hoja se rechaza o se cancela, no se borra.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  await knex.raw(TABLAS);
  await knex.raw(REGLAS);
  await tenantRls(knex, 'expense_sheets');
  await tenantRls(knex, 'expense_sheet_lines');
  await knex.raw(`COMMENT ON TABLE finance.expense_sheets IS
    '[CGA-A.65] Hoja de gastos de zona cerrada (el Excel «Formato de autorización de gastos», de Kepler). '
    'Folio HG-n en la referencia del retiro de CAOS. Cuatro ojos y transiciones en la base.'`);
  await knex.raw(`COMMENT ON TABLE finance.expense_sheet_lines IS
    '[CGA-A.65] Renglones de una hoja: el pago de Kepler (origen_ref) con su importe al cerrar. '
    'Un pago en una sola hoja vigente; inmutables; el total de la hoja es su suma.'`);
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.expense_sheets`);
  console.log(`[cga_a65_hoja_gastos_zona] finance.expense_sheets y expense_sheet_lines listas · hojas: ${rows[0].n}`);
};

/** Sin hojas guardadas se puede bajar; con hojas, no: son firmas de personas. */
exports.down = async function down(knex) {
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.expense_sheets`);
  if (rows[0].n > 0) throw new Error(`[cga_a65_hoja_gastos_zona] down: hay ${rows[0].n} hojas guardadas; no se borran`);
  await knex.raw(`DROP TABLE IF EXISTS finance.expense_sheet_lines`);
  await knex.raw(`DROP TABLE IF EXISTS finance.expense_sheets`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.expense_sheets_transicion()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.expense_sheet_lines_inmutable()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.expense_sheets_cuadre()`);
};
