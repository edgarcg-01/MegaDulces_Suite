/**
 * Fase AX.0b — Índices de expresión sobre `kepler_ods` para que las vistas de facturas
 * (mig 20260822140000) sirvan a una UI.
 *
 * POR QUÉ: medido en prod, traer las 12 líneas de UNA factura tardaba **17.1 s**. El plan
 * mostraba `Parallel Seq Scan` porque las vistas filtran con `btrim(col)` y `(col)::int`,
 * y una expresión no puede usar un índice normal — las PK de kdm1/kdm2 arrancan con
 * `c2`,`c3` ('U','D'), de selectividad casi nula.
 *
 * Un índice NO es una copia: no duplica el dato ni introduce lag. La frescura del CDC
 * (~segundos) queda intacta; sólo se paga un poco en el UPSERT del replicador.
 *
 * CONCURRENTLY + `transaction:false`: `kdm2` tiene ~3.4M filas y el CDC le escribe en vivo.
 * Un CREATE INDEX normal toma ACCESS EXCLUSIVE y bloquearía la replicación mientras dura.
 * Knex corre cada migración en transacción por default y CONCURRENTLY no lo permite.
 *
 * Los índices son PARCIALES (`WHERE c2='U' AND c3='D'`) para no indexar compras/traspasos.
 */

exports.config = { transaction: false };

// Mismas expresiones que usan las vistas — si cambian allá, cambian aquí o el índice deja de aplicar.
const IDX = [
  // Documento de venta por (sucursal, tipo, serie, folio) — el lookup de cabecera y de líneas.
  [`ix_kdm1_venta_doc`, `kepler_ods.kdm1`,
    `(btrim(sucursal), ((c4)::int), ((c5)::int), btrim(c6::text))`, `c2='U' AND c3='D'`],
  [`ix_kdm2_venta_doc`, `kepler_ods.kdm2`,
    `(btrim(sucursal), ((c4)::int), ((c5)::int), btrim(c6::text))`, `c2='U' AND c3='D'`],
  // Listado por rango de fechas (la pantalla arranca con "últimos N días").
  [`ix_kdm1_venta_fecha`, `kepler_ods.kdm1`, `((c9)::date)`, `c2='U' AND c3='D'`],
  // Join del factor de caja (kdii) y del catálogo por SKU.
  [`ix_kdii_suc_sku`, `kepler_ods.kdii`, `(btrim(sucursal), btrim(c1::text))`, null],
];

exports.up = async function up(knex) {
  for (const [name, table, expr, where] of IDX) {
    await knex.raw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table} ${expr}` +
      (where ? ` WHERE ${where}` : '')
    );
  }
};

exports.down = async function down(knex) {
  for (const [name] of IDX) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${name}`);
  }
};
