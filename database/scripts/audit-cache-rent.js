/* eslint-disable no-console */
/**
 * `[CPU.5]` ¿Cada caché se gana el sueldo? — la renta de las matvistas, medida.
 *
 * ── DE DÓNDE SALE ESTO ──────────────────────────────────────────────────────────────────────
 * De una pregunta de una sola línea: *"¿por qué un ODS necesita refrescarse?"*. Y la respuesta es
 * que **no lo necesita** — `kepler_ods.*` se alimenta por replicación, la fila llega cuando
 * cambia. Lo que se refresca es la capa DERIVADA de encima, y cada matvista de esa capa es una
 * apuesta: se paga un costo fijo de refresco para ahorrar un costo variable de lectura.
 *
 * Nadie vuelve a mirar esa apuesta después de hacerla. Medido en prod el 2026-09-28, **cuatro de
 * nueve matvistas costaban más que no tenerlas**:
 *
 *   mv_caja_movimientos       5,388 refrescos / 27,772 s   para     220 lecturas de la app
 *   mv_warehouse_box_factor   1,081 refrescos /  6,584 s   para   1,095 lecturas
 *   mv_rd_route_daily_200d      183 refrescos /  4,114 s   para      83 lecturas
 *   mv_unit_truth               138 refrescos /  1,273 s   para      84 lecturas
 *
 * La de caja es el caso puro: **24 refrescos por cada lectura**, y las otras 11,065 consultas
 * contra ella son del PROPIO refrescador mirándose al espejo (su conteo y su firma de NOTIFY).
 *
 * ⭐ Y ninguna se creó por descuido. Cada una nació de una medición CORRECTA por consulta
 * —"415 ms → 0.4 ms, 1,085× menos"— a la que le faltó **el denominador**: ser 1,085× más rápido
 * en algo que hacés 220 veces, pagado con algo que hacés 5,388 veces, es un mal negocio aunque
 * los dos términos estén bien medidos. Este script existe para que el denominador no falte.
 *
 * ── CÓMO LEER LA SALIDA ─────────────────────────────────────────────────────────────────────
 * `refrescos_por_lectura` es la señal. Por encima de ~1 conviene mirar; por encima de ~10 la
 * caché casi seguro es pasivo. Pero el veredicto NO se puede automatizar del todo:
 *
 * ⚠️ `seg_leyendo` es lo que cuestan las lecturas **CON** la caché. El contrafáctico —lo que
 * costarían leyendo en vivo— hay que medirlo a mano, una vez por matvista:
 *
 *     \timing on
 *     SELECT count(*) FROM <la vista viva de la que la matvista es copia>;
 *
 * y recién entonces comparar `lecturas × costo_vivo` contra `seg_refrescando`. Sin ese número no
 * hay veredicto, hay sospecha — y publicar una sospecha como si fuera medición es el defecto que
 * este script combate.
 *
 * ⚠️ `pg_stat_statements` es acumulativo desde su último reset y tiene tope (`max`), así que una
 * matvista con pocas lecturas puede ser una muestra chica, no un desperdicio. Se declara en la
 * salida en vez de suponerse.
 *
 *   node database/scripts/audit-cache-rent.js
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const MIN_SEG = Number(process.env.CACHE_RENT_MIN_SEG || 60);

const SQL = `
WITH mv AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS nombre, c.relname AS corto
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm'
), dep AS (
  -- ⛔ SIN ESTO EL RESULTADO MIENTE. Una pantalla puede leer la matvista A TRAVÉS de una vista
  -- que no la nombra: así es la bandeja de caja, que lee \`finance.v_caja_movimientos_pendientes\`.
  -- Contando sólo el nombre de la matvista, esa caché parece no tener un solo lector.
  SELECT m.nombre AS mv, dn.nspname || '.' || dc.relname AS consumidor
    FROM mv m
    JOIN pg_depend d  ON d.refobjid = m.oid
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class dc  ON dc.oid = r.ev_class
    JOIN pg_namespace dn ON dn.oid = dc.relnamespace
   WHERE dc.oid <> m.oid
), patrones AS (
  SELECT nombre AS mv, corto AS patron FROM mv
  UNION
  SELECT mv, split_part(consumidor, '.', 2) FROM dep
), refresco AS (
  SELECT m.nombre AS mv, sum(s.calls)::bigint AS veces,
         round((sum(s.total_exec_time) / 1000)::numeric) AS seg
    FROM mv m JOIN pg_stat_statements s
      ON s.query ILIKE 'REFRESH MATERIALIZED VIEW%' AND s.query ILIKE '%' || m.corto || '%'
   GROUP BY 1
), lectura AS (
  SELECT p.mv, sum(s.calls)::bigint AS veces,
         round((sum(s.total_exec_time) / 1000)::numeric, 1) AS seg
    FROM (SELECT DISTINCT mv, patron FROM patrones) p
    JOIN pg_stat_statements s ON s.query ILIKE '%' || p.patron || '%'
   WHERE s.query NOT ILIKE 'REFRESH MATERIALIZED VIEW%'
     AND s.query NOT ILIKE 'ANALYZE%'
   GROUP BY 1
)
SELECT r.mv,
       r.veces AS refrescos, r.seg AS seg_refrescando,
       coalesce(l.veces, 0) AS lecturas, coalesce(l.seg, 0) AS seg_leyendo,
       CASE WHEN coalesce(l.veces, 0) = 0 THEN NULL
            ELSE round(r.veces::numeric / l.veces, 1) END AS por_lectura
  FROM refresco r LEFT JOIN lectura l ON l.mv = r.mv
 WHERE r.seg >= $1
 ORDER BY r.seg DESC`;

(async () => {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('falta DATABASE_URL_NEW');
  const c = new Client({
    connectionString: cs,
    ssl: cs.includes('localhost') || cs.includes('pg-prod') ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await c.connect();
  try {
    // ⚠️ `::text` en los DOS: `node-postgres` devuelve el `interval` como objeto y el timestamp
    // con la zona del proceso, así que sin esto la cabecera imprime `[object Object]` — y una
    // ventana que no se puede leer vuelve ilegibles todos los números de abajo.
    const ventana = await c.query(
      `SELECT stats_reset::text AS desde_cuando, (now() - stats_reset)::text AS hace
         FROM pg_stat_statements_info`).catch(() => null);
    const r = await c.query(SQL, [MIN_SEG]);

    if (ventana && ventana.rows[0]) {
      console.log(`\nVentana de pg_stat_statements: desde ${ventana.rows[0].desde_cuando} (hace ${ventana.rows[0].hace})`);
    }
    console.log(`Matvistas con más de ${MIN_SEG}s de refresco acumulado:\n`);
    const f = (n) => String(n).padStart(9);
    console.log(`  ${'matvista'.padEnd(36)}${f('refrescos')}${f('seg refr')}${f('lecturas')}${f('seg leer')}${f('x lect')}`);
    for (const x of r.rows) {
      console.log(`  ${x.mv.padEnd(36)}${f(x.refrescos)}${f(x.seg_refrescando)}${f(x.lecturas)}${f(x.seg_leyendo)}${f(x.por_lectura ?? '—')}`);
    }

    // ⚠️ El aviso va SIEMPRE, no sólo cuando hay sospechosas: una tabla sin sospechosas se lee
    // como "todo está bien" y lo que en realidad dice es "ninguna pasó el filtro con ESTE método".
    console.log(`
  Para cerrar el veredicto falta el contrafáctico, que este script NO puede medir solo:
  cronometrá la vista viva de la que cada matvista es copia y compará

      lecturas x costo_vivo   contra   seg_refrescando

  Si la primera es menor, la cache es pasivo. 'x lect' > 10 es sospecha fuerte, no veredicto.
  Y 0 lecturas puede ser una muestra chica (pantalla poco usada en la ventana), no desperdicio.`);
  } finally {
    await c.end().catch(() => {});
  }
})().catch((e) => { console.error('falló:', e.message); process.exitCode = 1; });
