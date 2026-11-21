'use strict';
/**
 * `[PQ.3.2]` — Calendario de compras: las REGLAS DE REVISIÓN por proveedor y la MARCA del día.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §10 (DC17–DC21) y §3 (DC14).
 * Sustituye a la hoja «2026» del Excel de Compras: ahí cada proveedor tenía un color por día; aquí
 * tiene una o varias reglas que dicen CUÁNDO se le revisa, DÓNDE y QUIÉN.
 *
 *   · `commercial.purchase_review_rules`: proveedor × alcance × patrón × quién revisa.
 *       - alcance: corporativo (todas las sucursales) · zona (las de una zona de compra) · sucursal.
 *       - patrón: días de la semana (ISO 1–7) · días del mes (1–31 y/o «el último») · cada N días.
 *       - si un día del mes cae en fin de semana: al viernes (default, DC19) o al lunes.
 *       - un proveedor puede tener varias reglas, UNA por alcance (Francisco: «el mismo proveedor
 *         pasa el martes a Canindo, sólo Canindo lo revisa»).
 *   · `commercial.purchase_review_marks`: lo que quien revisa dijo de UNA fecha de una regla, cuando
 *     Kepler no lo dice solo: «se pidió fuera de Kepler» u «hoy no se pide» con motivo de lista
 *     (DC14) y, si se pospone, la nueva fecha. Lo no marcado amanece rezagado: no hay cierre de día.
 *
 * Datos PROPIOS de la Suite (regla 1: nada se copia de Kepler). La clave del proveedor es la de
 * Kepler, la misma de la vista `commercial.v_purchase_calendar_proposal` (PQ.3.1): 24 claves vivas en
 * Kepler sólo tienen ficha BORRADA en `catalog.suppliers`, así que un FK a la ficha las dejaría fuera.
 * La zona es el `zona_code` de `analytics.v_branch_zone` (LP · ZAM · MOR, medido 2026-11-20); la
 * sucursal, la clave de Kepler ('00'–'08'). Ninguna de las dos es tabla: las valida el dominio.
 *
 * ⛔ No alimenta al motor de sugerido hasta PQ.6 (DC3): por eso NO es `catalog.suppliers.cadence_days_override`.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-20) ───────────────────
 *  · 0 ciclos capturados a mano en la Suite; la hoja 2026 sigue siendo la brújula (39 consultas a
 *    la agenda PQ.4 en 3 semanas).
 *  · 159 de 329 proveedores reciben en más de una plaza → la regla es por alcance, no por proveedor.
 *  · 16 pares (proveedor, sucursal) con día fijo; su OC cae ese día en el 84 % (143 de 171).
 *
 * RLS forzado por tenant. `app_runtime`: SELECT/INSERT/UPDATE (una regla se da de baja con
 * `deleted_at`, nunca con DELETE; una marca se corrige, no se borra). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = ['purchase_review_marks', 'purchase_review_rules'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS commercial`);

  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_review_rules'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_review_rules (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        supplier_code        text NOT NULL,
        scope                text NOT NULL,
        zone_code            text,
        branch_code          text,
        pattern              text NOT NULL,
        weekdays             smallint[],
        month_days           smallint[],
        month_last_day       boolean NOT NULL DEFAULT false,
        every_n_days         smallint,
        weekend_shift        text NOT NULL DEFAULT 'friday',
        reviewer_user_id     uuid,
        out_of_cycle_until   date,
        out_of_cycle_reason  text,
        note                 text,
        created_by           text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           text,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        deleted_by           text,
        deleted_at           timestamptz,
        CONSTRAINT purchase_review_rules_tenant_id_key UNIQUE (tenant_id, id),
        CONSTRAINT purchase_review_rules_supplier_chk CHECK (btrim(supplier_code) <> ''),
        CONSTRAINT purchase_review_rules_scope_chk CHECK (
             (scope = 'corporate' AND zone_code IS NULL     AND branch_code IS NULL)
          OR (scope = 'zone'      AND zone_code IS NOT NULL AND branch_code IS NULL)
          OR (scope = 'branch'    AND zone_code IS NULL     AND branch_code IS NOT NULL)),
        -- ⚠️ Un CHECK que da NULL DEJA PASAR la fila: «cardinality(NULL) > 0» o «1 <= ALL('{1,NULL}')»
        -- son NULL, no falso. Sin el COALESCE de afuera, una regla «días de la semana» SIN días
        -- se guardaba. La prueba lo intenta a propósito (test-newdb-pq3-2-reglas-revision.js).
        CONSTRAINT purchase_review_rules_pattern_chk CHECK (COALESCE(
             (pattern = 'weekdays'
                AND weekdays IS NOT NULL AND cardinality(weekdays) > 0
                AND 1 <= ALL (weekdays) AND 7 >= ALL (weekdays)
                AND month_days IS NULL AND NOT month_last_day AND every_n_days IS NULL)
          OR (pattern = 'month_days'
                AND (COALESCE(cardinality(month_days), 0) > 0 OR month_last_day)
                AND (month_days IS NULL OR (1 <= ALL (month_days) AND 31 >= ALL (month_days)))
                AND weekdays IS NULL AND every_n_days IS NULL)
          OR (pattern = 'every_n_days'
                AND every_n_days IS NOT NULL AND every_n_days BETWEEN 1 AND 365
                AND weekdays IS NULL AND month_days IS NULL AND NOT month_last_day),
          false)),
        CONSTRAINT purchase_review_rules_weekend_chk CHECK (weekend_shift IN ('friday', 'monday')),
        CONSTRAINT purchase_review_rules_out_of_cycle_chk CHECK (
          (out_of_cycle_until IS NULL) = (out_of_cycle_reason IS NULL)
          AND (out_of_cycle_reason IS NULL OR btrim(out_of_cycle_reason) <> '')),
        CONSTRAINT purchase_review_rules_deleted_chk CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
      )`);
  }
  // Una regla viva por proveedor y alcance: dos reglas del mismo alcance se contradirían.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_review_rules_alcance
      ON commercial.purchase_review_rules
         (tenant_id, supplier_code, scope, COALESCE(zone_code, ''), COALESCE(branch_code, ''))
      WHERE deleted_at IS NULL`);
  // Quien revisa una sucursal pide «sus» reglas: por sucursal y por zona.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_purchase_review_rules_branch
      ON commercial.purchase_review_rules (tenant_id, branch_code) WHERE deleted_at IS NULL`);

  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_review_marks'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_review_marks (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        rule_id        uuid NOT NULL,
        review_date    date NOT NULL,
        outcome        text NOT NULL,
        skip_reason    text,
        postponed_to   date,
        note           text,
        created_by     text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     text,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_purchase_review_marks_rule FOREIGN KEY (tenant_id, rule_id)
          REFERENCES commercial.purchase_review_rules (tenant_id, id) ON DELETE RESTRICT,
        CONSTRAINT purchase_review_marks_dia_key UNIQUE (tenant_id, rule_id, review_date),
        CONSTRAINT purchase_review_marks_outcome_chk CHECK (outcome IN ('ordered_outside_kepler', 'skipped')),
        CONSTRAINT purchase_review_marks_reason_chk CHECK (
          skip_reason IS NULL
          OR skip_reason IN ('order_exists', 'in_quotation', 'blocked', 'not_needed', 'import', 'other')),
        CONSTRAINT purchase_review_marks_coherence_chk CHECK (
             (outcome = 'skipped' AND skip_reason IS NOT NULL)
          OR (outcome = 'ordered_outside_kepler' AND skip_reason IS NULL AND postponed_to IS NULL)),
        CONSTRAINT purchase_review_marks_other_chk CHECK (
          skip_reason IS DISTINCT FROM 'other' OR btrim(COALESCE(note, '')) <> ''),
        CONSTRAINT purchase_review_marks_postponed_chk CHECK (postponed_to IS NULL OR postponed_to > review_date)
      )`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_purchase_review_marks_fecha
                    ON commercial.purchase_review_marks (tenant_id, review_date)`);

  for (const t of TABLAS) {
    await knex.raw(`ALTER TABLE commercial.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'commercial' AND tablename = '${t}' AND policyname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON commercial.${t}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
          GRANT SELECT, INSERT, UPDATE ON commercial.${t} TO app_runtime;
          -- Los privilegios POR DEFECTO del esquema commercial le dan a app_runtime también DELETE
          -- (arwd, medido en la base local el 2026-11-20): sin este REVOKE, «nunca DELETE» sería una
          -- intención. Una regla se da de baja con UPDATE y una marca se corrige, no se borra.
          REVOKE DELETE, TRUNCATE ON commercial.${t} FROM app_runtime;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
          GRANT SELECT ON commercial.${t} TO dev_ro;
        END IF;
      END $$`);
  }
  await knex.raw(`COMMENT ON TABLE commercial.purchase_review_rules IS
    '[PQ.3.2] Calendario de compras: cuándo, dónde y quién revisa a cada proveedor (anexo C §10). Dato propio; clave de proveedor de Kepler.'`);
  await knex.raw(`COMMENT ON TABLE commercial.purchase_review_marks IS
    '[PQ.3.2] Lo que quien revisa dijo de una fecha de una regla cuando Kepler no lo dice: se pidió fuera de Kepler, u hoy no se pide con motivo (DC14).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.purchase_review_marks`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.purchase_review_rules`);
};
