'use strict';
/**
 * `[CGA-A.65]` — Una hoja pagada con el CAJÓN lleva su conteo: piezas por denominación y morralla.
 *
 * Edgar, 2026-10-30, después de pagar HG-1 (Zona Morelia) con el cajón sin que nada le pidiera contar:
 * *«cuando sea de cajón que se haga un arqueo»*. El pago con cajón es la excepción (sin retiro de CAOS
 * detrás): lo que sale del cajón se cuenta al pagar, y la base lo exige, no sólo la pantalla.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · Prod, 2026-10-30: la única hoja pagada (HG-1) salió del cajón sin un billete declarado; el primer
 *    conteo de ese dinero sería el corte del día. No se le exige retroactivo: ya salió.
 *
 * Qué hace:
 *  · `finance.expense_sheets.conteo` (jsonb, `{clave: piezas}` con las claves de `DENOMINACIONES_MXN`)
 *    y `conteo_morralla` (lo de menos de 50¢).
 *  · `expense_sheets_transicion()`: al pagar (aprobada → pagada) con `medio = 'cajon'`, el conteo es
 *    obligatorio, sus claves son del catálogo, sus piezas enteras, y suma EXACTAMENTE `cajon`. Y las
 *    dos columnas se escriben al pagar (el resto de la hoja aprobada sigue sin tocarse). Conserva el
 *    arreglo de `20261030133058` (sin `folio`, que en un BEFORE viene NULL).
 *
 * Idempotente. Sin las tablas no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const anterior = require('./20261030133058_cga_a65_hoja_cerrar_y_pagar.js');

const TRANSICION = `
CREATE OR REPLACE FUNCTION finance.expense_sheets_transicion() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE v_suma numeric; v_mala text;
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
    -- Al pagarla sólo se escribe el pago (y su conteo): lo aprobado no cambia.
    IF (to_jsonb(NEW) - 'folio' - 'updated_at' - 'updated_by' - 'estado' - 'medio' - 'pagada_por' - 'pagada_at'
          - 'caos_device' - 'caos_external_id' - 'caos_total' - 'cajon' - 'conteo' - 'conteo_morralla')
       IS DISTINCT FROM (to_jsonb(OLD) - 'folio' - 'updated_at' - 'updated_by' - 'estado' - 'medio' - 'pagada_por' - 'pagada_at'
          - 'caos_device' - 'caos_external_id' - 'caos_total' - 'cajon' - 'conteo' - 'conteo_morralla') THEN
      RAISE EXCEPTION 'expense_sheet_resuelta: al pagar la hoja % sólo se escribe su pago', OLD.numero
        USING ERRCODE = 'check_violation';
    END IF;
    -- Edgar, 2026-10-30: «cuando sea de cajón que se haga un arqueo».
    IF NEW.medio = 'cajon' THEN
      IF NEW.conteo IS NULL OR jsonb_typeof(NEW.conteo) <> 'object' THEN
        RAISE EXCEPTION 'expense_sheet_conteo: la hoja % sale del cajón y no trae su conteo', OLD.numero
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT string_agg(e.key || '=' || e.value, ', ') INTO v_mala FROM jsonb_each_text(NEW.conteo) e
       WHERE e.key !~ '^(1000|500|200|100|50|20|20m|10|5|2|1|0\\.5)$' OR e.value !~ '^[0-9]+$';
      IF v_mala IS NOT NULL THEN
        RAISE EXCEPTION 'expense_sheet_conteo: la hoja % trae piezas que no son un conteo (%)', OLD.numero, v_mala
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(e.value::numeric * regexp_replace(e.key, 'm$', '')::numeric), 0) + coalesce(NEW.conteo_morralla, 0)
        INTO v_suma FROM jsonb_each_text(NEW.conteo) e;
      IF abs(v_suma - NEW.cajon) > 0.005 THEN
        RAISE EXCEPTION 'expense_sheet_conteo: el conteo de la hoja % suma % y del cajón salen %', OLD.numero, v_suma, NEW.cajon
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  -- Resuelta (aprobada, rechazada, cancelada o pagada) ya no se toca: ni el estado ni quién firmó ni el motivo.
  ELSIF OLD.estado <> 'cerrada'
     AND (to_jsonb(NEW) - 'folio' - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'folio' - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'expense_sheet_resuelta: la hoja % ya está %', OLD.numero, OLD.estado
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;`;

async function hayHojas(knex) {
  const r = await knex.raw(`SELECT to_regclass('finance.expense_sheets') IS NOT NULL AS t`);
  return r.rows[0].t === true;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await hayHojas(knex))) return;
  await knex.raw(`
    ALTER TABLE finance.expense_sheets ADD COLUMN IF NOT EXISTS conteo jsonb;
    ALTER TABLE finance.expense_sheets ADD COLUMN IF NOT EXISTS conteo_morralla numeric(14,2);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_sheet_conteo_morralla') THEN
        ALTER TABLE finance.expense_sheets ADD CONSTRAINT expense_sheet_conteo_morralla
          CHECK (conteo_morralla IS NULL OR (conteo_morralla >= 0 AND conteo_morralla < 0.5));
      END IF;
    END $$;
    COMMENT ON COLUMN finance.expense_sheets.conteo IS '[CGA-A.65] Lo que salió del cajón al pagar, contado: {clave de DENOMINACIONES_MXN: piezas}. Obligatorio con medio = cajon.';
    COMMENT ON COLUMN finance.expense_sheets.conteo_morralla IS '[CGA-A.65] Lo de menos de 50¢ del conteo del cajón.';
  `);
  await knex.raw(TRANSICION);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la transición como la dejó `20261030133058` y sin las dos columnas. */
exports.down = async function down(knex) {
  if (!(await hayHojas(knex))) return;
  await anterior.up(knex);
  await knex.raw(`
    ALTER TABLE finance.expense_sheets DROP CONSTRAINT IF EXISTS expense_sheet_conteo_morralla;
    ALTER TABLE finance.expense_sheets DROP COLUMN IF EXISTS conteo_morralla;
    ALTER TABLE finance.expense_sheets DROP COLUMN IF EXISTS conteo;
  `);
};
