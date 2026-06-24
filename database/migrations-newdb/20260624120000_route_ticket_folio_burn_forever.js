/**
 * Folio de carga "quemado para siempre": un folio NO se puede reusar nunca —
 * ni en días pasados, ni aunque el ticket original se borre/cancele.
 *
 * Cambios vs el índice previo (`uniq_route_tickets_tenant_folio` que excluía
 * `deleted_at IS NULL`):
 *   1. NORMALIZA el folio almacenado (UPPER, sin espacios) → variantes del OCR
 *      ("t280…", " T280 …") colisionan en vez de pasar como distintas.
 *   2. Índice único por tenant SIN excluir borrados → reusar el folio de un
 *      ticket borrado queda bloqueado (regla de negocio: nunca reusable).
 *
 * Deploy-safe: si ya existieran folios repetidos en el historial (que el índice
 * viejo permitía vía borrado+recreación), el índice estricto NO se puede crear.
 * En ese caso NO crasheamos el deploy: log + fallback al índice de solo-vivos y
 * se limpia manualmente. Con datos limpios crea el índice estricto.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.uniq_route_tickets_tenant_folio`);

  // Normaliza folios existentes (UPPER + sin espacios) para que el OCR no genere
  // duplicados por diferencias de caso/espacios.
  await knex.raw(`
    UPDATE commercial.route_tickets
       SET folio = upper(regexp_replace(folio, '\\s', '', 'g'))
     WHERE folio IS NOT NULL
       AND folio <> upper(regexp_replace(folio, '\\s', '', 'g'))
  `);

  const dups = await knex.raw(`
    SELECT tenant_id, folio, count(*)::int AS n
      FROM commercial.route_tickets
     WHERE folio IS NOT NULL
     GROUP BY tenant_id, folio
    HAVING count(*) > 1
  `);
  if ((dups.rows?.length ?? 0) > 0) {
    console.warn(
      `[folio_burn_forever] ${dups.rows.length} folio(s) duplicados en historial — NO se aplica el índice estricto (deploy no crashea). Limpiar manualmente y re-correr. Detalle:`,
      dups.rows,
    );
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_tickets_tenant_folio
        ON commercial.route_tickets (tenant_id, folio)
        WHERE folio IS NOT NULL AND deleted_at IS NULL
    `);
    return;
  }

  await knex.raw(`
    CREATE UNIQUE INDEX uniq_route_tickets_tenant_folio
      ON commercial.route_tickets (tenant_id, folio)
      WHERE folio IS NOT NULL
  `);
  await knex.raw(
    `COMMENT ON INDEX commercial.uniq_route_tickets_tenant_folio IS 'Folio de carga único por tenant PARA SIEMPRE (incluye borrados): no reusable nunca. Normalizado UPPER sin espacios.'`,
  );
  console.log('[folio_burn_forever] índice estricto aplicado (folio no reusable, incl. borrados).');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.uniq_route_tickets_tenant_folio`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_tickets_tenant_folio
      ON commercial.route_tickets (tenant_id, folio)
      WHERE folio IS NOT NULL AND deleted_at IS NULL
  `);
};
