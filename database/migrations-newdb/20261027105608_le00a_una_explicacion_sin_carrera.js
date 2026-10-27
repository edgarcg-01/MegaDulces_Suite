'use strict';
/**
 * `[LE.0.0a]` `[LE.0.0c]` — La regla B4 de `[LE.0.0]` (**cada peso, una explicación**) sin carrera
 * entre transacciones, y también cuando el libro explica un movimiento por UPDATE.
 *
 * ── Los defectos, encontrados en la revisión «como banco» del 2026-10-27 ────────────────────
 *  a) CARRERA. `20261027101810` revisa con un `EXISTS` si el libro ya explica el depósito. En lectura
 *     confirmada, una atribución automática y una explicación del libro que se escriben A LA VEZ no
 *     se ven entre sí (ninguna está confirmada) y las DOS se guardan: la doble explicación vuelve.
 *     Ya existía el candado correcto: `caos_link_no_excede()` (`[CGA-A.50]`) y la custodia toman
 *     `pg_advisory_xact_lock(hashtextextended(tenant|device|external_id, 50))` — uno por movimiento
 *     de CAOS —, pero ni el trigger de la atribución ni el de la captura `origen_tipo='caos'` lo
 *     tomaban. Esta migración hace que los TRES caminos que explican un movimiento tomen el MISMO
 *     candado: quien llega segundo espera, y su siguiente sentencia ya ve lo que confirmó el primero.
 *  c) SÓLO INSERT. El trigger de `cash_ledger` escuchaba sólo `INSERT`: una fila que pasa a
 *     `origen_tipo='caos'`, cambia de `origen_ref` o se reactiva por UPDATE no retiraba la
 *     atribución. El de `caos_cash_links` no escuchaba un cambio de movimiento o de captura.
 *
 *  b) (descartado, con evidencia) Se sospechó que sin `app.tenant_id` la función leería cero filas
 *     por RLS y dejaría pasar la doble en silencio. No ocurre: las tres tablas tienen la MISMA
 *     política `tenant_isolation` con `USING` y `WITH CHECK` sobre `current_tenant_id()`
 *     (`20261007330000`, `20260925170000`, `20260918150000`). Quien puede insertar la atribución
 *     tiene fijado el tenant de esa fila, y con él ve las filas del libro; un rol que no pasa por
 *     RLS las ve todas. No se agrega código para un caso que no existe.
 *
 * ── Lo que NO cubre, declarado ──────────────────────────────────────────────────────────────
 *  · `caos_atrib_cobro_no_excede` (`20261020110022`) suma por COBRO sin candado: dos atribuciones
 *    concurrentes al mismo cobro podrían pasar. Sólo escribe ahí `CG.58`, una corrida por hora y
 *    ahora apagado por default (`[LE.0.0]`); se retira entero en `[LE.7.3]`.
 *  · Una transacción que toma varios de estos candados en otro orden que el cron de `CG.58` puede
 *    chocar con él: Postgres lo detecta (`40P01`) y revierte a uno de los dos. Con `CG.58` apagado no
 *    hay segundo escritor masivo.
 *
 * Prueba: `database/tests/test-newdb-caja-una-explicacion.js` §7 (dos conexiones, en los cuatro
 * órdenes) y §6 (UPDATE). Idempotente: sólo `CREATE OR REPLACE` y triggers recreados.
 *
 * @param { import("knex").Knex } knex
 */

/** El candado de `[CGA-A.50]`: el MISMO texto y la misma semilla, o no serializa nada. */
const CANDADO = (device, ext) =>
  `PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || '|' || ${device} || '|' || ${ext}::text, 50));`;

const noDobla = (conCandado) => `
  CREATE OR REPLACE FUNCTION finance.caos_atribucion_no_dobla() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    IF NEW.deleted_at IS NULL THEN
      ${conCandado ? CANDADO('NEW.caos_device', 'NEW.caos_external_id') : ''}
      IF finance.caos_deposito_en_libro(NEW.tenant_id, NEW.caos_device, NEW.caos_external_id) THEN
        RAISE EXCEPTION 'CAOS_ATRIBUCION_DEPOSITO_EN_LIBRO'
          USING ERRCODE = '23514', CONSTRAINT = 'caos_atribucion_deposito_en_libro',
                DETAIL = format('el depósito %s|%s ya lo explica el libro de Caja General', NEW.caos_device, NEW.caos_external_id);
      END IF;
    END IF;
    RETURN NEW;
  END $fn$`;

const retira = (conCandado) => `
  CREATE OR REPLACE FUNCTION finance.caos_libro_retira_atribucion() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  DECLARE v_device text; v_ext bigint;
  BEGIN
    IF TG_TABLE_NAME = 'caos_cash_links' THEN
      IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
      v_device := NEW.caos_device; v_ext := NEW.caos_external_id;
    ELSE
      IF NEW.origen_tipo IS DISTINCT FROM 'caos' OR NEW.deleted_at IS NOT NULL OR NEW.estado = 'cancelado'
         OR position('|' in coalesce(NEW.origen_ref, '')) = 0 THEN RETURN NEW; END IF;
      v_device := split_part(NEW.origen_ref, '|', 1);
      BEGIN v_ext := split_part(NEW.origen_ref, '|', 2)::bigint;
      EXCEPTION WHEN others THEN RETURN NEW; END;
    END IF;
    ${conCandado ? CANDADO('v_device', 'v_ext') : ''}
    UPDATE finance.caos_ingreso_atribucion a
       SET deleted_at = now(), updated_at = now()
     WHERE a.tenant_id = NEW.tenant_id AND a.caos_device = v_device
       AND a.caos_external_id = v_ext AND a.deleted_at IS NULL;
    RETURN NEW;
  END $fn$`;

const triggers = async (knex, { link, libro }) => {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_retira_atribucion ON finance.caos_cash_links`);
  await knex.raw(`CREATE TRIGGER trg_caos_link_retira_atribucion
    AFTER INSERT OR UPDATE OF ${link} ON finance.caos_cash_links
    FOR EACH ROW EXECUTE FUNCTION finance.caos_libro_retira_atribucion()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_caos_retira_atribucion ON finance.cash_ledger`);
  await knex.raw(`CREATE TRIGGER trg_cash_ledger_caos_retira_atribucion
    AFTER ${libro} ON finance.cash_ledger
    FOR EACH ROW EXECUTE FUNCTION finance.caos_libro_retira_atribucion()`);
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(`SELECT
      to_regprocedure('finance.caos_atribucion_no_dobla()') AS a,
      to_regprocedure('finance.caos_libro_retira_atribucion()') AS b`);
  if (!rows[0].a || !rows[0].b) {
    throw new Error('[LE.0.0a] falta 20261027101810 (LE.0.0): esta migración corrige sus triggers, se aplica después.');
  }
  await knex.raw(noDobla(true));
  await knex.raw(retira(true));
  await triggers(knex, {
    link: 'deleted_at, caos_device, caos_external_id, cash_ledger_id',
    libro: 'INSERT OR UPDATE OF origen_tipo, origen_ref, estado, deleted_at',
  });
  await knex.raw(`COMMENT ON FUNCTION finance.caos_atribucion_no_dobla() IS
    '[LE.0.0a] B4: un depósito que el libro explica no admite reparto automático. Toma el candado por movimiento de CAOS (semilla 50, el de CGA-A.50) antes de mirar.'`);
};

/** Vuelve EXACTAMENTE al estado de `20261027101810`: sin candado y con los triggers de entonces. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(noDobla(false));
  await knex.raw(retira(false));
  await triggers(knex, { link: 'deleted_at', libro: 'INSERT' });
  await knex.raw(`COMMENT ON FUNCTION finance.caos_atribucion_no_dobla() IS NULL`);
};
