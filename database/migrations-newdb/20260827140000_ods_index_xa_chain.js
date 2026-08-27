/**
 * CDC.8b — índice sobre `kepler_ods.kdm1` para el back-pointer de la cadena de compra (`c39`).
 *
 * POR QUÉ. El shim `md` (CDC.8) deja el SQL de los importers byte-idéntico, pero **"mismo SQL" no
 * implica "mismo plan"**: el ODS ya tenía índices de EXPRESIÓN construidos con `btrim` para las
 * consultas de la fase AX —`(sucursal, btrim(c39)) WHERE c2='X' AND c3='A'`— y el SQL de
 * `import-in-transit` usa `c39` **pelado**. Un índice de expresión no aplica a la columna cruda, así
 * que el `NOT EXISTS` correlacionado resolvía `c39` como **Filter** en vez de Index Cond:
 *
 *   Nested Loop
 *     -> Index Scan using kdm1_pkey   Index Cond: (sucursal = current_setting(...) AND c2='X' …)
 *                                     Filter: (c37 = '35' AND c39 = '0001521')   <-- acá se muere
 *
 * Medido en .245 (sucursal 03, ventana de 120 d, 372 OCs):
 *   sin este índice → **timeout a los 120 s**
 *   con este índice → **128 ms** (51 filas)
 *
 * Y esto es lo que vuelve al repointeo MEJOR que el original, no sólo equivalente: la versión
 * per-branch sufre el mismo plan contra las réplicas locales (de ahí su `statement_timeout` de 240 s
 * por sucursal y los 12+ min que tarda el paso completo). Las DBs del ERP no las podemos indexar; el
 * ODS sí.
 *
 * `c37` va en el índice porque el mismo Filter lo evalúa (`c37='35'` / `c37='37'`): con las dos
 * columnas, el sub-join de la cadena vale→OE se resuelve entero por índice.
 *
 * Parcial `WHERE c2='X' AND c3='A'` (género X = compras, naturaleza A): la cadena de compra vive
 * toda ahí, así que el índice queda chico (~671 ms de creación sobre 574 k filas).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0].t) return;
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_ods_kdm1_xa_c39
      ON kepler_ods.kdm1 (sucursal, c39, c37)
      WHERE c2 = 'X' AND c3 = 'A'`);
  await knex.raw(`COMMENT ON INDEX kepler_ods.ix_ods_kdm1_xa_c39 IS
    'CDC.8b — back-pointer c39 de la cadena de compra (X-A-35 → 37 → 40) con c39 CRUDO, no btrim: el SQL de los importers no normaliza y el índice de expresión ix_* con btrim(c39) no le aplica. Sin esto, import-in-transit por el shim md hace timeout (>120s); con esto, 128ms.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS kepler_ods.ix_ods_kdm1_xa_c39`);
};
