/**
 * FE.11 — Código Agrupador del SAT (contabilidad electrónica 100% válida).
 *
 * El catálogo de cuentas XML exige `CodAgrupador` = clave del catálogo SAT
 * (c_CodigoAgrupador, Anexo 24). Kepler NO lo codifica → hasta ahora se usaba la
 * cuenta mayor como placeholder. Esta tabla persiste el mapeo
 *   cuenta_mayor → cod_agrupador SAT (+ naturaleza opcional)
 * que el contador captura/aprueba (motor decide/humano aprueba, LLM fuera).
 * `catalogoXml` la lee; las cuentas sin mapear caen al placeholder (mayor).
 *
 * RLS forzado, tenant-scoped, idempotente. NO borra nada.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('cod_agrupador_map'))) {
    await knex.raw(`
      CREATE TABLE fiscal.cod_agrupador_map (
        tenant_id     uuid NOT NULL,
        cuenta_mayor  text NOT NULL,               -- cuenta mayor de Kepler (split_part(cuenta,'-',1))
        cod_agrupador text NOT NULL,               -- clave del catálogo SAT (ej. '105.01')
        natur         char(1),                      -- override de naturaleza D|A (null = heurística por familia)
        source        text NOT NULL DEFAULT 'manual', -- 'auto' (sugerido) | 'manual' (capturado/aprobado)
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, cuenta_mayor),
        CHECK (natur IS NULL OR natur IN ('D','A'))
      )`);
    await knex.raw(`ALTER TABLE fiscal.cod_agrupador_map ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.cod_agrupador_map FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.cod_agrupador_map
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.cod_agrupador_map TO app_runtime`);
  }

  // Permiso de gestión (editar el mapeo). Anclado a FISCAL_CONTAB_VER; customer_b2b nunca.
  const ANCHOR = { FISCAL_CONTAB_GESTIONAR: 'FISCAL_CONTAB_VER' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fe11_cod_agrupador] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_CONTAB_GESTIONAR'
    WHERE permissions -> 'FISCAL_CONTAB_GESTIONAR' IS NOT NULL`);
  await knex.schema.withSchema('fiscal').dropTableIfExists('cod_agrupador_map');
};
