'use strict';
/**
 * `[PR.S2.4]` — **La capa 2, legible: la vista de senales se materializa.**
 *
 * ── ⛔⛔ Por que, medido ────────────────────────────────────────────────────────────────────
 * `[PR.S2.3]` cableo 12 senales nuevas y el barrido completo quedo bien: **2.9 s** contra 1.2 s
 * de la version de 16. Lo que se rompio es lo unico que una pantalla hace de verdad:
 *
 *     WHERE sucursal = '03' ORDER BY venta_30d DESC LIMIT 50
 *       · con 16 senales ......   1,622 ms
 *       · con 28 senales ... **118,754 ms**   ⛔ 73x
 *
 * **No es volumen: es el LIMIT.** Con 14 joins el planner cree que un plan de arranque rapido le
 * sale barato, elige bucles anidados sobre CTEs que no puede podar, y falla. Agregar senales
 * cruzo el punto donde esa apuesta deja de pagar. Ninguna reescritura de la vista arregla eso de
 * forma estable -- la proxima senal lo vuelve a cruzar.
 *
 * ── ⚠️ Esto CONTRADICE lo que escribi en [PR.S2.1], y hay que decirlo ──────────────────────
 * Al materializar la cascada deje escrito: *"se materializa SOLO esta pieza; materializar la
 * vista entera congelaria tambien la psicologia y el costo, que corren en milisegundos"*.
 *
 * Eso era cierto **para el problema de entonces**, que era COSTO. Este es otro problema: el plan
 * se desarma bajo un LIMIT, y contra eso la frescura de la psicologia no compra nada -- una
 * pantalla que tarda dos minutos no publica un dato fresco, no publica ninguno.
 *
 * ⛔ El precio se paga y se declara: psicologia y costo pasan a ser **de la ultima corrida**.
 * Va en `calculado_al`, que viaja con cada fila. Una matvista sin su fecha se lee como si fuera
 * de ahora.
 *
 * ── ⭐ La vista NO se retira ───────────────────────────────────────────────────────────────
 * `v_price_signals` se queda como la **DEFINICION**: es lo que el registro de la capa 1 verifica
 * columna por columna, y la matvista es literalmente `SELECT * FROM` ella -- cero logica
 * duplicada, que es lo que la regla de derivar-no-copiar pide. El candado de abajo cruza las dos
 * y falla si alguna vez difieren en una columna.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_price_signals';
const V = 'analytics.v_price_signals';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(`SELECT to_regclass('${V}') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S2.4] falta analytics.v_price_signals ([PR.S2.3])');

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);

  /**
   * ⭐ Derivada, no copiada: `SELECT *` sobre la vista. Si manana cambia una senal, cambia acá
   *    sola al refrescar -- no hay una segunda definicion que mantener sincronizada a mano.
   */
  const t0 = Date.now();
  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    SELECT s.*, now() AS calculado_al
      FROM ${V} s
  `);
  const msBuild = Date.now() - t0;

  // UNIQUE para poder refrescar CONCURRENTLY sin bloquear a quien este leyendo.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_price_signals ON ${MV} (sucursal, sku)`);
  // El camino de acceso que la pantalla usa de verdad: una plaza, ordenada por impacto.
  await knex.raw(`CREATE INDEX ix_mv_price_signals_plaza_venta
    ON ${MV} (sucursal, venta_30d DESC NULLS LAST)`);
  // Y el otro: un SKU en las 9 plazas.
  await knex.raw(`CREATE INDEX ix_mv_price_signals_sku ON ${MV} (sku)`);

  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    $c$[PR.S2.4] La capa 2 materializada, por un costo MEDIDO y no por costumbre: con 28 senales
    la consulta que hace una pantalla -WHERE sucursal + ORDER BY + LIMIT 50- paso de 1,622 ms a
    118,754 ms. No es volumen, es el LIMIT: con 14 joins el planner apuesta a un plan de arranque
    rapido y pierde. El barrido completo si esta bien (2.9 s), asi que refrescarla es barato.
    ⚠️ Contradice a proposito lo que [PR.S2.1] dejo escrito -que materializar todo congelaria la
    psicologia y el costo-: aquello resolvia COSTO, esto resuelve un plan que se desarma, y una
    pantalla de dos minutos no publica un dato fresco, publica ninguno. El precio se declara en
    calculado_al, que viaja con cada fila.
    ⭐ Es SELECT * sobre analytics.v_price_signals: cero logica duplicada. La vista sigue siendo
    la definicion que el registro de senales verifica columna por columna.$c$`);

  // ── Compuerta 1 · ⭐ la matvista y la vista no pueden DIFERIR ────────────────────────
  const [eq] = (await knex.raw(`
    WITH cv AS (SELECT attname FROM pg_attribute
                 WHERE attrelid = '${V}'::regclass AND attnum > 0 AND NOT attisdropped),
         cm AS (SELECT attname FROM pg_attribute
                 WHERE attrelid = '${MV}'::regclass AND attnum > 0 AND NOT attisdropped)
    SELECT (SELECT count(*)::int FROM cv) AS en_vista,
           (SELECT count(*)::int FROM cm) AS en_mv,
           (SELECT count(*)::int FROM cv WHERE attname NOT IN (SELECT attname FROM cm)) AS falta_en_mv,
           (SELECT count(*)::int FROM cm
             WHERE attname NOT IN (SELECT attname FROM cv)
               AND attname <> 'calculado_al') AS sobra_en_mv,
           (SELECT count(*)::int FROM ${MV}) AS filas`)).rows;

  if (eq.falta_en_mv > 0 || eq.sobra_en_mv > 0) {
    throw new Error(`[PR.S2.4] la matvista y la vista difieren: faltan ${eq.falta_en_mv}, `
      + `sobran ${eq.sobra_en_mv}. Serian dos definiciones distintas del mismo dato.`);
  }
  if (eq.filas !== 86163) {
    throw new Error(`[PR.S2.4] la matvista trae ${eq.filas} filas y el grano medido es 86,163.`);
  }

  // ── Compuerta 2 · ⭐⭐ la consulta que hace la PANTALLA, no un barrido que nadie corre ──
  const CONSULTAS = [
    ['una plaza, top 50 por impacto',
      `SELECT * FROM ${MV} WHERE sucursal = '03' ORDER BY venta_30d DESC NULLS LAST LIMIT 50`],
    ['un SKU en las 9 plazas', `SELECT * FROM ${MV} WHERE sku = '70001'`],
    ['la cola de escaleras incoherentes',
      `SELECT sucursal, sku, d8_prima_caja_pct, venta_30d FROM ${MV}
        WHERE f8_veredicto = 'escalera_incoherente'
        ORDER BY venta_30d DESC NULLS LAST LIMIT 50`],
    ['el tablero por plaza',
      `SELECT sucursal, f8_veredicto, count(*)::int FROM ${MV} GROUP BY 1, 2`],
  ];
  let peor = 0; let peorN = '';
  for (const [n, sql] of CONSULTAS) {
    const t = Date.now();
    await knex.raw(sql);
    const ms = Date.now() - t;
    if (ms > peor) { peor = ms; peorN = n; }
    // eslint-disable-next-line no-console
    console.log(`  · [PR.S2.4] ${n.padEnd(36)} ${String(ms).padStart(5)} ms`);
  }

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.4] ${eq.filas.toLocaleString()} filas · ${eq.en_mv} columnas · `
    + `construida en ${(msBuild / 1000).toFixed(1)} s · peor consulta de pantalla ${peor} ms`);

  /**
   * ⭐ El gate es sobre la consulta que el consumidor CORRE, no sobre un barrido que nadie hace.
   *    Medido antes de materializar: 118,754 ms. Si esto no baja de 1 s, materializar no sirvio.
   */
  if (peor > 1000) {
    throw new Error(`[PR.S2.4] la peor consulta de pantalla ("${peorN}") tarda ${peor} ms: `
      + 'materializar no resolvio el problema que la justifica.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
