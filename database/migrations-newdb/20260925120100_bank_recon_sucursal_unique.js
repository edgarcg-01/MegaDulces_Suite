/**
 * `[CC.13]` **La llave del cruce banco↔cobro no llevaba la sucursal.**
 *
 * `finance.bank_recon_matches` identifica el documento de Kepler con
 * `(kepler_doc_tipo, kepler_doc_folio)` — **sin `kepler_sucursal`**, que sí existe como columna
 * y sí se escribe. Mientras la vista de cobros estuvo clavada en una sola sucursal (`'00'`,
 * oficinas) el descuido no podía cobrarse: no había dos plazas de dónde chocar.
 *
 * Al incorporar el **Cobro CFDI** (`UA0701`), que vive en las sucursales **01, 02, 05 y 06**,
 * el folio deja de ser único dentro de un doctype: `UA0701/0000018` existe en la 01 **y** en la
 * 06 como dos cobros distintos. Con la llave vieja, ligar el segundo **pisaba** el primero por
 * el `ON CONFLICT`, sin error y sin rastro.
 *
 * Es la misma familia de trampa que en Kepler ya cobró dos veces: *el folio no identifica un
 * documento por sí solo*. Acá faltaba el eje sucursal; allá faltaba el doctype.
 *
 * ⚠️ El cambio **afloja** la restricción (una llave más larga admite todo lo que admitía la
 * corta), así que ninguna fila existente puede quedar en conflicto. Se verifica igual antes de
 * crear, porque una migración que da por sentado su propio efecto no es una migración.
 *
 * ⛔ **Esta migración es segura de aplicar ANTES del deploy, y a propósito**: agrega la llave
 * nueva y **no borra la vieja**. Borrarla primero dejaría al código que hoy corre en producción
 * con un `ON CONFLICT` de cuatro columnas sin constraint que lo respalde — o sea, conciliar
 * tiraría error en vivo. El retiro de la corta va en su propia migración, después.
 */

const TABLA = 'finance.bank_recon_matches';
const VIEJA = 'bank_recon_matches_tenant_id_bank_movement_id_kepler_doc_ti_key';
const NUEVA = 'bank_recon_matches_doc_suc_key';

async function existeConstraint(knex, nombre) {
  const r = await knex.raw(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = '${TABLA}'::regclass AND conname = '${nombre}'`);
  return (r.rows || []).length > 0;
}

/**
 * `[CC.13]` **Y `finance.collection_deposits` identifica el cobro con `(sucursal, folio)`,
 * que tampoco alcanza.** Medido: en la sucursal 02 hay **137 folios que existen como `UA0501`
 * y como `UA0701` a la vez** — dos cobros distintos. Adjuntarle una ficha a `02/0000001` era
 * ambiguo.
 *
 * ⚠️ La tabla está **vacía** (0 filas, verificado contra prod antes de escribir esto: el
 * módulo de comprobantes nunca se usó), así que la columna entra `NOT NULL` sin respaldo y sin
 * drama. El default `'UA0501'` es el único valor que la tabla podría haber tenido.
 */
async function docPrefixEnComprobantes(knex) {
  const tiene = await knex.schema.withSchema('finance').hasColumn('collection_deposits', 'doc_prefix');
  if (tiene) return;
  await knex.raw(
    "ALTER TABLE finance.collection_deposits "
    + "ADD COLUMN doc_prefix text NOT NULL DEFAULT 'UA0501'");
  await knex.raw(
    "COMMENT ON COLUMN finance.collection_deposits.doc_prefix IS "
    + "'[CC.13] Que documento de Kepler es (UA0501 Cobro PUE / UA0701 Cobro CFDI). El folio NO "
    + "es unico entre doctypes: en la sucursal 02, 137 folios existen como los dos.'");
}

exports.up = async function up(knex) {
  await docPrefixEnComprobantes(knex);
  if (await existeConstraint(knex, NUEVA)) return;

  // Prueba negativa de la premisa: si la llave LARGA ya tuviera duplicados, aflojar no sería
  // inocuo y habria que mirar los datos antes de tocar el schema.
  const dup = await knex.raw(
    `SELECT count(*)::int AS n FROM (
       SELECT tenant_id, bank_movement_id, kepler_doc_tipo, kepler_doc_folio, kepler_sucursal
         FROM ${TABLA}
        GROUP BY 1,2,3,4,5 HAVING count(*) > 1) d`);
  const n = Number((dup.rows || [])[0]?.n) || 0;
  if (n > 0) {
    throw new Error(
      `[CC.13] ${n} grupos duplicados con la llave que incluye sucursal. No se afloja la UNIQUE `
      + 'a ciegas: revisar esas filas primero.');
  }

  await knex.raw(
    `ALTER TABLE ${TABLA} ADD CONSTRAINT ${NUEVA}
       UNIQUE (tenant_id, bank_movement_id, kepler_doc_tipo, kepler_doc_folio, kepler_sucursal)`);

  // ⛔ La UNIQUE VIEJA se CONSERVA a proposito. Un `ON CONFLICT (a,b,c,d)` necesita una
  // constraint que empate EXACTAMENTE con esas columnas: si se borra antes de que el codigo
  // nuevo este desplegado, el codigo viejo que sigue corriendo en produccion revienta con
  // "no unique or exclusion constraint matching the ON CONFLICT specification" al conciliar.
  // Las dos conviven sin problema (hoy las 19,020 filas son de la sucursal 00, asi que la
  // corta no rechaza nada que la larga acepte). Se retira en una migracion aparte, DESPUES
  // del deploy -- ver [CC.13.1] en el tracker.
};

exports.down = async function down(knex) {
  // La columna NO se borra: CLAUDE.md prohibe borrar columnas sin confirmacion, y una columna
  // de mas con su default no le hace dano a nadie.
  if (!(await existeConstraint(knex, VIEJA))) {
    await knex.raw(
      `ALTER TABLE ${TABLA} ADD CONSTRAINT ${VIEJA}
         UNIQUE (tenant_id, bank_movement_id, kepler_doc_tipo, kepler_doc_folio)`);
  }
  if (await existeConstraint(knex, NUEVA)) {
    await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT ${NUEVA}`);
  }
};
