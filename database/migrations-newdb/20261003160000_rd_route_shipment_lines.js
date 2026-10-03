'use strict';
/**
 * `[RD.19]` — **El traspaso, documento por documento, con el costo al que se cargó cada producto.**
 *
 * ── Por qué una vista nueva y no el ledger ──────────────────────────────────────────────────
 * `analytics.v_rd_route_ledger` agrega al grano `(ruta, fecha, clase, sku, unidad)` y **tira el
 * folio**. Para la pregunta de Edgar —*«el histórico de traspasos y a qué valor se hizo el
 * producto»*— el documento ES la unidad de la respuesta: un embarque se revisa, se firma y se
 * reclama por su folio, no por su fecha.
 *
 * ── Por qué VISTA y no matvista ─────────────────────────────────────────────────────────────
 * Medido contra prod: **42,700 líneas en 605 documentos** en toda la historia, y la lista de
 * embarques de una ruta sale en **17–19 ms**. El presupuesto son 500 ms. Materializar acá sería
 * pagar un refresco por un costo que no existe — la regla #1 del proyecto es derivar.
 *
 * ── El costo unitario, y lo que hay que decir de él ─────────────────────────────────────────
 * `kdm2.c12` es el costo unitario al que la sucursal le cargó ese renglón al camión, y `c13` su
 * importe. Es el mismo valor con el que el ledger arma `costo_doc`, así que la suma de las líneas
 * de un embarque **tiene que cuadrar** con lo que el ledger reporta ese día (el candado lo exige).
 *
 * ⚠️ **El costo del mismo SKU cambia entre embarques, y casi siempre es normal.** Medido: 1,269
 * pares tienen deriva **menor a 2×** —negociación, inflación— y sólo **9 pares** saltan **≥ 2×**,
 * que es donde el salto deja de ser precio y empieza a oler a **cambio de peldaño** (`[CE.8]` midió
 * que el factor de caja mínimo del catálogo es **2.00**, así que por debajo de eso no puede serlo).
 * Esos 9 valen $24,147 de carga y $1,560 de saldo.
 *
 * ⛔ **Una versión anterior de este análisis iba a tratar los 471 pares con «costo inestable» como
 * un hallazgo de $4.4M.** Era una banda mal calibrada: metía la deriva normal en el mismo cajón que
 * el cambio de unidad. Se retracta acá para que nadie la reconstruya — mismo error que `[CE.8]`.
 *
 * @param { import("knex").Knex } knex
 */

const V = 'analytics.v_rd_route_shipment_lines';

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${V} AS
    SELECT i.tenant_id,
           i.route_no,
           h.c9::date            AS business_date,
           NULLIF(h.c5::text,'') AS serie,
           h.c6                  AS folio,
           btrim(d.c8)           AS sku,
           btrim(d.c10)          AS producto_erp,
           btrim(d.c11)          AS unidad,
           d.c9::numeric         AS qty,
           d.c12::numeric        AS costo_unitario,
           d.c13::numeric        AS importe
      FROM analytics.mv_rd_route_identity i
      JOIN kepler_ods.kdm1 h
        ON h.sucursal = i.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
       AND h.c10 = i.destino AND h.c9::date >= i.carga_desde
      JOIN kepler_ods.kdm2 d
        ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
       AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
     -- Las líneas de SERVICIO (fletes, "VENTAS AL 0%") no son producto: no entran al embarque,
     -- igual que no entran al ledger. Si entraran, el total del documento dejaría de cuadrar.
     WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
  `);
  // ⚠️ No se heredan en un CREATE OR REPLACE (ADR-057 los perdió una vez justo así).
  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${V} IS
    'RD.19 - una fila por LINEA de embarque U-D-41 a una ruta, con folio y costo unitario (kdm2.c12). El ledger agrega y tira el folio; aca el documento es la unidad de la respuesta. 42,700 lineas / 605 docs, lista de una ruta en ~18 ms: vista, no matvista.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
};
