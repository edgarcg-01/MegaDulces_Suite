'use strict';
/**
 * `[PR.X4]` — **La historia de precio se materializa, por un costo medido.**
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────
 * Las dos vistas de `[PR.X2]` responden bien en agregado, pero la ventana del SKU las consulta
 * **filtradas por un par**, y ahí el predicado no baja: los CTE barren la bitácora entera
 * (573,262 filas) y la serie de ventas (836,703) antes de filtrar.
 *
 * Medido contra prod, para **un solo SKU**:
 *
 * ```
 *   historia (v_sku_cost_sales_monthly) ....   174 ms   ✔
 *   eventos  (v_sku_price_events) .......... 3,166 ms   ⛔
 *   respuesta (v_sku_price_response) ....... 6,925 ms   ⛔
 *   plazas .................................    29 ms   ✔
 *   demanda perdida ........................    29 ms   ✔
 * ```
 *
 * ⭐ Se materializan **sólo las dos que lo necesitan**, no las cinco. Y son las candidatas
 * naturales: el event-study mira **hechos pasados** — un cambio de precio de julio no cambia
 * durante el día. Refrescarlas de noche no pierde nada.
 *
 * ⚠️ La `v_sku_cost_sales_monthly` se queda **viva** a propósito: responde en 174 ms y su fuente
 * (`mv_erp_margin_daily`) ya se refresca de noche. Materializar lo que ya corre rápido es
 * congelar sin ganar nada.
 *
 * ⛔ Y las vistas **no se retiran**: siguen siendo la definición, y las matvistas son
 * literalmente `SELECT *` de ellas — cero lógica duplicada.
 *
 * @param { import("knex").Knex } knex
 */

const PARES = [
  ['analytics.mv_sku_price_events', 'analytics.v_sku_price_events', 'ux_mv_sku_price_events',
    '(sucursal, sku, fecha)'],
  ['analytics.mv_sku_price_response', 'analytics.v_sku_price_response', 'ux_mv_sku_price_response',
    '(sucursal, sku, fecha)'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const medidas = [];
  for (const [mv, vista, idx, llave] of PARES) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [vista])).rows;
    if (!hay) throw new Error(`[PR.X4] falta ${vista}`);

    await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${mv}`);
    const t0 = Date.now();
    await knex.raw(`CREATE MATERIALIZED VIEW ${mv} AS
      SELECT v.*, now() AS calculado_al FROM ${vista} v`);
    const msBuild = Date.now() - t0;

    // UNIQUE para poder refrescar CONCURRENTLY sin bloquear a quien esté leyendo.
    await knex.raw(`CREATE UNIQUE INDEX ${idx} ON ${mv} ${llave}`);
    // El camino de acceso que la ventana usa: un par.
    await knex.raw(`CREATE INDEX ${idx}_par ON ${mv} (sucursal, sku)`);
    await knex.raw(`GRANT SELECT ON ${mv} TO app_runtime`);

    const [{ n }] = (await knex.raw(`SELECT count(*)::int n FROM ${mv}`)).rows;
    medidas.push({ mv, n, msBuild });
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sku_price_events IS
    $c$[PR.X4] Los cambios de precio limpios, materializados por COSTO medido: filtrada por un
    par, la vista tardaba 3,166 ms porque el predicado no baja y los CTE barren la bitacora
    entera (573,262 filas). Es un hecho pasado -un cambio de julio no cambia durante el dia- asi
    que refrescarla de noche no pierde nada. Es SELECT * de analytics.v_sku_price_events: cero
    logica duplicada.$c$`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sku_price_response IS
    $c$[PR.X4] El event-study materializado: filtrado por un par, la vista tardaba 6,925 ms.
    ⭐⭐ Conserva lr_pre -el PLACEBO- en la misma fila que lr_post, porque es lo que decide si el
    efecto se puede leer. Medido sobre todo el universo: pre-tendencia media +0.26 contra un
    efecto de -0.01, y EMPEORA cuanto mejores son los datos (+0.36 con 15+ dias por ventana). Y
    la prueba de que es un artefacto: una BAJA de precio y un ALZA producen el mismo movimiento
    negativo (-0.39 y -0.64). Ninguna curva de demanda hace eso -- es reversion a la media, el
    precio se toca justo despues de un pico.$c$`);

  // ── Compuerta · la consulta que hace la VENTANA ─────────────────────────────────────
  const CONSULTAS = [
    ['eventos de un par', `SELECT * FROM analytics.mv_sku_price_events
       WHERE sucursal = '02' AND sku = '17083' ORDER BY fecha DESC LIMIT 40`],
    ['event-study de un par', `SELECT * FROM analytics.mv_sku_price_response
       WHERE sucursal = '02' AND sku = '17083' ORDER BY fecha DESC`],
  ];
  let peor = 0; let peorN = '';
  for (const [n, sql] of CONSULTAS) {
    const t = Date.now();
    await knex.raw(sql);
    const ms = Date.now() - t;
    if (ms > peor) { peor = ms; peorN = n; }
    // eslint-disable-next-line no-console
    console.log(`  · [PR.X4] ${n.padEnd(24)} ${String(ms).padStart(5)} ms`);
  }

  for (const m of medidas) {
    // eslint-disable-next-line no-console
    console.log(`  · [PR.X4] ${m.mv} · ${m.n.toLocaleString()} filas · `
      + `construida en ${(m.msBuild / 1000).toFixed(1)} s`);
  }

  if (medidas.some((m) => m.n === 0)) {
    throw new Error('[PR.X4] alguna matvista quedo vacia.');
  }
  /**
   * ⭐ El gate es sobre la consulta que el consumidor CORRE. Medido antes: 3,166 y 6,925 ms.
   *    Si no baja de 1 s, materializar no resolvio el problema que la justifica.
   */
  if (peor > 1000) {
    throw new Error(`[PR.X4] la peor consulta de la ventana ("${peorN}") tarda ${peor} ms.`);
  }

  // ⛔ Y que no se hayan desviado de su vista: son SELECT * y tienen que tener sus columnas.
  for (const [mv, vista] of PARES) {
    const [{ falta }] = (await knex.raw(`
      SELECT count(*)::int falta FROM pg_attribute a
       WHERE a.attrelid = ?::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname NOT IN (SELECT b.attname FROM pg_attribute b
                                WHERE b.attrelid = ?::regclass AND b.attnum > 0
                                  AND NOT b.attisdropped)`, [vista, mv])).rows;
    if (falta > 0) throw new Error(`[PR.X4] a ${mv} le faltan ${falta} columnas de ${vista}.`);
  }
};

exports.down = async function down(knex) {
  for (const [mv] of PARES) await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${mv}`);
};
