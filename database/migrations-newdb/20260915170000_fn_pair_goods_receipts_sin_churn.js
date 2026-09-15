/**
 * [DB-MEM.4] — **El UPSERT del apareo de gemelas reescribía 2,814 filas cada vez que corría,
 * cambiara o no algo.**
 *
 * Medido en prod (`pg_stat_user_tables`, 2026-09-15):
 *
 *   analytics.erp_goods_receipt_dedup
 *     · filas vivas ........... 2,814
 *     · n_tup_ins .............. 5,364
 *     · n_tup_upd ......... 12,505,884   ← 4,444 UPDATEs por cada fila que existe
 *     · tuplas muertas ........ 4,665 %
 *     · tamaño .................. 41 MB  (para 2,814 filas)
 *
 * La causa no es el volumen de recepciones —son 1 a 54 por DÍA— sino que el `ON CONFLICT DO UPDATE`
 * reasigna **todas** las columnas en cada pasada, incluida `computed_at = now()`, que **siempre**
 * es distinta. Postgres no tiene forma de saber que el resto es idéntico: cada UPDATE escribe una
 * versión nueva de la fila y deja la anterior muerta, y el autovacuum corre detrás.
 *
 * ── EL ARREGLO ───────────────────────────────────────────────────────────────────────────────
 * Un `IS DISTINCT FROM` sobre la tupla de columnas de negocio. Si nada cambió, no se escribe nada.
 * Es el mismo patrón de UPSERT sin churn que ya usan los feeds del ODS.
 *
 * `IS DISTINCT FROM` y no `<>` **porque hay NULLs de verdad** en estas columnas (`suc_prov`,
 * `cedis_prov` y `delta_*` vienen de vistas con `LEFT JOIN`): con `<>`, `NULL <> NULL` da NULL,
 * el WHERE no se cumple y la fila **nunca** se actualizaría — el bug opuesto y mucho peor, porque
 * sería silencioso y dejaría marcas viejas apuntando a folios que ya cambiaron.
 *
 * ── LO QUE CAMBIA DE SIGNIFICADO, Y POR QUÉ ES SEGURO ────────────────────────────────────────
 *  · `computed_at` deja de moverse cuando el cálculo dio lo mismo. Pasa a significar *"cuándo
 *    cambió este valor"* en vez de *"cuándo corrió el proceso"*. Verificado antes de tocarlo:
 *    **ningún código de aplicación lo lee** (sólo aparece en migraciones que lo definen). Y el
 *    *"cuándo corrió el proceso"* ahora lo responde el latido `twins_pairing` en
 *    `analytics.cron_runs`, que es donde corresponde.
 *  · `marcadas` (el `ROW_COUNT` del UPSERT) pasa de "todas las de la ventana" a "las que de verdad
 *    cambiaron". Es una mejora: el propio comentario de la función de 2026-08-27 ya decía que
 *    *"marcadas son casi siempre las mismas, así que un cron cada 5 minutos que reporte 405 marcas
 *    es ruido"*. Ahora ese número informa algo.
 *  · `nuevas`, `propuestas` y `obsoletas` **no cambian**: se calculan antes del UPSERT.
 *
 * ⚠️ El candado de la decisión humana (`status NOT IN ('confirmado','rechazado')`) se conserva
 * intacto y va PRIMERO en el WHERE.
 *
 * ⚠️ Este SQL vive dentro de un template literal de JS: sin backticks en los comentarios.
 */

/**
 * El guard nuevo, como pieza aparte: así el `down` reconstruye EXACTAMENTE la función de
 * `20260827170000` pasando cadena vacía, sin recortar el SQL con una expresión regular (que se
 * rompe en silencio al primer espacio que cambie y deja una función a medias en producción).
 */
const GUARD_SIN_CHURN = `
    -- 2) [DB-MEM.4] Y sólo si algo de negocio cambió de verdad. IS DISTINCT FROM (no <>) porque
    --    suc_prov / cedis_prov / delta_* llegan NULL desde vistas con LEFT JOIN: con <>, un NULL
    --    haría que la fila no se actualice NUNCA.
    AND (
      analytics.erp_goods_receipt_dedup.dup_of_sucursal,
      analytics.erp_goods_receipt_dedup.dup_of_folio,
      analytics.erp_goods_receipt_dedup.match_rule,
      analytics.erp_goods_receipt_dedup.match_score,
      analytics.erp_goods_receipt_dedup.suc_date,
      analytics.erp_goods_receipt_dedup.suc_monto,
      analytics.erp_goods_receipt_dedup.suc_prov,
      analytics.erp_goods_receipt_dedup.cedis_date,
      analytics.erp_goods_receipt_dedup.cedis_monto,
      analytics.erp_goods_receipt_dedup.cedis_prov,
      analytics.erp_goods_receipt_dedup.delta_monto,
      analytics.erp_goods_receipt_dedup.delta_dias,
      analytics.erp_goods_receipt_dedup.status
    ) IS DISTINCT FROM (
      EXCLUDED.dup_of_sucursal, EXCLUDED.dup_of_folio, EXCLUDED.match_rule, EXCLUDED.match_score,
      EXCLUDED.suc_date, EXCLUDED.suc_monto, EXCLUDED.suc_prov,
      EXCLUDED.cedis_date, EXCLUDED.cedis_monto, EXCLUDED.cedis_prov,
      EXCLUDED.delta_monto, EXCLUDED.delta_dias, EXCLUDED.status
    )`;

// `CREATE OR REPLACE FUNCTION` conserva la firma; no hace falta DROP porque el tipo de retorno
// (nuevas, marcadas, propuestas, obsoletas) es idéntico al de la migración 20260827170000.
const fn = (guard) => `
CREATE OR REPLACE FUNCTION analytics.fn_pair_goods_receipts(p_tenant uuid, p_from date)
RETURNS TABLE (nuevas integer, marcadas integer, propuestas integer, obsoletas integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, analytics, public AS $fn$
DECLARE
  v_new integer;
  v_up integer;
  v_del integer;
  v_prop integer;
BEGIN
  DROP TABLE IF EXISTS _twin_par;
  CREATE TEMP TABLE _twin_par ON COMMIT DROP AS
    SELECT * FROM analytics.fn_goods_receipt_twin_candidates(p_tenant, p_from);

  DELETE FROM analytics.erp_goods_receipt_dedup d
   WHERE d.tenant_id = p_tenant
     AND d.status IN ('auto', 'propuesto')
     AND EXISTS (
       SELECT 1 FROM analytics.erp_goods_receipts c
        WHERE c.tenant_id = p_tenant AND c.sucursal = '00' AND c.folio = d.cedis_folio
          AND c.receipt_date >= p_from)
     AND NOT EXISTS (SELECT 1 FROM _twin_par p WHERE p.cedis_folio = d.cedis_folio);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  DELETE FROM analytics.erp_goods_receipt_dedup d
   WHERE d.tenant_id = p_tenant
     AND d.status IN ('auto', 'propuesto')
     AND EXISTS (
       SELECT 1 FROM _twin_par p
        WHERE p.sucursal = d.dup_of_sucursal AND p.folio = d.dup_of_folio
          AND p.cedis_folio <> d.cedis_folio);

  SELECT count(*)::int INTO v_new FROM _twin_par p
   WHERE NOT EXISTS (
     SELECT 1 FROM analytics.erp_goods_receipt_dedup d
      WHERE d.tenant_id = p_tenant AND d.cedis_folio = p.cedis_folio);

  SELECT count(*)::int INTO v_prop FROM _twin_par WHERE status = 'propuesto';

  INSERT INTO analytics.erp_goods_receipt_dedup
    (tenant_id, cedis_folio, dup_of_sucursal, dup_of_folio, match_rule, match_score,
     suc_date, suc_monto, suc_prov, cedis_date, cedis_monto, cedis_prov,
     delta_monto, delta_dias, status, computed_at)
  SELECT p_tenant, cedis_folio, sucursal, folio, match_rule, match_score,
         suc_date, suc_monto, suc_prov, cedis_date, cedis_monto, cedis_prov,
         delta_monto, delta_dias, status, now()
    FROM _twin_par
  ON CONFLICT (tenant_id, cedis_folio) DO UPDATE
    SET dup_of_sucursal = EXCLUDED.dup_of_sucursal, dup_of_folio = EXCLUDED.dup_of_folio,
        match_rule = EXCLUDED.match_rule, match_score = EXCLUDED.match_score,
        suc_date = EXCLUDED.suc_date, suc_monto = EXCLUDED.suc_monto, suc_prov = EXCLUDED.suc_prov,
        cedis_date = EXCLUDED.cedis_date, cedis_monto = EXCLUDED.cedis_monto, cedis_prov = EXCLUDED.cedis_prov,
        delta_monto = EXCLUDED.delta_monto, delta_dias = EXCLUDED.delta_dias,
        status = EXCLUDED.status, computed_at = now()
    -- 1) El candado de la decisión humana, intacto y primero.
    WHERE analytics.erp_goods_receipt_dedup.status NOT IN ('confirmado', 'rechazado')${guard};
  GET DIAGNOSTICS v_up = ROW_COUNT;

  RETURN QUERY SELECT v_new, v_up, v_prop, v_del;
END
$fn$`;

exports.up = async function up(knex) {
  await knex.raw(fn(GUARD_SIN_CHURN));
  await knex.raw(`COMMENT ON FUNCTION analytics.fn_pair_goods_receipts(uuid, date) IS
    'Aplica el apareo de gemelas. [DB-MEM.4] El UPSERT solo escribe si alguna columna de negocio cambio (IS DISTINCT FROM): antes reescribia las 2,814 filas en cada corrida (12.5M updates acumulados, 4,665% de tuplas muertas). computed_at pasa a significar cuando CAMBIO el valor; cuando corrio el proceso lo dice el latido twins_pairing en analytics.cron_runs.'`);
};

/**
 * Restaura el UPSERT incondicional de `20260827170000`: la MISMA función, con el candado humano
 * como único WHERE. No se pierde información — lo que el churn dejaba eran tuplas muertas.
 */
exports.down = async function down(knex) {
  await knex.raw(fn(''));
};
