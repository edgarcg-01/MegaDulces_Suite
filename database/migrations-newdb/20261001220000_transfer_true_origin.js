/**
 * `[DM.17]` — **El ORIGEN REAL de un traspaso, cuando Kepler lo registró en otra sucursal.**
 *
 * ── QUÉ PASÓ ────────────────────────────────────────────────────────────────────────────────
 * Reporte de Edgar (2026-10-01): *"antes al 9.95 se subían CEDIS y Morelia Abastos; hay que
 * diferenciar los históricos"*. Se validó con un ticket impreso y es cierto.
 *
 * El ticket `T990008354` (almacén **30 Sucursal Morelia Abastos**, 16-sep, cliente *(10) ALMACÉN
 * PADRE HIDALGO*, 90041 ×48 + 90044 ×15 = 63 u / $1,407.66) se pasó a Kepler el 24-sep como una
 * cadena de TRES documentos — pedido `U-D-40` folio 0000759 → traspaso `U-D-41` folio 0000712 →
 * recepción `U-A-50` folio 0000317 en Padre Hidalgo — y los dos primeros quedaron en la
 * **sucursal `00` (el CEDIS)**. O sea: la pantalla publica "CEDIS" donde el origen físico fue
 * Morelia Abastos.
 *
 * ⭐ **El caso trae su propio control.** Ese mismo folio de ticket existe en DOS ramas Wincaja, y
 * las dos se cargaron a la sucursal `00`:
 *
 *   24-sep · 90041 ×48 + 90044 ×15 · $1,407.42  → rama 30 Morelia Abastos (consec 96303)
 *   29-sep · 99218 ×100            · $2,668.00  → rama 00 CEDIS           (consec 8719)
 *
 * Mismo folio, dos orígenes, mismo destino en Kepler. Lo único que los distingue es el CONTENIDO.
 *
 * ── POR QUÉ EL DESAMBIGUADOR ES SKU+CANTIDAD Y NO EL IMPORTE ───────────────────────────────
 * Medido sobre los 689 documentos de la sucursal 00 que llevan folio de ticket:
 *   · por folio solo        → 105 de 122 salen AMBIGUOS (el folio no es único entre ramas,
 *                             mismo modo de falla que `[DM.15]` con los folios de Kepler);
 *   · por folio + importe   → resuelve 36. Demasiado estricto: en el evento del 29-sep Kepler
 *                             dice $2,668.00 y Wincaja $1,533.34, y aun así es el mismo envío;
 *   · por folio + sku+cant  → resuelve **120 de 121 medibles (99.2%)**. Es el que funcionó a
 *                             mano con el ticket de Edgar.
 *
 * ── ⛔ LA COBERTURA SE DECLARA, PORQUE ES BAJA ──────────────────────────────────────────────
 * De 653 tickets referenciados, **532 NO existen en la réplica Wincaja** (81%). El límite NO es
 * el método —sobre lo medible acierta 99.2%— es que la réplica no tiene esos tickets. Por eso
 * `origen_veredicto` tiene un valor propio para eso (`ticket_fuera_de_replica`) en vez de
 * mezclarlo con "es del CEDIS": lo que no se puede medir se DECLARA (ADR-056).
 *
 * Resultado medido el 2026-10-01 sobre la sucursal `00`:
 *   62 cedis_confirmado · **40 otra_plaza → rama 30** · **17 otra_plaza → rama 50** · 1 ambiguo.
 *
 * ── LO QUE ESTA MIGRACIÓN NO HACE ───────────────────────────────────────────────────────────
 * **No corrige el dato en Kepler** (ADR-040: el ERP es el SoR, se lee y se declara, no se
 * escribe). La vista explica; el documento de Kepler se queda como está.
 *
 * ── EL ÍNDICE ───────────────────────────────────────────────────────────────────────────────
 * `wincaja.maestro_mov_almacen` son 1.5 M filas / 342 MB y no tenía índice por `documento`.
 * Sin él la resolución cuesta 4.2 s y el chequeo de cobertura 69 s. La columna viene LIMPIA
 * (medido: 0 valores con minúsculas, 0 con espacios), así que es un índice normal y no por
 * expresión — un `upper(btrim(...))` encima lo habría inutilizado.
 * `CONCURRENTLY` (sin lock de escritura) → esta migración NO corre en transacción.
 *
 * ⚠️ Hallazgo colateral ya aplicado: esa tabla y `detalles_mov_almacen` (10 M / 1.8 GB) tenían
 * `last_analyze` VACÍO — nunca se habían analizado, así que el planner elegía nested-loop sobre
 * 2 GB (el mismo problema que documenta `import-wincaja-stock-movements.js`). Se corrió ANALYZE:
 * 678 ms y 611 ms.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_wcj_maestro_documento
      ON wincaja.maestro_mov_almacen (documento)
      WHERE documento IS NOT NULL AND documento <> ''`);

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_transfer_true_origin
      WITH (security_invoker = true) AS
    WITH kep AS (
      -- Traspaso de SALIDA (U-D-41) que lleva folio de ticket Wincaja en c24.
      SELECT m.sucursal, m.c1 AS almacen, m.c6 AS folio, m.c5 AS doc_serie,
             m.c9::date AS doc_date, m.c24 AS ticket_ref,
             m.c16::numeric AS importe, m.c10 AS dest_code
        FROM kepler_ods.kdm1 m
       WHERE m.c2 = 'U' AND m.c3 = 'D' AND m.c4 = 41
         AND COALESCE(m.c24, '') <> ''
    ), kl AS (
      -- Renglones del documento Kepler (kdm2.c8 = SKU, c9 = cantidad).
      SELECT k.sucursal, k.folio, k.doc_serie, l.c8 AS sku, round(l.c9::numeric, 2) AS qty
        FROM kep k
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = k.sucursal AND l.c2 = 'U' AND l.c3 = 'D' AND l.c4 = 41
         AND l.c6 = k.folio AND l.c5 = k.doc_serie
    ), mae AS (
      -- Acotar la maestra por documento ANTES de tocar los 10 M renglones de detalles.
      SELECT w.tenant_id, w.source_branch, w.source_dataset, w.consecutivo, w.documento
        FROM wincaja.maestro_mov_almacen w
        JOIN (SELECT DISTINCT ticket_ref FROM kep) t ON t.ticket_ref = w.documento
    ), wl AS (
      SELECT m.source_branch AS rama, m.documento,
             d.articulo AS sku, round(abs(d.cantidad_regular)::numeric, 2) AS qty
        FROM mae m
        JOIN wincaja.detalles_mov_almacen d
          ON d.tenant_id = m.tenant_id AND d.source_branch = m.source_branch
         AND d.source_dataset = m.source_dataset AND d.consecutivo = m.consecutivo
    )
    SELECT k.sucursal AS sucursal_kepler, k.almacen, k.folio, k.doc_serie, k.doc_date,
           k.ticket_ref, k.importe, k.dest_code,
           r.ramas AS origen_rama_wincaja,
           t.existe AS ticket_en_replica,
           CASE
             WHEN NOT t.existe                      THEN 'ticket_fuera_de_replica'
             WHEN r.ramas IS NULL                   THEN 'sin_renglon_que_case'
             WHEN r.ramas LIKE '%,%'                THEN 'ambiguo'
             WHEN r.ramas = k.sucursal              THEN 'origen_confirmado'
             ELSE 'otra_plaza'
           END AS origen_veredicto
      FROM kep k
      LEFT JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM mae m WHERE m.documento = k.ticket_ref) AS existe
      ) t ON true
      LEFT JOIN LATERAL (
        -- Una rama CASA si comparte al menos un renglón (sku + cantidad) con el documento
        -- Kepler. Si casan varias, se declara ambiguo: elegir una sería inventar.
        SELECT string_agg(DISTINCT w.rama, ',' ORDER BY w.rama) AS ramas
          FROM wl w
         WHERE w.documento = k.ticket_ref
           AND EXISTS (
             SELECT 1 FROM kl x
              WHERE x.sucursal = k.sucursal AND x.folio = k.folio AND x.doc_serie = k.doc_serie
                AND x.sku = w.sku AND abs(x.qty - w.qty) < 0.01)
      ) r ON true`);

  await knex.raw(`GRANT SELECT ON analytics.v_transfer_true_origin TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_transfer_true_origin`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.ix_wcj_maestro_documento`);
};
