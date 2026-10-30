'use strict';
/**
 * `[PR.V15]` — **H3/H4: el motor deja de proponer subir el precio donde ya estamos perdiendo
 * terreno contra la competencia.**
 *
 * Pedido de Edgar (2026-10-30): cablear la participación de ISCAM, que estaba cargada y nadie
 * leía, como freno a «Subir el precio». El registro lo decía desde el 2026-10-01: *«Es la señal
 * que más le falta al motor: hoy propone subir el precio donde ya venimos perdiendo terreno»*.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30) ───────────────────────────────────────
 *  · ISCAM tiene UNA entrega cargada (julio 2026) con las cuatro medidas: lo nuestro y lo del
 *    mercado, actual y anterior. ⚠️ Si «anterior» es el mes previo o el año previo NO está
 *    decodificado: se publica tal cual lo entrega ISCAM.
 *  · Sólo nos mide en **Región III / Mayoreo Puro** (nuestro > 0 en 97 filas, 91 categorías). Es
 *    nuestro canal: eso resuelve, para este freno, la decisión abierta §H.1 (qué share publicar).
 *  · El puente SKU → categoría ISCAM es el **código de barras**, sin ceros a la izquierda (UPC de
 *    12 contra EAN-13 con 0). Cubre **39.6 %** de la venta de «subir» y 0 SKUs ambiguos. El resto
 *    no tiene par en la taxonomía de ISCAM (nuestros EAN son reales: KINDER DELICE 8000500034811
 *    no está en ella). ⛔ Por nombre no cruza: ISCAM normaliza la descripción (0 de 1,074).
 *  · 6 de las 91 categorías nos miden en DOS mercados (Desechables: 1.21 % en ABARROTES y 25.03 %
 *    en DULCES). Elegir uno sería adivinar: se declaran sin dato.
 *  · Alcance: frena **300 de 2,437** celdas libres de «subir», **$35,273 de $178,945** (20 %).
 *
 * ── La regla, la misma que define H4 en el registro ────────────────────────────────────────
 * Pierde terreno = nuestra participación bajó (`share_delta_pp < 0`) **y** la competencia creció
 * (`crec_competencia_pct > 0`): el terreno que perdemos se lo está llevando otro. Si el mercado
 * entero cayó (Dulce: −0.87 pp con la competencia en −10.5 %), no frena.
 * ⛔ NO MEDIDO: el ruido de la participación de un periodo a otro. Con una sola entrega no se
 *    puede medir cuánto se mueve por azar; no se inventa un umbral.
 *
 * ── Dónde vive ─────────────────────────────────────────────────────────────────────────────
 *  · `analytics.v_sku_iscam_terreno` — la señal por SKU, con su motivo cuando no hay dato.
 *  · `analytics.v_price_action` — la une a cada celda (por dentro: sobre las filas de la MV) y
 *    agrega el bloqueo `pierde_terreno_en_la_categoria` SÓLO a «subir_precio». Expone H3/H4.
 *  · `analytics.price_signal_registry` — H3 y H4 pasan a `cableada` con su cobertura medida.
 *
 * Vistas derive-no-copy, `security_invoker`. `v_price_action` se rehace sobre el cuerpo de
 * `[PR.V10]` (`20261030093024`, ya aplicada) con reemplazos que se verifican uno por uno.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_action';
const TERRENO = 'analytics.v_sku_iscam_terreno';
const REGION = 'Región III';
const SUBCANAL = 'Mayoreo Puro';
const MEDIDA = 'volumen';

// eslint-disable-next-line global-require
const anterior = require('./20261030093024_price_action_saldo_es_existencia.js');

/** La señal por SKU. */
const cuerpoTerreno = () => `
    WITH cb AS MATERIALIZED (
      -- Todos nuestros codigos de barras, sin ceros a la izquierda (UPC-A 12 contra EAN-13).
      SELECT p.sku::text AS sku, ltrim(regexp_replace(b.barcode, '\\D', '', 'g'), '0') AS k
        FROM catalog.products p JOIN catalog.product_barcodes b ON b.product_id = p.id
       WHERE p.deleted_at IS NULL AND p.sku IS NOT NULL
      UNION
      SELECT p.sku::text, ltrim(regexp_replace(p.barcode, '\\D', '', 'g'), '0')
        FROM catalog.products p
       WHERE p.deleted_at IS NULL AND p.sku IS NOT NULL AND p.barcode IS NOT NULL
    ), tx AS MATERIALIZED (
      SELECT DISTINCT ltrim(barcode_norm, '0') AS k, categoria FROM analytics.iscam_taxonomy
    ), puente AS MATERIALIZED (
      SELECT cb.sku, count(DISTINCT tx.categoria)::int AS n_categorias, min(tx.categoria) AS categoria
        FROM cb JOIN tx ON tx.k = cb.k
       WHERE length(cb.k) >= 7
       GROUP BY cb.sku
    ), medida AS MATERIALIZED (
      -- Solo donde ISCAM nos mide (nuestro > 0). Si una categoria aparece en varios mercados,
      -- se cuenta para declararla, nunca para elegir uno.
      SELECT s.categoria, count(*)::int AS n_mercados,
             min(s.share_pct) AS share_pct, min(s.share_delta_pp) AS share_delta_pp,
             min(s.crec_competencia_pct) AS crec_competencia_pct,
             min(s.periodo) AS periodo, min(s.entrega) AS entrega
        FROM analytics.v_iscam_share s
       WHERE s.region = '${REGION}' AND s.subcanal = '${SUBCANAL}' AND s.tipo_medida = '${MEDIDA}'
         AND s.nuestro > 0
       GROUP BY s.categoria
    )
    SELECT p.sku, p.categoria,
           CASE WHEN p.n_categorias = 1 AND m.n_mercados = 1 THEN m.share_pct END            AS share_pct,
           CASE WHEN p.n_categorias = 1 AND m.n_mercados = 1 THEN m.share_delta_pp END       AS share_delta_pp,
           CASE WHEN p.n_categorias = 1 AND m.n_mercados = 1 THEN m.crec_competencia_pct END AS crec_competencia_pct,
           m.periodo, m.entrega,
           CASE WHEN p.n_categorias > 1 THEN 'sku_en_varias_categorias'
                WHEN m.categoria IS NULL THEN 'iscam_no_nos_mide_en_esta_categoria'
                WHEN m.n_mercados > 1 THEN 'categoria_medida_en_varios_mercados'
           END AS motivo_sin_dato,
           coalesce(p.n_categorias = 1 AND m.n_mercados = 1
                    AND m.share_delta_pp < 0 AND m.crec_competencia_pct > 0, false) AS pierde_terreno
      FROM puente p
      LEFT JOIN medida m ON m.categoria = p.categoria
`;

/**
 * `v_price_action` = el cuerpo de [PR.V10] + el terreno. Cada reemplazo debe aplicar EXACTAMENTE
 * una vez: si el cuerpo anterior cambiara, la migración se niega en vez de armar otra vista.
 */
const cuerpo = () => {
  let b = anterior._cuerpo();
  const rep = (a, x) => {
    const p = b.split(a);
    if (p.length !== 2) throw new Error(`[PR.V15] el cuerpo de [PR.V10] no tiene UNA vez: ${a.slice(0, 70)}`);
    b = p.join(x);
  };
  // 1 · El terreno se une por dentro, sobre las filas de la MV (por fuera la cola tardaba 750 ms).
  rep('\n    WITH base AS (\n      SELECT s.*,',
    `\n    WITH terreno AS MATERIALIZED (SELECT * FROM ${TERRENO}),\n    base AS (\n      SELECT s.*,
        t.categoria AS h3_categoria_iscam, t.share_pct AS h3_share_pct,
        t.share_delta_pp AS h4_share_delta_pp, t.crec_competencia_pct AS h4_crec_competencia_pct,
        t.periodo AS h4_periodo_iscam, t.motivo_sin_dato AS h4_motivo_sin_dato,
        coalesce(t.pierde_terreno, false) AS h4_pierde_terreno,`);
  rep('      FROM analytics.mv_price_signals s\n    ),',
    '      FROM analytics.mv_price_signals s\n      LEFT JOIN terreno t ON t.sku = s.sku\n    ),');
  // 2 · El freno: un bloqueo más, SOLO para subir el precio.
  rep('      FROM base b\n    )\n    SELECT',
    `      FROM base b
    ), fin AS (
      SELECT c0.*,
             c0.bloqueos || CASE WHEN c0.accion_calc = 'subir_precio' AND c0.h4_pierde_terreno
                                 THEN ARRAY['pierde_terreno_en_la_categoria'] ELSE ARRAY[]::text[] END
               AS bloqueos_fin
        FROM conf c0
    )
    SELECT`);
  rep(`      c.bloqueos,
      (cardinality(c.bloqueos) = 0) AS accionable,
      CASE WHEN cardinality(c.bloqueos) > 0
           THEN 'hay restricciones activas: ' || array_to_string(c.bloqueos, ', ')`,
  `      c.bloqueos_fin AS bloqueos,
      (cardinality(c.bloqueos_fin) = 0) AS accionable,
      CASE WHEN cardinality(c.bloqueos_fin) > 0
           THEN 'hay restricciones activas: ' || array_to_string(c.bloqueos_fin, ', ')`);
  // 3 · H3/H4 visibles, al final.
  rep('      c.e3_existencia\n    FROM conf c\n',
    `      c.e3_existencia,
      c.h3_categoria_iscam, c.h3_share_pct, c.h4_share_delta_pp, c.h4_crec_competencia_pct,
      c.h4_pierde_terreno, c.h4_periodo_iscam, c.h4_motivo_sin_dato
    FROM fin c\n`);
  return b;
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const obj of ['analytics.v_iscam_share', 'analytics.iscam_taxonomy', 'catalog.product_barcodes',
    'analytics.mv_price_signals', 'analytics.price_signal_registry']) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [obj])).rows;
    if (!hay) throw new Error(`[PR.V15] falta ${obj}`);
  }

  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
  await knex.raw(`DROP VIEW IF EXISTS ${TERRENO}`);
  await knex.raw(`CREATE VIEW ${TERRENO} WITH (security_invoker = true) AS ${cuerpoTerreno()}`);
  await knex.raw(`CREATE VIEW ${VIEW} WITH (security_invoker = true) AS ${cuerpo()}`);
  await knex.raw(`GRANT SELECT ON ${TERRENO} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${TERRENO} IS
    $c$[PR.V15] H3/H4 por SKU: la participacion de su categoria segun ISCAM (${REGION}, ${SUBCANAL},
    ${MEDIDA}) y si pierde terreno = nuestra participacion bajo Y la competencia crecio. Puente por
    codigo de barras sin ceros a la izquierda (39.6% de la venta de subir, 2026-10-30). Sin dato,
    con motivo: SKU en varias categorias, ISCAM no nos mide ahi, o la categoria se mide en varios
    mercados (elegir uno seria adivinar). NO MEDIDO: el ruido de la participacion entre periodos.$c$`);
  await knex.raw(`COMMENT ON COLUMN ${VIEW}.h4_pierde_terreno IS
    $c$[PR.V15] true = la categoria de este SKU pierde participacion mientras la competencia crece
    (ISCAM). Frena SOLO subir_precio (bloqueo pierde_terreno_en_la_categoria). false incluye "sin
    dato": leer h4_motivo_sin_dato antes de concluir que no pierde.$c$`);

  // ── El registro: H3/H4 pasan a cableadas, con su cobertura medida sobre la vista. ─────
  const [cov] = (await knex.raw(`
    SELECT round(100.0 * count(*) FILTER (WHERE h3_share_pct IS NOT NULL) / NULLIF(count(*), 0), 2) h3,
           round(100.0 * count(*) FILTER (WHERE h4_share_delta_pp IS NOT NULL) / NULLIF(count(*), 0), 2) h4
      FROM ${VIEW}`)).rows;
  for (const [clave, col, pct] of [['H3', 'h3_share_pct', cov.h3], ['H4', 'h4_share_delta_pp', cov.h4]]) {
    await knex.raw(`
      UPDATE analytics.price_signal_registry
         SET estado = 'cableada', fuente_objeto = ?, fuente_columna = ?,
             cobertura_expr = ?, cobertura_pct = ?, cobertura_medida_al = current_date,
             -- trunc y no round: round puede subir (2.85% -> 0.029 > 0.0285) y romper el CHECK
             -- psr_peso_no_excede_cobertura.
             peso_max = trunc(?::numeric / 100.0, 3), motivo_ausencia = NULL, updated_at = now()
       WHERE clave = ?`, [VIEW, col, `${col} IS NOT NULL`, pct, pct, clave]);
  }

  // ── Los candados ─────────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas, (SELECT count(*)::int FROM analytics.mv_price_signals) filas_mv,
           count(*) FILTER (WHERE 'pierde_terreno_en_la_categoria' = ANY (bloqueos)
                              AND accion <> 'subir_precio')::int freno_fuera_de_subir,
           count(*) FILTER (WHERE accion = 'subir_precio' AND h4_pierde_terreno AND accionable)::int frenada_y_libre,
           count(*) FILTER (WHERE accion = 'subir_precio' AND h4_pierde_terreno)::int frenadas,
           count(*) FILTER (WHERE h4_pierde_terreno AND (h4_share_delta_pp >= 0 OR h4_crec_competencia_pct <= 0))::int regla_rota
      FROM ${VIEW}`)).rows;
  const [{ terreno_dup: terrenoDup }] = (await knex.raw(`
    SELECT count(*) - count(DISTINCT sku) AS terreno_dup FROM ${TERRENO}`)).rows;
  const [reg] = (await knex.raw(`
    SELECT count(*) FILTER (WHERE clave IN ('H3','H4') AND estado = 'cableada')::int cableadas
      FROM analytics.price_signal_registry`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.V15] cobertura H3 ${cov.h3}% · H4 ${cov.h4}% · subir frenadas ${g.frenadas}`);
  if (g.filas !== g.filas_mv) throw new Error(`[PR.V15] ${g.filas} filas contra ${g.filas_mv} de la MV: el terreno duplico celdas.`);
  if (Number(terrenoDup) > 0) throw new Error(`[PR.V15] ${terrenoDup} SKUs repetidos en el terreno.`);
  if (g.freno_fuera_de_subir > 0) throw new Error(`[PR.V15] ${g.freno_fuera_de_subir} celdas frenadas que no son subir_precio.`);
  if (g.frenada_y_libre > 0) throw new Error(`[PR.V15] ${g.frenada_y_libre} subir_precio que pierden terreno siguen libres.`);
  if (g.regla_rota > 0) throw new Error(`[PR.V15] ${g.regla_rota} celdas marcadas sin cumplir la regla de H4.`);
  if (reg.cableadas !== 2) throw new Error('[PR.V15] H3/H4 no quedaron cableadas en el registro.');
};

/** Deshacer volveria a proponer subir donde se pierde terreno: no se revierte. */
exports.down = async function down(knex) {
  void knex;
};

exports._cuerpo = cuerpo;
exports._cuerpoTerreno = cuerpoTerreno;
