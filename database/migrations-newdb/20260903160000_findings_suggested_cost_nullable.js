/**
 * U.2 — `commercial.replenishment_findings.suggested_cost` pasa a admitir NULL.
 *
 * POR QUÉ. La bandeja de reabasto persiste el valorizado del sugerido y ordena por él. Cuando el
 * costo de compra CONTRADICE el peldaño de la cantidad (`analytics.v_unit_rung_audit` → veredicto
 * `x1_inflada` / `x2_deflactada`), ese producto no se puede valuar: la cantidad está en la unidad
 * nativa del almacén y el costo por unidad BASE, y no coinciden. Con la columna en NOT NULL la
 * única salida era escribir **0** — que en pantalla se lee "no cuesta nada", justo la mentira que
 * este bloque de trabajo existe para quitar. NULL significa "no se está midiendo".
 *
 * Es un ABLANDAMIENTO: no borra ni renombra nada, no toca las filas existentes, y cualquier
 * lector que ya trate el valor como número sigue viendo número en las filas medibles. Los que
 * lean las no medibles tienen que decidir explícitamente qué mostrar — que es el punto.
 *
 * Idempotente: consulta el catálogo antes de alterar.
 */
exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'replenishment_findings'
        AND column_name = 'suggested_cost'`,
  );
  if (!rows.length) return;                    // la tabla/columna no existe todavía

  if (rows[0].is_nullable === 'NO') {
    await knex.raw('ALTER TABLE commercial.replenishment_findings ALTER COLUMN suggested_cost DROP NOT NULL');
  }
  // El comentario se (re)escribe siempre: es la documentación del contrato, y una segunda
  // corrida no debe dejarlo sin poner.
  await knex.raw(`COMMENT ON COLUMN commercial.replenishment_findings.suggested_cost IS
    'Valorizado del sugerido ($). NULL = NO SE ESTÁ MIDIENDO: el costo de compra contradice el peldaño de la cantidad (analytics.v_unit_rung_audit, veredicto x1/x2). NULL nunca es cero — no sumarlo como 0 ni pintarlo $0. Ver docs/UNIDADES_DE_MEDIDA.md §8quater.'`);
};

exports.down = async function down(knex) {
  // Volver a NOT NULL exigiría inventar un número para las filas no medibles. Se deja el
  // ablandamiento: revertirlo reintroduce el 0 mentiroso.
  await knex.raw(`COMMENT ON COLUMN commercial.replenishment_findings.suggested_cost IS NULL`);
};
