/**
 * FISCAL.0 + FISCAL.1 — Motor de listas SAT + validación de RFC.
 *
 * Motor genérico de "listas del SAT con quienes es riesgoso operar", cruzado
 * contra los RFCs de proveedores del tenant (analytics.expense_documents, ya
 * poblado por import-expenses-polizas.js). No depende del WS de Descarga Masiva.
 *
 *   lista = '69B'  → EFOS (CFF Art. 69-B): presuntos/definitivos/desvirtuados
 *   lista = '69'   → Art. 69: créditos firmes/cancelados/no localizados/…
 *   (extensible: cualquier lista pública futura se agrega por config, sin schema)
 *
 * Tablas GLOBALES (dato público del SAT, igual para todos los tenants, sin RLS):
 *   fiscal.sat_list_rfcs      lista negra vigente (PK lista+rfc)
 *   fiscal.sat_list_staging   landing transitorio del CSV
 *   fiscal.sat_list_versions  historial de listas procesadas (dedup por hash)
 *
 * Tablas TENANT-SCOPED (RLS forzado, patrón estándar):
 *   fiscal.sat_list_matches   proveedor del tenant que aparece en una lista
 *   fiscal.rfc_issues         RFC de proveedor con problema estructural
 *
 * Idempotente (hasTable). Backfill de permisos al final.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);
  await knex.raw(`GRANT USAGE ON SCHEMA fiscal TO app_runtime`);

  // ── 1. fiscal.sat_list_rfcs — lista negra vigente (global) ────────────────
  if (!(await knex.schema.withSchema('fiscal').hasTable('sat_list_rfcs'))) {
    await knex.raw(`
      CREATE TABLE fiscal.sat_list_rfcs (
        lista              text NOT NULL,               -- '69B' | '69' | ...
        rfc                text NOT NULL,               -- normalizado UPPER(TRIM)
        nombre             text,
        situacion          text NOT NULL,               -- vocabulario por lista
        fecha_publicacion  date,
        oficio             text,
        list_hash          text NOT NULL,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (lista, rfc)
      )`);
    await knex.raw(`CREATE INDEX ix_sat_list_rfcs_situacion ON fiscal.sat_list_rfcs (lista, situacion)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.sat_list_rfcs TO app_runtime`);
  }

  // ── 2. fiscal.sat_list_staging — landing del CSV (global, transitorio) ────
  if (!(await knex.schema.withSchema('fiscal').hasTable('sat_list_staging'))) {
    await knex.raw(`
      CREATE TABLE fiscal.sat_list_staging (
        lista              text,
        rfc                text,
        nombre             text,
        situacion          text,
        fecha_publicacion  date,
        oficio             text
      )`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.sat_list_staging TO app_runtime`);
  }

  // ── 3. fiscal.sat_list_versions — historial de listas (global) ────────────
  if (!(await knex.schema.withSchema('fiscal').hasTable('sat_list_versions'))) {
    await knex.raw(`
      CREATE TABLE fiscal.sat_list_versions (
        list_hash     text PRIMARY KEY,
        lista         text NOT NULL,
        source        text NOT NULL,                    -- url | file | manual
        total_rfcs    int  NOT NULL DEFAULT 0,
        altas         int  NOT NULL DEFAULT 0,
        cambios       int  NOT NULL DEFAULT 0,
        processed_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_sat_list_versions_lista ON fiscal.sat_list_versions (lista, processed_at DESC)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.sat_list_versions TO app_runtime`);
  }

  // ── 4. fiscal.sat_list_matches — hallazgo por tenant (RLS forzado) ────────
  if (!(await knex.schema.withSchema('fiscal').hasTable('sat_list_matches'))) {
    await knex.raw(`
      CREATE TABLE fiscal.sat_list_matches (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        lista             text NOT NULL,
        rfc               text NOT NULL,
        nombre            text,
        situacion         text NOT NULL,
        doc_count         int  NOT NULL DEFAULT 0,
        importe_total     numeric NOT NULL DEFAULT 0,
        iva_total         numeric NOT NULL DEFAULT 0,
        primera_fecha     date,
        ultima_fecha      date,
        estado            text NOT NULL DEFAULT 'nuevo',
        nota              text,
        list_hash         text,
        detectado_at      timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, lista, rfc)
      )`);
    await knex.raw(`ALTER TABLE fiscal.sat_list_matches ADD CONSTRAINT sat_list_matches_estado_check
      CHECK (estado IN ('nuevo','en_revision','confirmado','descartado'))`);
    await knex.raw(`CREATE INDEX ix_sat_list_matches_estado ON fiscal.sat_list_matches (tenant_id, lista, estado)`);
    await knex.raw(`ALTER TABLE fiscal.sat_list_matches ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.sat_list_matches FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.sat_list_matches
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.sat_list_matches TO app_runtime`);
  }

  // ── 5. fiscal.rfc_issues — RFC de proveedor con problema (RLS forzado) ────
  if (!(await knex.schema.withSchema('fiscal').hasTable('rfc_issues'))) {
    await knex.raw(`
      CREATE TABLE fiscal.rfc_issues (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        rfc               text NOT NULL,
        issue_type        text NOT NULL,                -- formato_invalido | rfc_generico
        doc_count         int  NOT NULL DEFAULT 0,
        importe_total     numeric NOT NULL DEFAULT 0,
        primera_fecha     date,
        ultima_fecha      date,
        estado            text NOT NULL DEFAULT 'nuevo',
        nota              text,
        detectado_at      timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, rfc, issue_type)
      )`);
    await knex.raw(`ALTER TABLE fiscal.rfc_issues ADD CONSTRAINT rfc_issues_estado_check
      CHECK (estado IN ('nuevo','en_revision','confirmado','descartado'))`);
    await knex.raw(`CREATE INDEX ix_rfc_issues_estado ON fiscal.rfc_issues (tenant_id, estado)`);
    await knex.raw(`ALTER TABLE fiscal.rfc_issues ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.rfc_issues FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.rfc_issues
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.rfc_issues TO app_runtime`);
  }

  // ── 6. Backfill de permisos ───────────────────────────────────────────────
  // VER ← FINANCE_EXPENSES_VER · GESTIONAR ← FINANCE_FINDINGS_GESTIONAR.
  // Idempotente (`-> 'KEY' IS NULL`, NO el operador `?`). Re-login requerido.
  const ANCHOR = {
    FISCAL_LISTAS_VER: 'FINANCE_EXPENSES_VER',
    FISCAL_LISTAS_GESTIONAR: 'FINANCE_FINDINGS_GESTIONAR',
  };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_sat_lists] up ${key} (← ${anchor}): filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of ['FISCAL_LISTAS_VER', 'FISCAL_LISTAS_GESTIONAR']) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`);
  }
  await knex.schema.withSchema('fiscal').dropTableIfExists('rfc_issues');
  await knex.schema.withSchema('fiscal').dropTableIfExists('sat_list_matches');
  await knex.schema.withSchema('fiscal').dropTableIfExists('sat_list_versions');
  await knex.schema.withSchema('fiscal').dropTableIfExists('sat_list_staging');
  await knex.schema.withSchema('fiscal').dropTableIfExists('sat_list_rfcs');
};
