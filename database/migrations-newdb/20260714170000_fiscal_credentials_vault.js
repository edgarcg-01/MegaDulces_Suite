/**
 * FISCAL.2 — Bóveda de credenciales SAT (e.firma + CIEC).
 *
 * Prerrequisito del doc SAT "Descarga Masiva": e.firma vigente. Guarda el cert
 * (.cer, público → tal cual) y CIFRA la llave (.key), su contraseña y la CIEC
 * con AES-256-GCM. La master key vive en env (FISCAL_CRYPTO_KEY), NO en la DB
 * ni en AWS KMS (deploy Railway → pgcrypto/env, decisión Edgar). El material en
 * claro solo existe en memoria del worker justo antes de firmar la petición SAT.
 *
 * RLS forzado + tenant_id + audit. 1 fila por (tenant, rfc). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);
  await knex.raw(`GRANT USAGE ON SCHEMA fiscal TO app_runtime`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('sat_credentials'))) {
    await knex.raw(`
      CREATE TABLE fiscal.sat_credentials (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        rfc            varchar(13) NOT NULL,
        razon_social   text,
        cer_der        bytea NOT NULL,               -- .cer (público, DER)
        key_enc        bytea NOT NULL,               -- .key cifrada AES-256-GCM
        key_iv         bytea NOT NULL,
        key_tag        bytea NOT NULL,
        pwd_enc        bytea NOT NULL,               -- contraseña de la .key
        pwd_iv         bytea NOT NULL,
        pwd_tag        bytea NOT NULL,
        ciec_enc       bytea,                        -- CIEC (opcional, scraping)
        ciec_iv        bytea,
        ciec_tag       bytea,
        key_algo       text NOT NULL DEFAULT 'AES-256-GCM',
        cer_valid_from date,
        cer_valid_to   date,                         -- para alertar vencimiento e.firma
        active         boolean NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now(),
        created_by     uuid,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     uuid,
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, rfc)
      )`);
    await knex.raw(`CREATE INDEX ix_sat_cred_vto ON fiscal.sat_credentials (tenant_id, cer_valid_to)`);
    await knex.raw(`ALTER TABLE fiscal.sat_credentials ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.sat_credentials FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.sat_credentials
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.sat_credentials TO app_runtime`);
  }

  // Permiso (muy sensible): gestionar la e.firma. Anchor a admin/finanzas.
  const ANCHOR = { FISCAL_CREDENCIALES_GESTIONAR: 'FINANCE_FINDINGS_GESTIONAR' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_credentials_vault] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_CREDENCIALES_GESTIONAR' WHERE permissions -> 'FISCAL_CREDENCIALES_GESTIONAR' IS NOT NULL`);
  await knex.schema.withSchema('fiscal').dropTableIfExists('sat_credentials');
};
