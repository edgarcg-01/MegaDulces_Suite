'use strict';
/**
 * `[CGA-A.50]` — Un retiro de CAOS puede pagar MUCHOS gastos, y el que se lleva una persona queda
 * a su cargo hasta que lo explica.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-23) ────────────────────────────────────────
 *  · 409 retiros de CAOS por $19.8 M desde el 27-may; enlazados a un gasto: 30 (7 % del dinero).
 *  · Los 30 enlazan UN retiro con UN gasto: `ux_caos_link_vivo` impide cualquier otra forma. Un
 *    retiro de $200,000 que paga 40 gastos no se puede registrar aunque alguien quiera.
 *  · El corte cuenta todo lo dispensado como efectivo del cajón del día. Con el retiro en bulto
 *    eso da 19-oct «falta» −$188,885 y 21-oct esperado −$221,512 / «sobra» +$245,269: el mismo
 *    dinero en la jornada equivocada (ver `caja-custodia.engine.ts`).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. Reemplaza el candado «un enlace por movimiento» por «la suma de los enlaces no pasa del
 *     movimiento» — y tampoco del monto de la captura. Lo hace un TRIGGER con candado de aviso
 *     por movimiento, porque un CHECK no puede mirar otras filas y dos capturas simultáneas
 *     sobre el mismo retiro tienen que serializarse. Un (captura, movimiento) sigue siendo único.
 *  2. `finance.caos_retiro_custodia`: a dónde fue cada retiro (`cajon` | `custodia`), a cargo de
 *     quién, y cómo se cerró (`regreso_caos` | `cajon` | `faltante`). Un regreso a CAOS se ata a
 *     su depósito y su monto ES el que contó la máquina.
 *
 * ⚠️ No recalcula ningún corte: sin filas en `caos_retiro_custodia` el esperado es idéntico.
 * ⚠️ Los enlaces existentes no se tocan; el trigger sólo valida lo que se escriba de aquí en más.
 *
 * Idempotente. ⛔ Ni un `?` en el SQL (knex lo toma como binding).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Enlaces: de «uno por movimiento» a «que la suma no pase» ─────────────────────────
  await knex.raw(`DROP INDEX IF EXISTS finance.ux_caos_link_vivo`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_caos_link_par_vivo
    ON finance.caos_cash_links (tenant_id, caos_device, caos_external_id, cash_ledger_id) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_caos_link_mov
    ON finance.caos_cash_links (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_link_no_excede() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      v_total   numeric;
      v_otros   numeric;
      v_captura numeric;
      v_en_cap  numeric;
    BEGIN
      IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;

      -- Serializa a todos los que enlazan el MISMO movimiento: sin esto dos capturas a la vez
      -- leen el mismo disponible y las dos pasan.
      PERFORM pg_advisory_xact_lock(hashtextextended(
        NEW.tenant_id::text || '|' || NEW.caos_device || '|' || NEW.caos_external_id::text, 50));

      SELECT abs(m.total) INTO v_total
        FROM analytics.caos_cash_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.device = NEW.caos_device AND m.external_id = NEW.caos_external_id;
      IF v_total IS NULL THEN
        RAISE EXCEPTION 'CAOS_LINK_SIN_MOVIMIENTO'
          USING ERRCODE = '23503', CONSTRAINT = 'caos_link_sin_movimiento', DETAIL = format('%s|%s no existe en analytics.caos_cash_movements', NEW.caos_device, NEW.caos_external_id);
      END IF;

      -- Una custodia cerrada ya explicó su último peso: un gasto que llega después se pagó con
      -- otro dinero, o el cierre estuvo mal. En los dos casos no se enlaza en silencio.
      IF to_regclass('finance.caos_retiro_custodia') IS NOT NULL AND EXISTS (
           SELECT 1 FROM finance.caos_retiro_custodia c
            WHERE c.tenant_id = NEW.tenant_id AND c.caos_device = NEW.caos_device
              AND c.caos_external_id = NEW.caos_external_id AND c.deleted_at IS NULL
              AND c.cierre_tipo IS NOT NULL) THEN
        RAISE EXCEPTION 'CAOS_LINK_CUSTODIA_CERRADA'
          USING ERRCODE = '23514', CONSTRAINT = 'caos_link_custodia_cerrada';
      END IF;

      SELECT coalesce(sum(abs(k.monto_enlazado)), 0) INTO v_otros
        FROM finance.caos_cash_links k
       WHERE k.tenant_id = NEW.tenant_id AND k.caos_device = NEW.caos_device
         AND k.caos_external_id = NEW.caos_external_id AND k.deleted_at IS NULL AND k.id <> NEW.id;
      IF v_otros + abs(NEW.monto_enlazado) > v_total + 0.005 THEN
        RAISE EXCEPTION 'CAOS_LINK_EXCEDE_MOVIMIENTO'
          USING ERRCODE = '23514', CONSTRAINT = 'caos_link_excede_movimiento',
                DETAIL = format('movimiento %s · ya enlazado %s · disponible %s · pedido %s',
                                v_total, v_otros, v_total - v_otros, abs(NEW.monto_enlazado));
      END IF;

      SELECT abs(l.monto) INTO v_captura FROM finance.cash_ledger l
       WHERE l.id = NEW.cash_ledger_id AND l.tenant_id = NEW.tenant_id;
      IF v_captura IS NULL THEN
        RAISE EXCEPTION 'CAOS_LINK_SIN_CAPTURA' USING ERRCODE = '23503', CONSTRAINT = 'caos_link_sin_captura';
      END IF;
      SELECT coalesce(sum(abs(k.monto_enlazado)), 0) INTO v_en_cap
        FROM finance.caos_cash_links k
       WHERE k.tenant_id = NEW.tenant_id AND k.cash_ledger_id = NEW.cash_ledger_id
         AND k.deleted_at IS NULL AND k.id <> NEW.id;
      IF v_en_cap + abs(NEW.monto_enlazado) > v_captura + 0.005 THEN
        RAISE EXCEPTION 'CAOS_LINK_EXCEDE_CAPTURA'
          USING ERRCODE = '23514', CONSTRAINT = 'caos_link_excede_captura',
                DETAIL = format('captura %s · ya enlazado %s · pedido %s', v_captura, v_en_cap, abs(NEW.monto_enlazado));
      END IF;
      RETURN NEW;
    END $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_no_excede ON finance.caos_cash_links`);
  await knex.raw(`CREATE TRIGGER trg_caos_link_no_excede
    BEFORE INSERT OR UPDATE OF monto_enlazado, caos_device, caos_external_id, cash_ledger_id, deleted_at
    ON finance.caos_cash_links FOR EACH ROW EXECUTE FUNCTION finance.caos_link_no_excede()`);

  // ── 2. A dónde fue cada retiro, y cómo se cerró ─────────────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('caos_retiro_custodia'))) {
    await knex.raw(`
      CREATE TABLE finance.caos_retiro_custodia (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        caos_device             text NOT NULL,
        caos_external_id        bigint NOT NULL,
        destino                 text NOT NULL,
        responsable             text,
        nota                    text,

        cierre_tipo             text,
        cierre_monto            numeric(18,2),
        cierre_dia              date,
        cierre_caos_external_id bigint,
        cierre_nota             text,
        cerrado_by              uuid,
        cerrado_by_username     text,
        cerrado_at              timestamptz,

        created_by              uuid NOT NULL,
        created_by_username     text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_by              uuid,
        updated_at              timestamptz NOT NULL DEFAULT now(),
        deleted_at              timestamptz,

        CONSTRAINT caos_cust_destino_chk CHECK (destino IN ('cajon', 'custodia')),
        CONSTRAINT caos_cust_responsable_chk CHECK (destino = 'cajon' OR btrim(coalesce(responsable, '')) <> ''),
        CONSTRAINT caos_cust_cierre_tipo_chk CHECK (cierre_tipo IS NULL OR cierre_tipo IN ('regreso_caos', 'cajon', 'faltante')),
        CONSTRAINT caos_cust_cierre_solo_custodia_chk CHECK (cierre_tipo IS NULL OR destino = 'custodia'),
        CONSTRAINT caos_cust_cierre_completo_chk CHECK (
          (cierre_tipo IS NULL AND cierre_monto IS NULL AND cierre_dia IS NULL AND cerrado_at IS NULL)
          OR (cierre_tipo IS NOT NULL AND cierre_monto IS NOT NULL AND cierre_dia IS NOT NULL AND cerrado_at IS NOT NULL)),
        CONSTRAINT caos_cust_cierre_monto_chk CHECK (cierre_monto IS NULL OR cierre_monto >= 0),
        CONSTRAINT caos_cust_regreso_con_deposito_chk CHECK (
          (cierre_tipo = 'regreso_caos') = (cierre_caos_external_id IS NOT NULL))
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_cust_retiro_vivo
      ON finance.caos_retiro_custodia (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_cust_deposito_vivo
      ON finance.caos_retiro_custodia (tenant_id, caos_device, cierre_caos_external_id)
      WHERE deleted_at IS NULL AND cierre_caos_external_id IS NOT NULL`);
    await knex.raw(`CREATE INDEX ix_caos_cust_abiertos
      ON finance.caos_retiro_custodia (tenant_id, responsable) WHERE deleted_at IS NULL AND destino = 'custodia' AND cierre_tipo IS NULL`);

    await knex.raw(`ALTER TABLE finance.caos_retiro_custodia ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.caos_retiro_custodia FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance'
                        AND tablename='caos_retiro_custodia' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.caos_retiro_custodia
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.caos_retiro_custodia TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE finance.caos_retiro_custodia IS
      '[CGA-A.50] A dónde fue cada retiro de CAOS (cajon|custodia) y cómo se cerró la custodia. Sin fila = sin clasificar (cuenta como cajón).'`);
  }

  // El retiro clasificado tiene que ser un Dispensar que exista; el regreso, un Depósito cuyo
  // monto ES el cierre (lo contó la máquina, no se teclea).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION finance.caos_custodia_valida() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE v_tipo smallint; v_total numeric;
    BEGIN
      SELECT m.type_id INTO v_tipo FROM analytics.caos_cash_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.device = NEW.caos_device AND m.external_id = NEW.caos_external_id;
      IF v_tipo IS DISTINCT FROM 4 THEN
        RAISE EXCEPTION 'CAOS_CUSTODIA_NO_ES_RETIRO' USING ERRCODE = '23514', CONSTRAINT = 'caos_custodia_no_es_retiro',
          DETAIL = format('%s|%s tipo %s', NEW.caos_device, NEW.caos_external_id, coalesce(v_tipo::text, 'inexistente'));
      END IF;
      IF NEW.cierre_tipo = 'regreso_caos' THEN
        SELECT m.type_id, abs(m.total) INTO v_tipo, v_total FROM analytics.caos_cash_movements m
         WHERE m.tenant_id = NEW.tenant_id AND m.device = NEW.caos_device AND m.external_id = NEW.cierre_caos_external_id;
        IF v_tipo IS DISTINCT FROM 0 THEN
          RAISE EXCEPTION 'CAOS_CUSTODIA_REGRESO_NO_ES_DEPOSITO' USING ERRCODE = '23514', CONSTRAINT = 'caos_custodia_regreso_no_es_deposito';
        END IF;
        IF abs(v_total - NEW.cierre_monto) > 0.005 THEN
          RAISE EXCEPTION 'CAOS_CUSTODIA_REGRESO_MONTO' USING ERRCODE = '23514', CONSTRAINT = 'caos_custodia_regreso_monto',
            DETAIL = format('el depósito trae %s y el cierre dice %s', v_total, NEW.cierre_monto);
        END IF;
      END IF;
      RETURN NEW;
    END $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_custodia_valida ON finance.caos_retiro_custodia`);
  await knex.raw(`CREATE TRIGGER trg_caos_custodia_valida
    BEFORE INSERT OR UPDATE ON finance.caos_retiro_custodia
    FOR EACH ROW EXECUTE FUNCTION finance.caos_custodia_valida()`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_custodia_valida ON finance.caos_retiro_custodia`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_custodia_valida()`);
  await knex.raw(`DROP TABLE IF EXISTS finance.caos_retiro_custodia`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_caos_link_no_excede ON finance.caos_cash_links`);
  await knex.raw(`DROP FUNCTION IF EXISTS finance.caos_link_no_excede()`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_caos_link_mov`);
  await knex.raw(`DROP INDEX IF EXISTS finance.ux_caos_link_par_vivo`);
  // ⚠️ Falla si ya hay un movimiento con dos enlaces vivos: es lo correcto, el down no puede
  // decidir cuál borrar.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_caos_link_vivo
    ON finance.caos_cash_links (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`);
};
