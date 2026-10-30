'use strict';
/**
 * `[CGA-A.65]` — La hoja de zona no se podía CERRAR ni PAGAR: dos defectos de sus triggers.
 *
 * 1. `finance.expense_sheets_cuadre()` es la función de DOS triggers diferidos (`expense_sheets` y
 *    `expense_sheet_lines`) y leía `CASE … THEN NEW.id ELSE NEW.sheet_id END`. PL/pgSQL resuelve
 *    `NEW.sheet_id` contra el registro de la tabla que disparó aunque esa rama no se tome: cuando
 *    dispara `expense_sheets` (sin `sheet_id`) el COMMIT revienta con «record "new" has no field
 *    "sheet_id"». Se lee la llave como dato, con `to_jsonb(NEW)` (el mismo arreglo de `[CGS.59]`).
 * 2. `finance.expense_sheets_transicion()` comprueba que al pagar «sólo se escribe el pago»
 *    comparando `to_jsonb(NEW)` contra `to_jsonb(OLD)`. Pero `folio` es `GENERATED … STORED` y en un
 *    trigger BEFORE la fila NEW todavía no lo trae calculado (es NULL) mientras OLD sí: la
 *    comparación siempre difiere y TODO pago se rechaza con «expense_sheet_resuelta». `folio` se
 *    deriva de `numero`, que ya está vigilado arriba: se saca de las dos comparaciones.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · Prod, 2026-10-30 13:29: `POST /api/finance/hoja-gastos/morelia/cerrar` → 500 con el error 1; la
 *    transacción se deshizo entera (`expense_sheets` y `expense_sheet_lines`: 0 filas).
 *  · `database/tests/test-newdb-hoja-gastos.js` contra una base local: el error 1 en su primer caso
 *    (la prueba existía y nunca corrió en verde); con sólo el 1 arreglado, el pago da el error 2.
 *
 * Idempotente (CREATE OR REPLACE; sin las tablas no hace nada).
 *
 * @param { import("knex").Knex } knex
 */

const cuadre = (lectura) => `
CREATE OR REPLACE FUNCTION finance.expense_sheets_cuadre() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_total numeric; v_n integer; v_suma numeric; v_cuenta integer;
BEGIN
  ${lectura}
  SELECT s.total, s.renglones INTO v_total, v_n FROM finance.expense_sheets s WHERE s.id = v_id;
  SELECT coalesce(sum(l.importe), 0), count(*) INTO v_suma, v_cuenta FROM finance.expense_sheet_lines l WHERE l.sheet_id = v_id;
  IF v_total IS DISTINCT FROM v_suma OR v_n IS DISTINCT FROM v_cuenta THEN
    RAISE EXCEPTION 'expense_sheet_descuadre: la hoja dice % en % renglones y sus renglones suman % en %', v_total, v_n, v_suma, v_cuenta
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;`;

const LEE_BIEN = `v_id := CASE WHEN TG_TABLE_NAME = 'expense_sheets' THEN (to_jsonb(NEW)->>'id')::uuid
                ELSE (to_jsonb(NEW)->>'sheet_id')::uuid END;`;
const LEE_ANTES = `v_id := CASE WHEN TG_TABLE_NAME = 'expense_sheets' THEN NEW.id ELSE NEW.sheet_id END;`;

/** `fuera` = la columna generada que se saca de las comparaciones ('' = como estaba). */
const transicion = (fuera) => `
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
    IF (to_jsonb(NEW)${fuera} - 'updated_at' - 'updated_by' - 'estado' - 'medio' - 'pagada_por' - 'pagada_at'
          - 'caos_device' - 'caos_external_id' - 'caos_total' - 'cajon')
       IS DISTINCT FROM (to_jsonb(OLD)${fuera} - 'updated_at' - 'updated_by' - 'estado' - 'medio' - 'pagada_por' - 'pagada_at'
          - 'caos_device' - 'caos_external_id' - 'caos_total' - 'cajon') THEN
      RAISE EXCEPTION 'expense_sheet_resuelta: al pagar la hoja % sólo se escribe su pago', OLD.numero
        USING ERRCODE = 'check_violation';
    END IF;
  -- Resuelta (aprobada, rechazada, cancelada o pagada) ya no se toca: ni el estado ni quién firmó ni el motivo.
  ELSIF OLD.estado <> 'cerrada'
     AND (to_jsonb(NEW)${fuera} - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD)${fuera} - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'expense_sheet_resuelta: la hoja % ya está %', OLD.numero, OLD.estado
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;`;

async function hayHojas(knex) {
  const r = await knex.raw(`SELECT to_regclass('finance.expense_sheets') IS NOT NULL AND to_regclass('finance.expense_sheet_lines') IS NOT NULL AS t`);
  return r.rows[0].t === true;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await hayHojas(knex))) return;
  await knex.raw(cuadre(LEE_BIEN));
  await knex.raw(transicion(` - 'folio'`));
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos funciones vuelven a su texto anterior (el que fallaba). */
exports.down = async function down(knex) {
  if (!(await hayHojas(knex))) return;
  await knex.raw(cuadre(LEE_ANTES));
  await knex.raw(transicion(''));
};
