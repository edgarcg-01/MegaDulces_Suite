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
 *  · `finance.expense_sheets.conteo` (jsonb, `{clave: piezas}` con las claves de `DENOMINACIONES_MXN`),
 *    `conteo_morralla` (lo de menos de 50¢) y quién lo registró y cuándo (`conteo_por`, `conteo_at`).
 *  · `expense_sheets_transicion()`: al pagar (aprobada → pagada) con `medio = 'cajon'`, el conteo es
 *    obligatorio, sus claves son del catálogo, sus piezas enteras, y suma EXACTAMENTE `cajon`. Y las
 *    dos columnas se escriben al pagar (el resto de la hoja aprobada sigue sin tocarse). Conserva el
 *    arreglo de `20261030133058` (sin `folio`, que en un BEFORE viene NULL).
 *  · Una hoja YA PAGADA con el cajón y sin conteo lo recibe UNA vez, con las mismas reglas. Edgar, el
 *    mismo día: HG-1 tiene su arqueo en papel en Control; «hay que traer ese arqueo». Con el conteo
 *    puesto, la hoja pagada vuelve a ser intocable.
 *
 * Idempotente. Sin las tablas no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const anterior = require('./20261030133058_cga_a65_hoja_cerrar_y_pagar.js');

/** La regla del conteo, una sola vez para los dos caminos (al pagar y después). */
const REVISAR = `
CREATE OR REPLACE FUNCTION finance.expense_sheet_revisar_conteo(p_numero int, p_conteo jsonb, p_morralla numeric, p_cajon numeric)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE v_suma numeric; v_mala text;
BEGIN
  IF p_conteo IS NULL OR jsonb_typeof(p_conteo) <> 'object' THEN
    RAISE EXCEPTION 'expense_sheet_conteo: la hoja % sale del cajón y no trae su conteo', p_numero
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT string_agg(e.key || '=' || e.value, ', ') INTO v_mala FROM jsonb_each_text(p_conteo) e
   WHERE e.key !~ '^(1000|500|200|100|50|20|20m|10|5|2|1|0\\.5)$' OR e.value !~ '^[0-9]+$';
  IF v_mala IS NOT NULL THEN
    RAISE EXCEPTION 'expense_sheet_conteo: la hoja % trae piezas que no son un conteo (%)', p_numero, v_mala
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(e.value::numeric * regexp_replace(e.key, 'm$', '')::numeric), 0) + coalesce(p_morralla, 0)
    INTO v_suma FROM jsonb_each_text(p_conteo) e;
  IF abs(v_suma - p_cajon) > 0.005 THEN
    RAISE EXCEPTION 'expense_sheet_conteo: el conteo de la hoja % suma % y del cajón salen %', p_numero, v_suma, p_cajon
      USING ERRCODE = 'check_violation';
  END IF;
END $fn$;`;

const TRANSICION = `
CREATE OR REPLACE FUNCTION finance.expense_sheets_transicion() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  c_pago CONSTANT text[] := ARRAY['folio','updated_at','updated_by','estado','medio','pagada_por','pagada_at',
    'caos_device','caos_external_id','caos_total','cajon','conteo','conteo_morralla','conteo_por','conteo_at'];
  c_conteo CONSTANT text[] := ARRAY['folio','updated_at','updated_by','conteo','conteo_morralla','conteo_por','conteo_at'];
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
    IF (to_jsonb(NEW) - c_pago) IS DISTINCT FROM (to_jsonb(OLD) - c_pago) THEN
      RAISE EXCEPTION 'expense_sheet_resuelta: al pagar la hoja % sólo se escribe su pago', OLD.numero
        USING ERRCODE = 'check_violation';
    END IF;
    -- Edgar, 2026-10-30: «cuando sea de cajón que se haga un arqueo».
    IF NEW.medio = 'cajon' THEN
      PERFORM finance.expense_sheet_revisar_conteo(OLD.numero, NEW.conteo, NEW.conteo_morralla, NEW.cajon);
    END IF;
  -- Pagada con el cajón antes de exigir el conteo (HG-1): lo recibe UNA vez, y sólo eso cambia.
  ELSIF OLD.estado = 'pagada' AND NEW.estado = 'pagada' AND OLD.medio = 'cajon' AND OLD.conteo IS NULL
     AND NEW.conteo IS NOT NULL THEN
    IF (to_jsonb(NEW) - c_conteo) IS DISTINCT FROM (to_jsonb(OLD) - c_conteo) THEN
      RAISE EXCEPTION 'expense_sheet_resuelta: a la hoja % pagada sólo se le agrega su conteo', OLD.numero
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM finance.expense_sheet_revisar_conteo(OLD.numero, NEW.conteo, NEW.conteo_morralla, NEW.cajon);
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
    ALTER TABLE finance.expense_sheets ADD COLUMN IF NOT EXISTS conteo_por uuid;
    ALTER TABLE finance.expense_sheets ADD COLUMN IF NOT EXISTS conteo_at timestamptz;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_sheet_conteo_morralla') THEN
        ALTER TABLE finance.expense_sheets ADD CONSTRAINT expense_sheet_conteo_morralla
          CHECK (conteo_morralla IS NULL OR (conteo_morralla >= 0 AND conteo_morralla < 0.5));
      END IF;
    END $$;
    COMMENT ON COLUMN finance.expense_sheets.conteo IS '[CGA-A.65] Lo que salió del cajón al pagar, contado: {clave de DENOMINACIONES_MXN: piezas}. Obligatorio con medio = cajon.';
    COMMENT ON COLUMN finance.expense_sheets.conteo_morralla IS '[CGA-A.65] Lo de menos de 50¢ del conteo del cajón.';
    COMMENT ON COLUMN finance.expense_sheets.conteo_por IS '[CGA-A.65] Quién registró el conteo del cajón (al pagar, o después si se pagó antes de exigirlo).';
    COMMENT ON COLUMN finance.expense_sheets.conteo_at IS '[CGA-A.65] Cuándo se registró el conteo; después de pagada_at = se trajo después.';
  `);
  await knex.raw(REVISAR);
  await knex.raw(TRANSICION);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la transición como la dejó `20261030133058`, sin la función ni las columnas. */
exports.down = async function down(knex) {
  if (!(await hayHojas(knex))) return;
  await anterior.up(knex);
  await knex.raw(`
    ALTER TABLE finance.expense_sheets DROP CONSTRAINT IF EXISTS expense_sheet_conteo_morralla;
    DROP FUNCTION IF EXISTS finance.expense_sheet_revisar_conteo(int, jsonb, numeric, numeric);
    ALTER TABLE finance.expense_sheets DROP COLUMN IF EXISTS conteo_at;
    ALTER TABLE finance.expense_sheets DROP COLUMN IF EXISTS conteo_por;
    ALTER TABLE finance.expense_sheets DROP COLUMN IF EXISTS conteo_morralla;
    ALTER TABLE finance.expense_sheets DROP COLUMN IF EXISTS conteo;
  `);
};
