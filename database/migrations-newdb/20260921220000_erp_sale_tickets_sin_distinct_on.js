/**
 * TK.7 — `analytics.erp_sale_tickets` deja de tardar 18 SEGUNDOS en traer los tickets de un
 * cliente, y no hace falta un índice nuevo: hay que sacarle peso muerto.
 *
 * ── El síntoma ────────────────────────────────────────────────────────────────────────────
 * Preparando el reporte por cliente se midió contra prod (solo lectura) lo que cuesta pedir
 * los tickets de UN cliente de UNA plaza en un mes:
 *
 *     SELECT ... FROM analytics.erp_sale_tickets
 *      WHERE sucursal='01' AND cliente_code='10448' AND fecha >= current_date - 30
 *                                                                    -> 17,876 ms · 16 filas
 *
 * ── La causa, leída del plan ──────────────────────────────────────────────────────────────
 * DOS defectos que se suman, y ninguno es la falta de un índice:
 *
 * 1. ⭐ **El `DISTINCT ON` no deduplica NADA, y es lo único que impide empujar los filtros.**
 *    Medido sobre el universo completo: `kdm1` tiene **440,484 filas** de `U-D-10` y
 *    **440,484 documentos distintos** por (sucursal, c4, c5, c6). Cero repetidos.
 *    Pero un `DISTINCT ON` obliga al planeador a construir el conjunto ENTERO antes de filtrar
 *    por cualquier columna que no sea parte de su llave — y la llave es la identidad del
 *    documento, no el cliente ni la fecha. Resultado en el plan: se materializaban **55,454
 *    filas** (todos los tickets históricos de la plaza) para devolver 16, con el filtro del
 *    cliente colgado ARRIBA del `Unique`. El índice por fecha que ya existe ni se tocaba.
 *
 * 2. **Los `btrim()` de los JOIN de catálogo anulan las PK que esas tablas YA tienen**:
 *    `kduv_pkey (sucursal, c2)` y `kdmm_pkey (sucursal, c1, c2, c3, c4)`. Envuelta la columna,
 *    el planeador no puede usarlas y cae a `Seq Scan` DENTRO del nested loop: 55,454 vueltas
 *    sobre `kduv` (3,053,480 filas descartadas, 3.5 s) y sobre `kdmm` (221,816, 14.5 s).
 *    Es el mismo defecto que ya se corrigió en `p.sku` (mig 20260918160000 y 20260921160000):
 *    tercera vez en este módulo.
 *
 * ── Medido, antes → después (prod, mejor de 2, MISMAS 16 filas en las cuatro) ─────────────
 *
 *     hoy (DISTINCT ON + btrim)            17,876 ms
 *     sólo quitar el DISTINCT ON               57 ms
 *     sólo arreglar los JOIN                1,240 ms
 *     las dos cosas (esta migración)           50 ms      ← 357x
 *
 * ── Por qué esto no cambia el resultado ──────────────────────────────────────────────────
 * ⚠️ Quitar un `DISTINCT ON` **sí** puede cambiar el resultado: si hubiera documentos repetidos
 * empezarían a salir duplicados. Por eso NO se quita por gusto, se quita porque está **medido
 * que no deduplica nada** — y el `up()` lo vuelve a comprobar contra los datos reales antes de
 * tocar la vista, con el conteo completo. Si algún día Kepler emite un `U-D-10` repetido, esta
 * migración revienta en vez de duplicar renglones en un papel.
 *
 * ⚠️ Las igualdades crudas de los JOIN se **AGREGAN**, no reemplazan a los `btrim`. Una
 * condición extra sólo puede quitar filas, y no quita ninguna porque no hay padding: medido,
 * `kduv.sucursal/c2` 0 de 379 · `kdmm.sucursal/c1/c2` 0 de 1,530 · `kdm1.c10/c12` 0 de 663,747.
 *
 * ⚠️ **Lo que NO se toca, con motivo:** `analytics.erp_sales_invoices` tiene el MISMO
 * `DISTINCT ON` y el mismo patrón (776 ms en la misma prueba). No se arregla acá porque son 42
 * columnas y la leen `weekly-analytics`, `commercial-profitability`, `commercial-televenta`,
 * `mv_kepler_sales_daily`, `product_volume_tiers` y `v_product_box_factor`: es un radio de
 * impacto que merece su propia medición y su propio commit, no ir de polizón en éste.
 * Queda como deuda con nombre.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;

// Mismo filtro que la definicion viva. Calza con el indice parcial ix_kdm1_venta_doc.
const HEAD = `h.c2='U' AND h.c3='D' AND (h.c4)::int=10 AND btrim(h.c1)=btrim(h.sucursal)`;

/**
 * Las 22 columnas VERBATIM de la definicion viva (mig 20260918160000): mismo nombre, mismo
 * tipo, mismo orden. Lo unico que cambia es que el subselect ya no lleva DISTINCT ON (ni su
 * ORDER BY, que solo existia para elegir el sobreviviente) y que los dos JOIN de catalogo
 * traen ademas la igualdad cruda, para que su PK vuelva a servir.
 */
const VIEW = `
  SELECT
    '${M}'::uuid AS tenant_id,
    q.sucursal, w.id AS warehouse_id, w.name AS warehouse_name,
    q.doc_prefix, 'ticket'::text AS doc_tipo, q.doc_label, q.caja, q.folio,
    q.sucursal || q.doc_prefix || '-' || q.folio AS folio_digital,
    q.fecha,
    q.cliente_code, q.cliente_nombre, q.cliente_rfc,
    q.cajero_code, q.cajero_nombre,
    q.total, q.iva, q.ieps, q.descuento_documento,
    'md_' || q.sucursal AS source_branch, now() AS computed_at
  FROM (
    SELECT
      btrim(h.sucursal) AS sucursal,
      'UD' || lpad((h.c4)::int::text,2,'0') || lpad((h.c5)::int::text,2,'0') AS doc_prefix,
      (h.c5)::int AS caja,
      COALESCE(NULLIF(btrim(dm.c5::text),''), 'Ticket Contado Caja ' || (h.c5)::int) AS doc_label,
      btrim(h.c6::text) AS folio,
      h.c9::date AS fecha,
      NULLIF(btrim(h.c10::text),'') AS cliente_code,
      NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
      NULLIF(btrim(h.c22::text),'') AS cliente_rfc,
      NULLIF(btrim(h.c12::text),'') AS cajero_code,
      NULLIF(btrim(v.c3::text),'')  AS cajero_nombre,
      ${money('h.c16')} AS total,
      ${money('h.c14')} AS iva,
      ${money('h.c15')} AS ieps,
      ${money('h.c13')} AS descuento_documento
    FROM kepler_ods.kdm1 h
    -- La igualdad CRUDA va junto a la de btrim, no en su lugar: con cero padding (medido) el
    -- conjunto de filas es identico, y es la unica forma de que kduv_pkey / kdmm_pkey se usen.
    LEFT JOIN kepler_ods.kduv v
      ON btrim(v.sucursal)=btrim(h.sucursal) AND btrim(v.c2::text)=btrim(h.c12::text)
     AND v.sucursal=h.sucursal AND v.c2=h.c12
    LEFT JOIN kepler_ods.kdmm dm
      ON btrim(dm.sucursal)=btrim(h.sucursal) AND btrim(dm.c1)='U' AND btrim(dm.c2)='D'
     AND (dm.c3)::int=(h.c4)::int AND (dm.c4)::int=(h.c5)::int
     AND dm.sucursal=h.sucursal AND dm.c1='U' AND dm.c2='D'
    WHERE ${HEAD}
  ) q
  LEFT JOIN commercial.warehouses w
    ON w.tenant_id='${M}'::uuid AND w.code=q.sucursal AND w.deleted_at IS NULL`;

exports.up = async function up(knex) {
  // ── El candado, ANTES de tocar nada ──────────────────────────────────────────────────
  // Quitar un DISTINCT ON es seguro sólo mientras no haya qué deduplicar. Se comprueba contra
  // los datos, no contra el recuerdo de haberlo medido: si Kepler empezó a emitir documentos
  // repetidos, esto revienta y la vista se queda como está.
  const { rows: [d] } = await knex.raw(`
    SELECT count(*)::bigint AS filas,
           count(DISTINCT (btrim(sucursal), (c4)::int, (c5)::int, btrim(c6::text)))::bigint AS docs
      FROM kepler_ods.kdm1
     WHERE c2='U' AND c3='D' AND (c4)::int=10 AND btrim(c1)=btrim(sucursal)`);
  if (String(d.filas) !== String(d.docs)) {
    throw new Error(
      `kepler_ods.kdm1 trae ${d.filas} filas de U-D-10 para ${d.docs} documentos distintos: ` +
      'el DISTINCT ON de erp_sale_tickets SI esta deduplicando. NO se puede quitar sin decidir ' +
      'antes cual de las filas repetidas es la buena. La vista queda como esta.');
  }
  console.log(`  ✓ ${d.filas} filas = ${d.docs} documentos: el DISTINCT ON no deduplica nada.`);

  // Y que los JOIN de catalogo se puedan atar por columna cruda sin perder filas.
  const { rows: [p] } = await knex.raw(`
    SELECT (SELECT count(*) FROM kepler_ods.kduv WHERE sucursal <> btrim(sucursal) OR c2 <> btrim(c2))::bigint AS v,
           (SELECT count(*) FROM kepler_ods.kdmm WHERE sucursal <> btrim(sucursal) OR c1 <> btrim(c1) OR c2 <> btrim(c2))::bigint AS m,
           (SELECT count(*) FROM kepler_ods.kdm1 WHERE c12 <> btrim(c12))::bigint AS h`);
  if (String(p.v) !== '0' || String(p.m) !== '0' || String(p.h) !== '0') {
    throw new Error(
      `Hay padding en las columnas del JOIN de catalogo (kduv ${p.v} · kdmm ${p.m} · kdm1.c12 ${p.h}): ` +
      'atarlas crudas PERDERIA filas (el cajero quedaria en NULL). La vista queda como esta.');
  }

  await knex.raw(`CREATE OR REPLACE VIEW analytics.erp_sale_tickets AS ${VIEW}`);
  await knex.raw('GRANT SELECT ON analytics.erp_sale_tickets TO app_runtime');

  const { rows: [c] } = await knex.raw(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_sale_tickets'`);
  if (c.n !== 22) {
    throw new Error(`analytics.erp_sale_tickets quedo con ${c.n} columnas, se esperaban 22.`);
  }
  console.log('  ✓ erp_sale_tickets: 22 columnas, sin DISTINCT ON y con las PK de catalogo usables.');
};

/**
 * No-op. El `up` no agrega ni quita columnas: saca una deduplicacion que no deduplicaba y hace
 * usables dos PK. Volver atras seria reponer a proposito los 18 segundos.
 */
exports.down = async function down() {
  console.log('[erp_sale_tickets_sin_distinct_on] down: no-op (el cambio es de plan, no de datos)');
};
