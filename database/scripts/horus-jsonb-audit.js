/* eslint-disable no-console */
/**
 * Horus 360 — Paso 0: auditoría de población del JSONB `exhibiciones[]` (read-only).
 *
 * Mide qué campos del registro de exhibición están realmente poblados, para decidir
 * QUÉ se puede integrar a Horus sin inventar (regla: no diseñar sobre datos que no
 * existen). Cubre los campos que Horus HOY ignora: conceptoId, ubicacionId,
 * nivelEjecucionId, rangoCompra, ventaAdicional, puntuacionCalculada.
 *
 * Conexión: knexfile-newdb.development (mismo DB local que los smokes — DATABASE_URL_NEW,
 * NO DATABASE_URL que apunta a legacy prod) + search_path para resolver daily_captures.
 *
 * Uso: node database/scripts/horus-jsonb-audit.js
 */
const cfg = require('../knexfile-newdb.js').development;

const knex = require('knex')({
  client: 'pg',
  connection: cfg.connection,
  pool: {
    min: 1,
    max: 2,
    afterCreate: (conn, done) => {
      conn.query(
        'SET search_path TO trade, field_ops, identity, catalog, scoring, commercial, public',
        (err) => done(err, conn),
      );
    },
  },
});

const pct = (n, d) => (Number(d) > 0 ? `${((Number(n) / Number(d)) * 100).toFixed(1)}%` : 'n/a');
const out = (label, val) => console.log(`  ${label.padEnd(46)} ${val}`);

async function main() {
  // Población de campos del JSONB a nivel exhibición (30d).
  const e = (
    await knex.raw(`
    WITH ex AS (
      SELECT jsonb_array_elements(
               CASE WHEN jsonb_typeof(dc.exhibiciones) = 'array' THEN dc.exhibiciones ELSE '[]'::jsonb END
             ) AS x
      FROM daily_captures dc
      WHERE dc.hora_inicio >= now() - interval '30 days'
    )
    SELECT
      count(*)                                                                          AS exhibiciones,
      count(*) FILTER (WHERE x->>'conceptoId'      IS NOT NULL AND x->>'conceptoId'      <> '') AS with_concepto,
      count(*) FILTER (WHERE x->>'ubicacionId'     IS NOT NULL AND x->>'ubicacionId'     <> '') AS with_ubicacion,
      count(*) FILTER (WHERE x->>'nivelEjecucionId' IS NOT NULL AND x->>'nivelEjecucionId' <> '') AS with_nivel_id,
      count(*) FILTER (WHERE x->>'nivelEjecucion'  IS NOT NULL AND x->>'nivelEjecucion'  <> '') AS with_nivel_txt,
      count(*) FILTER (WHERE x->>'rangoCompra'     IS NOT NULL AND x->>'rangoCompra'     <> '') AS with_rango,
      count(*) FILTER (WHERE x->>'ventaAdicional'  IS NOT NULL)                          AS with_venta_key,
      count(*) FILTER (WHERE x->>'ventaAdicional' ~ '^[0-9]+(\\.[0-9]+)?$'
                         AND (x->>'ventaAdicional')::numeric > 0)                        AS with_venta_pos,
      count(*) FILTER (WHERE x->>'puntuacionCalculada' IS NOT NULL)                      AS with_punt,
      count(*) FILTER (WHERE jsonb_typeof(x->'productosMarcados') = 'array'
                         AND jsonb_array_length(x->'productosMarcados') > 0)             AS with_products,
      count(DISTINCT x->>'conceptoId')                                                   AS distinct_conceptos,
      count(DISTINCT x->>'ubicacionId')                                                  AS distinct_ubicaciones,
      COALESCE(SUM(CASE WHEN x->>'ventaAdicional' ~ '^[0-9]+(\\.[0-9]+)?$'
                        THEN (x->>'ventaAdicional')::numeric ELSE 0 END), 0)             AS venta_sum
    FROM ex
  `)
  ).rows[0];

  console.log('\n=== exhibiciones[] (30d) — población de campos que Horus HOY ignora ===');
  out('Exhibiciones totales', e.exhibiciones);
  out('conceptoId (tipo de exhibidor)', `${e.with_concepto} (${pct(e.with_concepto, e.exhibiciones)}) · distintos: ${e.distinct_conceptos}`);
  out('ubicacionId (posición)', `${e.with_ubicacion} (${pct(e.with_ubicacion, e.exhibiciones)}) · distintos: ${e.distinct_ubicaciones}`);
  out('nivelEjecucionId (UUID catálogo)', `${e.with_nivel_id} (${pct(e.with_nivel_id, e.exhibiciones)})`);
  out('nivelEjecucion (texto)', `${e.with_nivel_txt} (${pct(e.with_nivel_txt, e.exhibiciones)})`);
  out('rangoCompra', `${e.with_rango} (${pct(e.with_rango, e.exhibiciones)})`);
  out('ventaAdicional (key presente)', `${e.with_venta_key} (${pct(e.with_venta_key, e.exhibiciones)})`);
  out('ventaAdicional > 0', `${e.with_venta_pos} (${pct(e.with_venta_pos, e.exhibiciones)}) · suma $${Number(e.venta_sum).toFixed(0)}`);
  out('puntuacionCalculada', `${e.with_punt} (${pct(e.with_punt, e.exhibiciones)})`);
  out('productosMarcados (no vacío)', `${e.with_products} (${pct(e.with_products, e.exhibiciones)})`);

  // Top conceptos / ubicaciones por frecuencia (para dimensionar el desglose K1).
  const topConcepts = (
    await knex.raw(`
    SELECT x->>'conceptoId' AS id, count(*) AS n
    FROM daily_captures dc, jsonb_array_elements(
           CASE WHEN jsonb_typeof(dc.exhibiciones) = 'array' THEN dc.exhibiciones ELSE '[]'::jsonb END) x
    WHERE dc.hora_inicio >= now() - interval '30 days' AND x->>'conceptoId' IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8
  `)
  ).rows;
  console.log('\n=== Top conceptoId (30d) — cuántos buckets reales hay para K1 ===');
  topConcepts.forEach((r) => out(`  concepto ${r.id}`, `${r.n} exhibiciones`));

  // ¿planograma cargado? (para K4)
  const plano = (await knex.raw(`SELECT count(*) AS n, count(DISTINCT categoria_exhibicion) AS cats FROM trade.planogram_skus WHERE deleted_at IS NULL`)).rows[0];
  console.log('\n=== trade.planogram_skus (para K4) ===');
  out('SKUs en planograma', `${plano.n} · categorías: ${plano.cats}`);

  // ¿productosMarcados referencia product_id de catalog.products / planogram? (mapeo K4)
  const sampleProd = (
    await knex.raw(`
    SELECT x->'productosMarcados' AS pm
    FROM daily_captures dc, jsonb_array_elements(
           CASE WHEN jsonb_typeof(dc.exhibiciones) = 'array' THEN dc.exhibiciones ELSE '[]'::jsonb END) x
    WHERE dc.hora_inicio >= now() - interval '60 days'
      AND jsonb_typeof(x->'productosMarcados') = 'array'
      AND jsonb_array_length(x->'productosMarcados') > 0
    LIMIT 3
  `)
  ).rows;
  console.log('\n=== Muestra productosMarcados (formato del PID, para mapear a planograma K4) ===');
  sampleProd.forEach((r, i) => out(`  muestra ${i + 1}`, JSON.stringify(r.pm).slice(0, 120)));

  console.log('\n(read-only; no se escribió nada)\n');
  await knex.destroy();
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  knex.destroy().finally(() => process.exit(1));
});
