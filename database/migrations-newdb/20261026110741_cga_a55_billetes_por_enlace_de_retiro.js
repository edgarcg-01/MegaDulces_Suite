'use strict';
/**
 * `[CGA-A.55]` — Cada pedazo de un retiro de CAOS dice QUÉ BILLETES se entregaron y qué cambio
 * volvió, y ningún gasto puede entregar un billete que el retiro no tenía.
 *
 * Edgar, 2026-10-26: *«un egreso de CAOS de 100,000 se puede vincular a 4 movimientos de caja, pero
 * debe conciliar los billetes: ese movimiento tenía 100, los 4 movimientos usaron 80, deberían
 * existir 20 en caja con cierta denominación + el fondo»*.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-26) ────────────────────────────────────────
 *  · `analytics.caos_cash_denominations` trae los billetes de cada retiro: los contó la MÁQUINA.
 *  · `finance.cash_ledger_denominations.flujo` ya separa lo entregado (`recibido`, 334 gastos) del
 *    cambio que regresa (`devuelto`, 1 gasto). Pero el billete es del GASTO, no del enlace: con un
 *    gasto pagado con dos retiros no se sabe qué billete salió de cuál.
 *  · Hoy la pantalla COPIA los billetes del retiro al gasto: 24 de 30 enlaces «idénticos».
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `finance.caos_cash_links` gana `billetes` (lo que se tomó de ESE retiro, por `denom_key`) y
 *  `cambio` (lo que regresó a la custodia). Un trigger exige, cuando vienen:
 *   1. que sumen: valor(billetes) − valor(cambio) = monto_enlazado;
 *   2. que ningún billete falte: por cada denominación, lo que el retiro trajo (máquina) + el cambio
 *      que ya regresó − lo entregado en TODOS los enlaces vivos ≥ 0.
 *  Lo que queda por denominación es lo que tiene que aparecer en el cajón o volver a CAOS
 *  (`caja-custodia.engine.ts#remanenteDeRetiro`).
 *
 * ⚠️ Columnas NULLABLES y sin backfill: los 30 enlaces viejos no dicen qué billetes salieron, y
 *    rellenarlos con los del retiro sería repetir la copia que esto viene a quitar.
 * ⚠️ Toma el MISMO candado de aviso que `finance.caos_link_no_excede()` (re-entrante en la misma
 *    transacción): dos capturas sobre el mismo retiro no pueden gastar el mismo billete.
 *
 * Idempotente. ⛔ Ni un `?` en el SQL.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const c of ['billetes', 'cambio']) {
    if (!(await knex.schema.withSchema('finance').hasColumn('caos_cash_links', c))) {
      await knex.raw(`ALTER TABLE finance.caos_cash_links ADD COLUMN ${c} jsonb`);
    }
  }
  await knex.raw(`COMMENT ON COLUMN finance.caos_cash_links.billetes IS
    '[CGA-A.55] Billetes tomados de ESTE retiro para este movimiento, {denom_key: piezas}. NULL = no se declaró (enlaces anteriores al 2026-10-26).'`);
  await knex.raw(`COMMENT ON COLUMN finance.caos_cash_links.cambio IS
    '[CGA-A.55] Cambio que regresó a la custodia del retiro, {denom_key: piezas} (puede traer monedas).'`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_denom_valor(k text) RETURNS numeric
    LANGUAGE sql IMMUTABLE AS $fn$
      SELECT CASE WHEN k ~ '^[0-9]+(\\.[0-9]+)?m?$' THEN replace(k, 'm', '')::numeric END
    $fn$`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_link_billetes() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      v_mov    uuid;
      v_valor  numeric;
      r        record;
    BEGIN
      IF NEW.deleted_at IS NOT NULL OR (NEW.billetes IS NULL AND NEW.cambio IS NULL) THEN RETURN NEW; END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(
        NEW.tenant_id::text || '|' || NEW.caos_device || '|' || NEW.caos_external_id::text, 50));

      -- Forma: un objeto {llave: piezas enteras positivas} con llaves del catálogo.
      FOR r IN SELECT 'billetes' AS campo, e.key, e.value FROM jsonb_each(coalesce(NEW.billetes, '{}'::jsonb)) e
               UNION ALL SELECT 'cambio', e.key, e.value FROM jsonb_each(coalesce(NEW.cambio, '{}'::jsonb)) e LOOP
        IF finance.caos_denom_valor(r.key) IS NULL OR jsonb_typeof(r.value) <> 'number'
           OR (r.value)::text !~ '^[0-9]+$' OR (r.value)::text::int <= 0 THEN
          RAISE EXCEPTION 'CAOS_LINK_BILLETES_FORMA' USING ERRCODE = '23514', CONSTRAINT = 'caos_link_billetes_forma',
            DETAIL = format('%s: %s = %s', r.campo, r.key, r.value);
        END IF;
      END LOOP;

      -- 1. Que sumen el monto del enlace.
      SELECT coalesce((SELECT sum(finance.caos_denom_valor(e.key) * (e.value)::text::int) FROM jsonb_each(coalesce(NEW.billetes, '{}'::jsonb)) e), 0)
           - coalesce((SELECT sum(finance.caos_denom_valor(e.key) * (e.value)::text::int) FROM jsonb_each(coalesce(NEW.cambio, '{}'::jsonb)) e), 0)
        INTO v_valor;
      IF abs(v_valor - abs(NEW.monto_enlazado)) > 0.005 THEN
        RAISE EXCEPTION 'CAOS_LINK_BILLETES_NO_SUMAN' USING ERRCODE = '23514', CONSTRAINT = 'caos_link_billetes_no_suman',
          DETAIL = format('billetes − cambio = %s, el enlace dice %s', v_valor, abs(NEW.monto_enlazado));
      END IF;

      -- 2. Que ningún billete falte, contando TODOS los enlaces vivos del retiro (y éste).
      SELECT m.id INTO v_mov FROM analytics.caos_cash_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.device = NEW.caos_device AND m.external_id = NEW.caos_external_id;
      FOR r IN
        WITH enl AS (
          SELECT k.billetes, k.cambio FROM finance.caos_cash_links k
           WHERE k.tenant_id = NEW.tenant_id AND k.caos_device = NEW.caos_device
             AND k.caos_external_id = NEW.caos_external_id AND k.deleted_at IS NULL AND k.id <> NEW.id
          UNION ALL SELECT NEW.billetes, NEW.cambio
        ), mov AS (
          SELECT e.key, sum((e.value)::text::int) AS n FROM enl, jsonb_each(coalesce(enl.billetes, '{}'::jsonb)) e GROUP BY 1
        ), vuelve AS (
          SELECT e.key, sum((e.value)::text::int) AS n FROM enl, jsonb_each(coalesce(enl.cambio, '{}'::jsonb)) e GROUP BY 1
        )
        SELECT mov.key,
               coalesce((SELECT sum(d.quantity) FROM analytics.caos_cash_denominations d
                          WHERE d.movement_id = v_mov AND d.pieza_tipo = 'B' AND mov.key !~ 'm$'
                            AND d.denom = finance.caos_denom_valor(mov.key)
                            AND mov.key IN ('1000','500','200','100','50','20')), 0) AS trajo,
               coalesce(vuelve.n, 0) AS regreso, mov.n AS entregado
          FROM mov LEFT JOIN vuelve USING (key)
      LOOP
        IF r.trajo + r.regreso - r.entregado < 0 THEN
          RAISE EXCEPTION 'CAOS_LINK_BILLETES_INSUFICIENTES' USING ERRCODE = '23514', CONSTRAINT = 'caos_link_billetes_insuficientes',
            DETAIL = format('$%s: el retiro trajo %s, regresaron %s de cambio, y se entregan %s',
                            r.key, r.trajo, r.regreso, r.entregado);
        END IF;
      END LOOP;
      RETURN NEW;
    END $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_billetes ON finance.caos_cash_links`);
  await knex.raw(`CREATE TRIGGER trg_caos_link_billetes
    BEFORE INSERT OR UPDATE OF billetes, cambio, monto_enlazado, deleted_at
    ON finance.caos_cash_links FOR EACH ROW EXECUTE FUNCTION finance.caos_link_billetes()`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_billetes ON finance.caos_cash_links`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_link_billetes()`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_denom_valor(text)`);
  await knex.raw(`ALTER TABLE finance.caos_cash_links DROP COLUMN IF EXISTS cambio`);
  await knex.raw(`ALTER TABLE finance.caos_cash_links DROP COLUMN IF EXISTS billetes`);
};
