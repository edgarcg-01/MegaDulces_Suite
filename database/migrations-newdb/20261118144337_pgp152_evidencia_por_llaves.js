'use strict';
/**
 * `[PGP.152]` — **La evidencia de una lista de facturas se calcula SÓLO para esas facturas.** `analytics.v_payable_evidence`
 * se vuelve la función `analytics.payable_evidence(p_llaves text[])` con el MISMO cuerpo, y la vista queda como
 * `SELECT * FROM analytics.payable_evidence(NULL)`: una sola definición para las dos.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-18) ────────────────────────────────────────
 *  · `GET payment-calendar/evidencia` (la pantalla pide 200 facturas por tanda): **3.5–4.0 s**, 204 llamadas el 18-nov.
 *  · La causa: el CTE `pay` se usa 7 veces, Postgres lo materializa, y el filtro por llave del servicio se aplicaba
 *    DESPUÉS de cruzar las ~3,200 facturas abiertas contra 172 mil CFDI y 2,160 comprobantes. La evidencia de cada
 *    factura sólo depende de esa factura: filtrar dentro de `pay` da lo mismo.
 *  · Con el filtro dentro de `pay` (el cuerpo vivo de la vista, transformado por `cuerpoConLlaves`): **3.8 s → 2.0 s**,
 *    **196 de 196 filas idénticas** (JSON) a la vista filtrada, tres corridas.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · Lee el cuerpo VIVO de la vista (`pg_get_viewdef`), le agrega a `pay` el filtro por llave
 *    (`p_llaves IS NULL OR llave = ANY(p_llaves)`) y crea la función con ese cuerpo. Si el ancla no está (alguien
 *    cambió la vista), se NIEGA: no adivina dónde va el filtro.
 *  · La vista pasa a leer la función con `NULL` (sin filtro): mismas columnas, mismos tipos, mismas filas.
 *  · `SECURITY INVOKER` (el default): corre con los permisos de quien llama. Medido: `app_runtime` lee `fiscal.cfdis`,
 *    `finance.goods_receipt_proofs`, `v_supplier_payables` y `v_supplier_rfc`; ninguna vista depende de ésta.
 *
 * Sin tablas, sin índices, sin filas: `CREATE OR REPLACE FUNCTION` + `CREATE OR REPLACE VIEW`. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** El filtro que se agrega a `pay`. Se exporta para que la medición use EXACTAMENTE el mismo texto. */
const FILTRO = " AND (p_llaves IS NULL OR (v.sucursal || '|' || v.doc_tipo || '|' || v.doc_sub || '|' || btrim(v.folio)) = ANY(p_llaves))";
/**
 * El final de la condición de `pay` en la definición viva (`pg_get_viewdef`): la última exclusión de acreedores y el
 * cierre del CTE antes de `pr`. Tolerante a espacios y saltos (otra versión de Postgres formatea distinto).
 */
const ANCLA = /(OR upper\(btrim\(v\.proveedor\)\) ~~ 'B\.B\.%'::text\))(\s*\),\s*pr AS \()/g;

/** El cuerpo de la vista con el filtro por llave dentro de `pay`. Lanza si el ancla no está exactamente una vez. */
function cuerpoConLlaves(def) {
  const cuerpo = String(def).trim().replace(/;$/, '');
  const n = (cuerpo.match(ANCLA) ?? []).length;
  if (n !== 1) throw new Error(`[PGP.152] el ancla del CTE pay aparece ${n} veces en v_payable_evidence: la vista cambió, no se adivina dónde va el filtro`);
  return cuerpo.replace(ANCLA, (_m, cond, cierre) => `${cond}${FILTRO}${cierre}`);
}

/** Las columnas de la vista con su tipo exacto, para el `RETURNS TABLE`. */
async function columnas(knex) {
  return (await knex.raw(`
    SELECT a.attname AS nombre, format_type(a.atttypid, a.atttypmod) AS tipo
      FROM pg_attribute a
     WHERE a.attrelid = 'analytics.v_payable_evidence'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`)).rows;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const ya = (await knex.raw(`SELECT to_regprocedure('analytics.payable_evidence(text[])') IS NOT NULL AS hay`)).rows[0].hay;
  const def = (await knex.raw(`SELECT pg_get_viewdef('analytics.v_payable_evidence'::regclass, true) AS d`)).rows[0].d;
  if (ya && /payable_evidence\(NULL::text\[\]\)/.test(def)) {
    console.log('  · [PGP.152] la vista ya lee de analytics.payable_evidence: nada que hacer');
    return;
  }
  const cols = await columnas(knex);
  const cuerpo = cuerpoConLlaves(def);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.payable_evidence(p_llaves text[])
    RETURNS TABLE (${cols.map((c) => `${c.nombre} ${c.tipo}`).join(', ')})
    LANGUAGE sql STABLE
    AS $fn$ ${cuerpo} $fn$`);
  await knex.raw(`COMMENT ON FUNCTION analytics.payable_evidence(text[]) IS
    '[PGP.152] La evidencia (PDF del comprobante o UUID del CFDI) de las facturas pendientes de Kepler. p_llaves = sucursal|doc_tipo|doc_sub|folio; NULL = todas (lo que lee la vista v_payable_evidence).'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_payable_evidence AS SELECT * FROM analytics.payable_evidence(NULL::text[])`);
  // Control: la vista sigue entregando las mismas columnas, en el mismo orden y tipo.
  const despues = await columnas(knex);
  if (JSON.stringify(despues) !== JSON.stringify(cols)) throw new Error('[PGP.152] la vista cambió de columnas: ' + JSON.stringify(despues));
  console.log(`  ✓ [PGP.152] analytics.payable_evidence(p_llaves) creada; v_payable_evidence lee de ella (${cols.length} columnas iguales)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista vuelve a tener el cuerpo completo y se borra la función. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const fn = (await knex.raw(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('analytics.payable_evidence(text[])')`)).rows[0];
  if (!fn) return;
  const cuerpo = String(fn.prosrc).trim();
  if (cuerpo.split(FILTRO).length !== 2) throw new Error('[PGP.152] el cuerpo de la función no trae el filtro esperado: no se adivina cómo regresar la vista');
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_payable_evidence AS ${cuerpo.replace(FILTRO, '')}`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.payable_evidence(text[])`);
};

exports.cuerpoConLlaves = cuerpoConLlaves;
exports.FILTRO = FILTRO;
