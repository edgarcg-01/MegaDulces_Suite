'use strict';
/**
 * `[LE.0.0]` — **Cada peso, una explicación** (Fase LE, regla de banco B4), en la BASE: un depósito
 * de CAOS que el libro de Caja General explica no puede tener además un reparto automático (`CG.58`).
 *
 * ── Lo medido antes (prod, sólo lectura, `7688376744939610156`, 2026-10-27) ─────────────────
 *  · 86 depósitos con DOS explicaciones: el libro los liga al cobro de su ruta y su día
 *    (`caos_cash_links`, o captura `origen_tipo='caos'`), y `CG.58` les reparte otros cobros.
 *  · 162 atribuciones · $1,703,230.00 · en NINGUNA el cobro coincide con el del libro.
 *  · Todos los cobros atribuidos son del 21 al 28-jul-2026: el reparto por antigüedad le colgó a
 *    depósitos de octubre los cobros más viejos de la cola. Ej. #1723 «ruta 27 261026»: en el
 *    libro, la ruta 27 del 26-oct; en `CG.58`, las rutas 21 y 22 del 28-jul.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. `finance.caos_deposito_en_libro(tenant, device, external_id)`: ¿el libro explica ese movimiento?
 *  2. Trigger en `caos_ingreso_atribucion`: una atribución VIVA sobre un depósito que el libro explica
 *     se RECHAZA (`caos_atribucion_deposito_en_libro`). Vale aunque alguien vuelva a encender el
 *     reparto o corra código viejo: por eso esta migración no depende del orden del despliegue.
 *  3. Triggers en `caos_cash_links` y `cash_ledger`: cuando una persona explica un movimiento en el
 *     libro, las atribuciones automáticas vivas de ese movimiento se dan de BAJA (lógica). La
 *     evidencia de una persona manda sobre la suposición de un reparto.
 *  4. Da de baja (lógica, `deleted_at`) las atribuciones dobles que ya existen, calculadas AL APLICAR
 *     con la misma regla, e imprime cuántas y cuánto. Cero = nada que hacer (no aborta: no repite el
 *     error de `[CGS.52]` en la base de prueba).
 *
 * ⚠️ EFECTO DE NEGOCIO, declarado: los cobros de julio que hoy aparecen «depositados» con dinero de
 *    octubre vuelven a quedar PENDIENTES; la cifra de cobrado sin depositar SUBE en ese monto. Ésa es
 *    la cifra verdadera.
 * ⚠️ Con el código viejo encendido, el reparto de la hora siguiente intentará atribuir esos depósitos
 *    y la base lo rechazará: la corrida entera se revierte y su latido dirá el error. Es lo correcto
 *    hasta que entre el código de LE.0.0 (reparto apagado).
 *
 * Idempotente. ⛔ Ni un `?` en el SQL.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⛔ Las tres tablas tienen RLS FORZADO: sin el tenant fijado, un rol que no sea superusuario
  // vería CERO filas y la baja diría «nada que hacer» sobre 162 atribuciones (GOTCHAS, RLS).
  await knex.raw(`SELECT set_config('app.tenant_id', '${TENANT}', true)`);
  const hay = async (t) => knex.schema.withSchema('finance').hasTable(t);
  if (!(await hay('caos_ingreso_atribucion')) || !(await hay('caos_cash_links')) || !(await hay('cash_ledger'))) {
    // eslint-disable-next-line no-console
    console.log('  ↷ [LE.0.0] faltan las tablas del reparto, de los enlaces o del libro: nada que hacer.');
    return;
  }

  // ── 1. ¿El libro explica este movimiento? ────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_deposito_en_libro(p_tenant uuid, p_device text, p_external_id bigint)
    RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (
               SELECT 1 FROM finance.caos_cash_links k
                 JOIN finance.cash_ledger l ON l.id = k.cash_ledger_id
                WHERE k.tenant_id = p_tenant AND k.caos_device = p_device
                  AND k.caos_external_id = p_external_id AND k.deleted_at IS NULL
                  AND l.deleted_at IS NULL AND l.estado <> 'cancelado')
          OR EXISTS (
               SELECT 1 FROM finance.cash_ledger l
                WHERE l.tenant_id = p_tenant AND l.origen_tipo = 'caos'
                  AND l.origen_ref = p_device || '|' || p_external_id::text
                  AND l.deleted_at IS NULL AND l.estado <> 'cancelado')
    $fn$`);

  // ── 2. Ninguna atribución automática sobre lo que el libro ya explica ────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_atribucion_no_dobla() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.deleted_at IS NULL
         AND finance.caos_deposito_en_libro(NEW.tenant_id, NEW.caos_device, NEW.caos_external_id) THEN
        RAISE EXCEPTION 'CAOS_ATRIBUCION_DEPOSITO_EN_LIBRO'
          USING ERRCODE = '23514', CONSTRAINT = 'caos_atribucion_deposito_en_libro',
                DETAIL = format('el depósito %s|%s ya lo explica el libro de Caja General', NEW.caos_device, NEW.caos_external_id);
      END IF;
      RETURN NEW;
    END $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_atribucion_no_dobla ON finance.caos_ingreso_atribucion`);
  await knex.raw(`CREATE TRIGGER trg_caos_atribucion_no_dobla
    BEFORE INSERT OR UPDATE OF deleted_at, caos_device, caos_external_id ON finance.caos_ingreso_atribucion
    FOR EACH ROW EXECUTE FUNCTION finance.caos_atribucion_no_dobla()`);

  // ── 3. Cuando una persona lo explica, la suposición se retira ────────────────────────────
  await knex.raw(`
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
      UPDATE finance.caos_ingreso_atribucion a
         SET deleted_at = now(), updated_at = now()
       WHERE a.tenant_id = NEW.tenant_id AND a.caos_device = v_device
         AND a.caos_external_id = v_ext AND a.deleted_at IS NULL;
      RETURN NEW;
    END $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_retira_atribucion ON finance.caos_cash_links`);
  await knex.raw(`CREATE TRIGGER trg_caos_link_retira_atribucion
    AFTER INSERT OR UPDATE OF deleted_at ON finance.caos_cash_links
    FOR EACH ROW EXECUTE FUNCTION finance.caos_libro_retira_atribucion()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_caos_retira_atribucion ON finance.cash_ledger`);
  await knex.raw(`CREATE TRIGGER trg_cash_ledger_caos_retira_atribucion
    AFTER INSERT ON finance.cash_ledger
    FOR EACH ROW EXECUTE FUNCTION finance.caos_libro_retira_atribucion()`);

  // ── 4. Las que ya existen ────────────────────────────────────────────────────────────────
  const antes = (await knex.raw(`
    SELECT count(*)::int n, coalesce(sum(a.monto), 0)::numeric(18,2) monto
      FROM finance.caos_ingreso_atribucion a
     WHERE a.deleted_at IS NULL
       AND finance.caos_deposito_en_libro(a.tenant_id, a.caos_device, a.caos_external_id)`)).rows[0];
  if (!antes.n) {
    // eslint-disable-next-line no-console
    console.log('  ↷ [LE.0.0] ninguna atribución doble: nada que dar de baja.');
    return;
  }
  const r = await knex.raw(`
    UPDATE finance.caos_ingreso_atribucion a
       SET deleted_at = now(), updated_at = now()
     WHERE a.deleted_at IS NULL
       AND finance.caos_deposito_en_libro(a.tenant_id, a.caos_device, a.caos_external_id)`);
  // eslint-disable-next-line no-console
  console.log(`  ✓ [LE.0.0] ${r.rowCount} atribuciones dobles dadas de baja · $${antes.monto} (medido el 27-oct: 162 · $1,703,230.00)`);
};

/**
 * Quita las reglas. NO revive atribuciones: devolverles la vida reconstruiría la doble explicación;
 * si hiciera falta, se revisa caso por caso con el `deleted_at` de esta migración.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cash_ledger_caos_retira_atribucion ON finance.cash_ledger`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_retira_atribucion ON finance.caos_cash_links`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_atribucion_no_dobla ON finance.caos_ingreso_atribucion`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_libro_retira_atribucion()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_atribucion_no_dobla()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_deposito_en_libro(uuid, text, bigint)`);
};
