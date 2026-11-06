'use strict';
/**
 * `[LE.6.19]` — **La hoja de zona se paga en UN acto, en Caja, sin aprobarla aparte** (D27 sobre D28).
 *
 * PM, 2026-11-06: *«¿por qué volver a confirmar una hoja que ya tiene todos los gastos aprobados?»* y
 * *«toda reposición que salga del cajón se hace con arqueo»*. La hoja ya no la cierra uno, la aprueba
 * otro y la paga un tercero: quien opera la caja la paga y, en la misma transacción, la cierra. Lo que
 * autoriza cada pago es su compra o su gasto aprobado por una persona (LE.2.13): lo que no la trae no
 * entra a la hoja (lo decide el servicio con `veredictoDePago`).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-06) ────────────────────────────────────────
 *  · 10 hojas, todas pagadas; cada una aprobada de 0 a 36 min después de cerrarse (cierra un
 *    superadmin, aprueba Dirección o Tesorería, paga Finanzas). 7 de 10 salieron del cajón.
 *  · Cero hojas en «cerrada» o «aprobada»: nada queda a medio camino al cambiar la regla.
 *
 * Qué hace (EXPAND: no exige nada que la API desplegada no mande):
 *  · `expense_sheet_aprobada`: «aprobada» sigue exigiendo quién y cuándo; «pagada» ya no exige una
 *    aprobación (la de un acto no la tiene). Quien aprobó y cuándo van juntos o no van.
 *  · `expense_sheets_transicion()`: además de aprobada → pagada (igual que antes), admite
 *    cerrada → pagada SIN aprobación, escribiendo sólo el pago; y en ese paso, si sale un peso del
 *    cajón —todo, o el pico que completa un retiro de CAOS— el conteo es obligatorio y suma
 *    exactamente lo que sale (la misma `expense_sheet_revisar_conteo`). El carril viejo
 *    (aprobada → pagada) conserva su regla de siempre hasta retirarlo (contract).
 *
 * Idempotente. Sin las tablas no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const anterior = require('./20261030140503_cga_a65_hoja_cajon_con_conteo.js');

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
  -- Se paga una aprobada (el carril viejo) o, desde [LE.6.19], una cerrada en el mismo acto.
  IF NEW.estado = 'pagada' AND OLD.estado IS DISTINCT FROM 'pagada' AND OLD.estado NOT IN ('aprobada', 'cerrada') THEN
    RAISE EXCEPTION 'expense_sheet_sin_aprobar: la hoja % está %; sólo una cerrada o aprobada se paga', OLD.numero, OLD.estado
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.estado IN ('aprobada', 'cerrada') AND NEW.estado = 'pagada' THEN
    -- Al pagarla sólo se escribe el pago (y su conteo): lo cerrado (y lo aprobado) no cambia.
    IF (to_jsonb(NEW) - c_pago) IS DISTINCT FROM (to_jsonb(OLD) - c_pago) THEN
      RAISE EXCEPTION 'expense_sheet_resuelta: al pagar la hoja % sólo se escribe su pago', OLD.numero
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.estado = 'cerrada' THEN
      -- [LE.6.19] PM, 2026-11-06: «toda reposición que salga del cajón se hace con arqueo».
      IF coalesce(NEW.cajon, 0) > 0 THEN
        PERFORM finance.expense_sheet_revisar_conteo(OLD.numero, NEW.conteo, NEW.conteo_morralla, NEW.cajon);
      END IF;
    ELSIF NEW.medio = 'cajon' THEN
      -- Edgar, 2026-10-30: «cuando sea de cajón que se haga un arqueo».
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
  const r = await knex.raw(`SELECT to_regclass('finance.expense_sheets') IS NOT NULL
    AND to_regprocedure('finance.expense_sheet_revisar_conteo(int, jsonb, numeric, numeric)') IS NOT NULL AS t`);
  return r.rows[0].t === true;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await hayHojas(knex))) return;
  await knex.raw(`
    ALTER TABLE finance.expense_sheets DROP CONSTRAINT IF EXISTS expense_sheet_aprobada;
    ALTER TABLE finance.expense_sheets ADD CONSTRAINT expense_sheet_aprobada CHECK (
      (estado <> 'aprobada' OR (aprobada_por IS NOT NULL AND aprobada_at IS NOT NULL))
      AND ((aprobada_por IS NULL) = (aprobada_at IS NULL)));
    COMMENT ON CONSTRAINT expense_sheet_aprobada ON finance.expense_sheets IS
      '[LE.6.19] La aprobada lleva quién y cuándo; la pagada en un acto (cerrada → pagada) no lleva aprobación (D27).';
  `);
  await knex.raw(TRANSICION);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: la transición como la dejó `20261030140503` y la regla de
 * siempre. ⚠️ Si ya hay hojas pagadas en un acto (sin aprobación), la regla vieja no se puede volver a
 * poner: el `down` lo dice y no borra ni inventa una aprobación.
 */
exports.down = async function down(knex) {
  if (!(await hayHojas(knex))) return;
  const n = (await knex.raw(`SELECT count(*)::int AS n FROM finance.expense_sheets WHERE estado = 'pagada' AND aprobada_por IS NULL`)).rows[0].n;
  if (n > 0) throw new Error(`[LE.6.19] ${n} hoja(s) se pagaron en un acto sin aprobación: la regla vieja no se puede volver a poner sin inventarla.`);
  await knex.raw(`
    ALTER TABLE finance.expense_sheets DROP CONSTRAINT IF EXISTS expense_sheet_aprobada;
    ALTER TABLE finance.expense_sheets ADD CONSTRAINT expense_sheet_aprobada
      CHECK ((estado IN ('aprobada', 'pagada')) = (aprobada_por IS NOT NULL AND aprobada_at IS NOT NULL));
  `);
  await anterior.up(knex);
};
