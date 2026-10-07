/**
 * Fix sistémico: FKs compuestas con ON DELETE SET NULL que incluyen tenant_id.
 *
 * Problema: `FOREIGN KEY (tenant_id, X) REFERENCES ... ON DELETE SET NULL`
 * intenta poner NULL en TODAS las columnas del FK al borrar el padre —
 * incluido tenant_id (NOT NULL) → "null value in column tenant_id violates
 * not-null constraint". Vivido al borrar pedidos dev (shipments) el 2026-06-15.
 *
 * Hay ~31 FKs así en commercial/logistics/trade/identity. Postgres 15+ permite
 * `ON DELETE SET NULL (columnas)` para anular SOLO las columnas indicadas.
 * Esta migración recrea cada FK afectada para que anule únicamente las columnas
 * NO-tenant, preservando tenant_id.
 *
 * Idempotente: solo procesa FKs cuyo def todavía NO tiene la lista de columnas
 * (`SET NULL (`). Re-correr es no-op.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const { rows } = await knex.raw(`
    SELECT con.oid,
           con.conname,
           con.conrelid::regclass::text AS tbl,
           pg_get_constraintdef(con.oid)  AS def,
           (SELECT string_agg(quote_ident(a.attname), ', ')
              FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
             WHERE a.attname <> 'tenant_id') AS null_cols
      FROM pg_constraint con
     WHERE con.contype = 'f'
       AND con.confdeltype = 'n'                      -- ON DELETE SET NULL
       AND array_length(con.conkey, 1) > 1            -- compuesta
       AND pg_get_constraintdef(con.oid) NOT LIKE '%SET NULL (%'  -- aún sin lista (idempotencia)
       AND EXISTS (                                   -- incluye tenant_id
         SELECT 1 FROM unnest(con.conkey) AS ck(attnum)
         JOIN pg_attribute a2 ON a2.attrelid = con.conrelid AND a2.attnum = ck.attnum
         WHERE a2.attname = 'tenant_id')
  `);

  let fixed = 0;
  for (const r of rows) {
    if (!r.null_cols) continue; // sin columnas no-tenant: no aplica
    const newDef = r.def.replace('ON DELETE SET NULL', `ON DELETE SET NULL (${r.null_cols})`);
    await knex.raw(`ALTER TABLE ${r.tbl} DROP CONSTRAINT "${r.conname}"`);
    await knex.raw(`ALTER TABLE ${r.tbl} ADD CONSTRAINT "${r.conname}" ${newDef}`);
    fixed++;
  }
  console.log(`[fix_composite_setnull_fks] ${fixed} FK recreadas con ON DELETE SET NULL (cols no-tenant).`);
};

exports.down = async function () {
  // No-op: revertir reintroduciría el bug (SET NULL sobre tenant_id NOT NULL).
  console.log('[fix_composite_setnull_fks] down: no-op (el estado previo era buggy).');
};
