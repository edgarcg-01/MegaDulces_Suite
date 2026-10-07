'use strict';
/**
 * `[RE.14.6]` — El apareo de gemelas se vuelve **motor**: dos funciones en la DB que son la
 * ÚNICA definición de cómo se aparea una recepción con su copia de oficinas.
 *
 * Por qué en la DB y no en TypeScript: hay **tres** consumidores del mismo apareo — el cron de
 * la API (que lo corre solo cada 5 min), el CLI de backfill (que barre el histórico desde LAN) y
 * el smoke. El CLI es Node plano en `database/` y no puede importar de `libs/`, así que tener la
 * lógica en el servicio obligaba a mantener dos copias del SQL: la garantía de que en algún
 * momento van a divergir, justo en la pieza que decide **qué dinero deja de contarse**. Con la
 * cascada dentro de la DB, los tres llaman a la misma cosa y corre donde están los datos.
 *
 *   · `fn_goods_receipt_twin_candidates(tenant, desde)` → los pares candidatos con su regla,
 *     su score y el `status` que les toca. **Sólo lee**: sirve para el dry-run del CLI y para el
 *     smoke sin escribir nada.
 *   · `fn_pair_goods_receipts(tenant, desde)` → aplica: UPSERT de las marcas + limpieza de las
 *     obsoletas, devolviendo qué hizo. Es lo que llama el cron.
 *
 * Las reglas y las dos puertas son las de RE.14.2 (ver el header de
 * `detect-goods-receipt-duplicates.js` para el razonamiento y los casos medidos):
 *   exacta 1.00 · monto_fecha 0.90 · centavos 0.75 · sugerida 0.50, pareo 1:1 determinista, y
 *   `status='auto'` (oculta) sólo si la copia de oficinas es de puro concepto **o** el par es
 *   exacto y único de los dos lados. Lo demás queda `'propuesto'`: no oculta y espera dictamen.
 *
 * **Ventana**: obligatoria y explícita. Medido sobre data real, el candidato cuesta ~0.9 s con 45
 * días y **~15 s con el histórico completo** (las dos fuentes son vistas vivas sobre `kepler_ods`,
 * y la de renglones agrega sobre `kdm2`). Por eso el cron va con ventana corta y el barrido
 * completo es trabajo del CLI, no del servidor.
 *
 * `SECURITY DEFINER` con `search_path` fijo: el cron corre con el usuario de la app y esto lo
 * deja inmune a que se muevan los grants de `analytics.*`. `analytics` no tiene RLS, así que no
 * hay política que saltarse; el filtro de tenant es explícito en las dos funciones.
 *
 * Idempotente (CREATE OR REPLACE). No borra datos.
 *
 * @param { import("knex").Knex } knex
 */

/** La cascada de reglas, en un solo lugar. `c` = copia de oficinas, `s` = la de sucursal. */
const REGLAS = `
    CASE
      WHEN c.monto = s.monto AND c.receipt_date = s.receipt_date
           AND c.prov = s.prov                                              THEN 'exacta'
      WHEN c.monto = s.monto AND abs(c.receipt_date - s.receipt_date) <= 7
           AND c.prov = s.prov                                              THEN 'monto_fecha'
      WHEN abs(c.monto - s.monto) <= greatest(5, s.monto * 0.0005)
           AND abs(c.receipt_date - s.receipt_date) <= 7
           AND (c.prov = s.prov OR public.similarity(c.prov, s.prov) >= 0.45) THEN 'centavos'
      WHEN c.monto = s.monto AND abs(c.receipt_date - s.receipt_date) <= 15  THEN 'sugerida'
    END`;

const CANDIDATES = `
CREATE OR REPLACE FUNCTION analytics.fn_goods_receipt_twin_candidates(p_tenant uuid, p_from date)
RETURNS TABLE (
  cedis_folio text, sucursal text, folio text,
  cedis_date date, cedis_monto numeric, cedis_prov text,
  suc_date date, suc_monto numeric, suc_prov text,
  delta_monto numeric, delta_dias integer,
  match_rule text, match_score numeric, status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, analytics, public AS $fn$
  -- El universo arranca 15 días ANTES de la ventana: la regla más floja tolera ±15 días, así que
  -- sin ese colchón un par cuya copia de sucursal cae justo antes del corte no se forma — y como
  -- la limpieza borra las marcas sin candidato, una corrida con ventana corta DESAPAREABA pares
  -- válidos (medido: 3 pares perdidos con ventana de 45 días). Sólo se aparean copias de oficinas
  -- dentro de la ventana; la de sucursal puede ser anterior.
  WITH g AS (
    SELECT g.sucursal, g.folio, g.receipt_date, g.monto, coalesce(g.proveedor_nombre, '') AS prov
      FROM analytics.erp_goods_receipts g
     WHERE g.tenant_id = p_tenant AND g.monto > 0
       AND g.receipt_date >= (p_from - interval '15 days')
  ),
  -- "De puro concepto": el documento no tiene productos, sólo renglones de concepto contable
  -- (SKU 0000x, 'VENTAS AL 0 %'). Se calcula SÓLO para los folios de oficinas dentro de la
  -- ventana: la fuente de renglones es una vista sobre kdm2 y agregarla entera cuesta caro.
  lump AS (
    SELECT l.folio, bool_and(l.sku ~ '^0000[0-9]$') AS conc
      FROM analytics.erp_goods_receipt_lines l
      JOIN g ON g.sucursal = '00' AND g.folio = l.folio AND g.receipt_date >= p_from
     WHERE l.tenant_id = p_tenant AND l.sucursal = '00'
     GROUP BY 1
  ),
  cand AS (
    SELECT c.folio AS cedis_folio, s.sucursal, s.folio,
           c.receipt_date AS cedis_date, c.monto AS cedis_monto, c.prov AS cedis_prov,
           s.receipt_date AS suc_date, s.monto AS suc_monto, s.prov AS suc_prov,
           round(c.monto - s.monto, 2) AS delta_monto,
           (c.receipt_date - s.receipt_date) AS delta_dias,
           coalesce(lp.conc, false) AS lump,
           ${REGLAS} AS regla
      FROM g c
      -- El JOIN usa el predicado MÁS FLOJO de las reglas; el CASE hace la clasificación fina.
      JOIN g s
        ON s.sucursal <> '00'
       AND abs(c.receipt_date - s.receipt_date) <= 15
       AND (c.monto = s.monto OR abs(c.monto - s.monto) <= greatest(5, s.monto * 0.0005))
      LEFT JOIN lump lp ON lp.folio = c.folio
     WHERE c.sucursal = '00' AND c.receipt_date >= p_from
  ),
  punt AS (
    SELECT *,
           CASE regla WHEN 'exacta' THEN 1.000 WHEN 'monto_fecha' THEN 0.900
                      WHEN 'centavos' THEN 0.750 ELSE 0.500 END AS score,
           count(*) OVER (PARTITION BY cedis_folio) AS nc_ofi,
           count(*) OVER (PARTITION BY sucursal, folio) AS nc_suc
      FROM cand WHERE regla IS NOT NULL
  ),
  -- Pareo 1:1 determinista: mejor candidato por folio de oficinas, y de esos el mejor por
  -- canónica. Los empates dejan filas sin aparear a propósito: preferimos no aparear a
  -- aparear mal, porque un apareo malo esconde una compra que existe.
  por_ofi AS (
    SELECT DISTINCT ON (cedis_folio) * FROM punt
     ORDER BY cedis_folio, score DESC, abs(delta_dias), abs(delta_monto), sucursal, folio
  ),
  por_can AS (
    SELECT DISTINCT ON (sucursal, folio) * FROM por_ofi
     ORDER BY sucursal, folio, score DESC, abs(delta_dias), abs(delta_monto), cedis_folio
  )
  SELECT p.cedis_folio, p.sucursal, p.folio,
         p.cedis_date, p.cedis_monto, p.cedis_prov,
         p.suc_date, p.suc_monto, p.suc_prov,
         p.delta_monto, p.delta_dias,
         p.regla, p.score,
         CASE
           -- Espejo por estructura: sin productos no puede ser una recepción por su cuenta,
           -- así que ocultarla no puede perder una compra real.
           WHEN p.lump AND p.score >= 0.75 THEN 'auto'
           -- Espejo por coincidencia irrepetible: mismo día, importe al centavo, mismo proveedor
           -- y UN SOLO candidato de cada lado. La unicidad es la parte que importa.
           WHEN p.regla = 'exacta' AND p.nc_ofi = 1 AND p.nc_suc = 1 THEN 'auto'
           ELSE 'propuesto'
         END AS status
    FROM por_can p
   -- La decisión humana manda: si alguien ya dictaminó cualquiera de los dos lados, el par no
   -- se recalcula ni se vuelve a proponer.
   WHERE NOT EXISTS (
     SELECT 1 FROM analytics.erp_goods_receipt_dedup d
      WHERE d.tenant_id = p_tenant AND d.status IN ('confirmado', 'rechazado')
        AND (d.cedis_folio = p.cedis_folio
          OR (d.dup_of_sucursal = p.sucursal AND d.dup_of_folio = p.folio))
   )
$fn$`;

const PAIR = `
CREATE OR REPLACE FUNCTION analytics.fn_pair_goods_receipts(p_tenant uuid, p_from date)
RETURNS TABLE (nuevas integer, marcadas integer, propuestas integer, obsoletas integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, analytics, public AS $fn$
DECLARE
  v_new integer;
  v_up integer;
  v_del integer;
  v_prop integer;
BEGIN
  -- Se materializa una vez: el set se usa para el UPSERT y para la limpieza, y recalcularlo
  -- sería pagar dos veces el self-join sobre las vistas vivas.
  DROP TABLE IF EXISTS _twin_par;
  CREATE TEMP TABLE _twin_par ON COMMIT DROP AS
    SELECT * FROM analytics.fn_goods_receipt_twin_candidates(p_tenant, p_from);


  -- Limpieza de marcas que ya no tienen candidato (cambió el importe, se canceló el documento).
  -- Acotada a la ventana procesada —si no, una ventana corta borraría el histórico— y sólo a
  -- las del motor: las dictaminadas por una persona se conservan.
  DELETE FROM analytics.erp_goods_receipt_dedup d
   WHERE d.tenant_id = p_tenant
     AND d.status IN ('auto', 'propuesto')
     AND EXISTS (
       SELECT 1 FROM analytics.erp_goods_receipts c
        WHERE c.tenant_id = p_tenant AND c.sucursal = '00' AND c.folio = d.cedis_folio
          AND c.receipt_date >= p_from)
     AND NOT EXISTS (SELECT 1 FROM _twin_par p WHERE p.cedis_folio = d.cedis_folio);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  -- El par es 1:1 por índice único parcial. Si una canónica ya tenía marca del MOTOR apuntando a
  -- otro folio de oficinas y el cálculo nuevo le asigna uno distinto, sin esto el UPSERT reventaría
  -- con violación de unicidad y se caía la corrida entera. Gana lo recién calculado; las marcas
  -- dictaminadas por una persona no entran acá (la función de candidatos ya las excluye).
  DELETE FROM analytics.erp_goods_receipt_dedup d
   WHERE d.tenant_id = p_tenant
     AND d.status IN ('auto', 'propuesto')
     AND EXISTS (
       SELECT 1 FROM _twin_par p
        WHERE p.sucursal = d.dup_of_sucursal AND p.folio = d.dup_of_folio
          AND p.cedis_folio <> d.cedis_folio);

  -- "nuevas" se cuenta ANTES del UPSERT y es el único número que sirve para loguear: "marcadas"
  -- son todas las de la ventana (casi siempre las mismas), así que un cron cada 5 minutos que
  -- reporte "405 marcas" es ruido. Lo que hay que ver es "aparecieron 3 pares".
  -- (Sin backticks: este SQL vive dentro de un template literal de JS.)
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
    -- Candado de la decisión humana, también en carrera: aunque el par entre en la tanda, si
    -- alguien ya dictaminó ese folio no se sobreescribe.
    WHERE analytics.erp_goods_receipt_dedup.status NOT IN ('confirmado', 'rechazado');
  GET DIAGNOSTICS v_up = ROW_COUNT;


  RETURN QUERY SELECT v_new, v_up, v_prop, v_del;
END
$fn$`;

exports.up = async function up(knex) {
  // `CREATE OR REPLACE` no puede cambiar el tipo de retorno: si una versión previa ya existe con
  // otra firma de salida, hay que tirarla primero (por eso la migración es re-aplicable).
  await knex.raw('DROP FUNCTION IF EXISTS analytics.fn_pair_goods_receipts(uuid, date)');
  await knex.raw(CANDIDATES);
  await knex.raw(PAIR);
  // El cron de la API corre con el usuario de la app; el CLI con el dueño.
  await knex.raw('GRANT EXECUTE ON FUNCTION analytics.fn_goods_receipt_twin_candidates(uuid, date) TO app_runtime');
  await knex.raw('GRANT EXECUTE ON FUNCTION analytics.fn_pair_goods_receipts(uuid, date) TO app_runtime');
  await knex.raw(`COMMENT ON FUNCTION analytics.fn_goods_receipt_twin_candidates(uuid, date) IS
    'RE.14 — pares candidatos (misma recepción capturada en la sucursal y en oficinas 00) con regla, score y el status que les toca. Sólo lee. Cascada: exacta/monto_fecha/centavos/sugerida, pareo 1:1 determinista, auto sólo si la copia de oficinas es de puro concepto o el par es exacto y único de los dos lados. Respeta los dictámenes humanos. Ventana obligatoria: ~0.9s con 45 días, ~15s con el histórico.'`);
  await knex.raw(`COMMENT ON FUNCTION analytics.fn_pair_goods_receipts(uuid, date) IS
    'RE.14 — aplica el apareo: UPSERT de marcas en erp_goods_receipt_dedup + limpieza de obsoletas (sólo las del motor, sólo en la ventana). Devuelve (nuevas, marcadas, propuestas, obsoletas). La llaman el cron de la API (ventana corta) y detect-goods-receipt-duplicates.js (backfill).'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP FUNCTION IF EXISTS analytics.fn_pair_goods_receipts(uuid, date)');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.fn_goods_receipt_twin_candidates(uuid, date)');
};
