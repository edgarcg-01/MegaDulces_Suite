#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * [IC.10] El roll-forward entre conteos — y el árbitro que lo hace falsable.
 *
 * La vista contesta "a dónde se fue la mercancía": lo contado en el conteo anterior, más lo que
 * entró, menos lo que salió, contra lo contado en el conteo siguiente. Lo que los movimientos no
 * explican es la merma real del período.
 *
 * ⭐ Lo que este candado vigila NO es que la vista devuelva filas, es que la FÓRMULA siga siendo
 * la correcta. Los doctypes no se eligieron por criterio: se arbitraron contra un hecho
 * independiente —la existencia de HOY— agregando uno por uno y quedándose sólo con los que SUBEN
 * el porcentaje de SKUs exactos. Si mañana alguien agrega o quita un doctype "porque tiene
 * sentido", este test se lo dice con un número.
 *
 * ⛔ Y trae su PRUEBA NEGATIVA, que es lo que separa un árbitro de un espejo (ADR-059 regla 5):
 * cambiar `U-D-10` por `U-D-6` tiene que BAJAR el porcentaje. Si no baja, el árbitro no está
 * midiendo nada y el verde no significa nada.
 *
 * Corre contra `DATABASE_URL_NEW` en SOLO LECTURA.
 */
'use strict';
const { Client } = require('pg');
require('dotenv').config();

let ok = 0, fail = 0, nomedido = 0;
const t = (nombre, cond, detalle) => {
  if (cond === null) { nomedido++; console.log(`  ⚠️  NO MEDIDO  ${nombre}${detalle ? ' — ' + detalle : ''}`); return; }
  if (cond) { ok++; console.log(`  ✓ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
  else { fail++; console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
};

const J = 'l.sucursal=m.sucursal AND l.c1=m.c1 AND l.c2=m.c2 AND l.c3=m.c3 '
  + 'AND l.c4=m.c4 AND l.c5=m.c5 AND l.c6=m.c6';
const ANTI = "(m.c1=m.sucursal OR m.c1 LIKE m.sucursal||'-%')";

/** El árbitro: ¿desde el último conteo, los movimientos llevan a la existencia de hoy? */
async function arbitrar(c, suc, code, fecha, venta, entrada) {
  const { rows } = await c.query(`
    WITH capt AS (
      SELECT btrim(l.c8) AS sku, sum(l.c9::numeric) AS contado
        FROM kepler_ods.kdm1 m JOIN kepler_ods.kdm2 l ON ${J}
       WHERE m.sucursal = $1 AND m.c9::date = $2::date
         AND m.c2='N' AND m.c3='A' AND m.c4::int = 45 AND ${ANTI}
       GROUP BY 1 HAVING sum(l.c9::numeric) > 0),
    mov AS (
      SELECT btrim(l.c8) AS sku,
             sum(l.c9::numeric) FILTER (WHERE m.c2||'-'||m.c3||'-'||m.c4 = ANY($3)) AS entro,
             sum(l.c9::numeric) FILTER (WHERE m.c2||'-'||m.c3||'-'||m.c4 = ANY($4)) AS salio
        FROM kepler_ods.kdm1 m JOIN kepler_ods.kdm2 l ON ${J}
       WHERE m.sucursal = $1 AND m.c9::date > $2::date AND ${ANTI}
       GROUP BY 1),
    hoy AS (
      SELECT p.sku, sum(s.qty_stock_units) AS q
        FROM analytics.v_erp_stock_on_hand s
        JOIN catalog.products p ON p.id = s.product_id
        JOIN commercial.warehouses w ON w.id = s.warehouse_id
       WHERE w.code = $5 GROUP BY 1)
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE abs(h.q - (c.contado + COALESCE(mv.entro,0) - COALESCE(mv.salio,0))) < 0.01)::int AS exactos
      FROM capt c JOIN hoy h ON h.sku = c.sku LEFT JOIN mov mv ON mv.sku = c.sku`,
  [suc, fecha, entrada, venta, code]);
  const r = rows[0];
  return { n: r.n, exactos: r.exactos, pct: r.n ? (r.exactos / r.n) * 100 : null };
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await c.connect();
  await c.query("SET statement_timeout='170s'");
  console.log('\n════ [IC.10] Roll-forward entre conteos ════\n');

  // ── 1. La matview existe, servible y con su índice único ─────────────────────────────
  const [meta] = (await c.query(`
    SELECT to_regclass('analytics.mv_erp_count_rollforward') IS NOT NULL AS existe,
           has_table_privilege('app_runtime','analytics.mv_erp_count_rollforward','SELECT') AS grant_ok,
           (SELECT count(*)::int FROM pg_indexes
             WHERE schemaname='analytics' AND tablename='mv_erp_count_rollforward') AS indices`)).rows;
  t('la matview existe, con GRANT a app_runtime y sus índices',
    meta.existe && meta.grant_ok && meta.indices >= 2,
    `existe=${meta.existe} grant=${meta.grant_ok} índices=${meta.indices}`);
  if (!meta.existe) {
    console.log('\n  ⛔ Sin la matview no hay nada más que medir.\n');
    await c.end(); process.exit(1);
  }

  // ⛔ Una MATVIEW no soporta RLS: si alguien la "arregla" agregando una policy, no va a fallar
  // — va a no hacer nada. El servicio DEBE filtrar por tenant a mano, y eso se verifica en el
  // test del servicio; acá sólo se comprueba que la columna exista para poder filtrar.
  // ⚠️ `information_schema.columns` NO lista matviews (son relkind='m'; el estándar SQL sólo
  // cubre tablas y vistas ordinarias). Preguntarle por una devuelve CERO filas, que se lee
  // igual que "no tiene la columna" — esta aserción falló por eso la primera vez. Va por
  // `pg_attribute`, que sí las ve.
  const [col] = (await c.query(`
    SELECT count(*) FILTER (WHERE a.attname='tenant_id')::int AS tiene_tenant,
           count(*)::int AS columnas
      FROM pg_attribute a
     WHERE a.attrelid = 'analytics.mv_erp_count_rollforward'::regclass
       AND a.attnum > 0 AND NOT a.attisdropped`)).rows;
  t('lleva tenant_id como columna (una matview no puede tener RLS)',
    col.tiene_tenant === 1, `${col.columnas} columnas`);

  // ── 2. La partición de veredictos ────────────────────────────────────────────────────
  const [v] = (await c.query(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE veredicto NOT IN ('cuadra','merma','sobrante','no_recontado'))::int AS raros,
           count(*) FILTER (WHERE veredicto='no_recontado' AND no_explicado IS NOT NULL)::int AS mal_null,
           count(*) FILTER (WHERE veredicto='cuadra')::int AS cuadra,
           count(*) FILTER (WHERE veredicto='merma')::int AS merma,
           count(*) FILTER (WHERE veredicto='sobrante')::int AS sobrante,
           count(*) FILTER (WHERE veredicto='no_recontado')::int AS no_recontado,
           count(DISTINCT (warehouse_code, desde, hasta))::int AS pares,
           count(DISTINCT warehouse_code)::int AS almacenes
      FROM analytics.mv_erp_count_rollforward`)).rows;
  t('trae filas', v.filas > 0, `${v.filas} filas · ${v.pares} pares · ${v.almacenes} almacenes`);
  t('el veredicto sólo toma los cuatro valores declarados', v.raros === 0, `${v.raros} raros`);
  t('⛔ un SKU que NO se volvió a contar tiene no_explicado NULL, nunca 0',
    v.mal_null === 0,
    `${v.no_recontado} sin recontar, ${v.mal_null} publicarían un número inventado`);
  t('los cuatro veredictos suman el total',
    v.cuadra + v.merma + v.sobrante + v.no_recontado === v.filas,
    `${v.cuadra} cuadra · ${v.merma} merma · ${v.sobrante} sobrante · ${v.no_recontado} sin recontar`);

  // ── 3. ⭐ EL ÁRBITRO, por almacén ────────────────────────────────────────────────────
  const VENTA = ['U-D-10', 'U-D-41'];
  const ENTRADA = ['X-A-20', 'U-A-50'];
  const ultimos = (await c.query(`
    SELECT DISTINCT ON (kepler_sucursal) kepler_sucursal AS suc, warehouse_code AS code,
           hasta::text AS fecha
      FROM analytics.mv_erp_count_rollforward
     ORDER BY kepler_sucursal, hasta DESC`)).rows;

  const medidos = [];
  for (const u of ultimos) {
    const r = await arbitrar(c, u.suc, u.code, u.fecha, VENTA, ENTRADA);
    medidos.push({ ...u, ...r });
  }
  const bajos = medidos.filter((m) => m.pct !== null && m.pct < 85);
  t('⭐ la fórmula llega a la existencia de HOY en ≥85% de los SKUs, por almacén',
    bajos.length === 0,
    medidos.map((m) => `${m.code}:${m.pct === null ? 'sin datos' : m.pct.toFixed(0) + '%'}`).join(' · '));

  // ── 4. ⛔ LA PRUEBA NEGATIVA — sin esto el árbitro es un espejo ──────────────────────
  const peor = { venta: ['U-D-6', 'U-D-41'], entrada: ['X-A-40', 'U-A-50'] };
  const control = [];
  for (const u of ultimos) {
    const r = await arbitrar(c, u.suc, u.code, u.fecha, peor.venta, peor.entrada);
    control.push({ code: u.code, pct: r.pct });
  }
  const buenoProm = medidos.filter((m) => m.pct !== null).reduce((a, m) => a + m.pct, 0)
    / Math.max(1, medidos.filter((m) => m.pct !== null).length);
  const peorProm = control.filter((m) => m.pct !== null).reduce((a, m) => a + m.pct, 0)
    / Math.max(1, control.filter((m) => m.pct !== null).length);
  t('⛔ PRUEBA NEGATIVA: cambiar U-D-10 por U-D-6 BAJA el acierto (si no baja, no es árbitro)',
    peorProm < buenoProm - 5,
    `elegida ${buenoProm.toFixed(0)}% contra alternativa ${peorProm.toFixed(0)}%`);

  // ── 5. Lo que NO se puede comparar, declarado ───────────────────────────────────────
  //
  // ⛔ Un almacén que desaparece de una matview se lee como "no tiene problema". Padre Hidalgo
  // tiene DOS capturas pero en almacenes distintos (`01` la tienda y `01-006` la Ruta 28), así
  // que no forman par: compararlos sería mezclar una tienda con una ruta. Morelia 07 y 08 tienen
  // una sola captura cada uno. Los tres quedan fuera con razón, y la pantalla tiene que decirlo.
  const fuera = (await c.query(`
    SELECT w.code, w.name FROM commercial.warehouses w
     WHERE w.kepler_code IS NOT NULL AND w.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM analytics.mv_erp_count_rollforward r
                        WHERE r.warehouse_id = w.id)
     ORDER BY w.code`)).rows;
  t('los almacenes SIN par se pueden enumerar para declararlos en pantalla',
    true,
    fuera.length ? fuera.map((f) => `${f.code} ${f.name}`).join(' · ') : 'ninguno: todos tienen par');

  // ── 6. La identidad aritmética, fila por fila ──────────────────────────────────────
  const [id] = (await c.query(`
    SELECT count(*) FILTER (WHERE abs(esperado
             - (contado_inicio + compras + recibido - vendido - enviado)) > 0.01)::int AS mal,
           count(*) FILTER (WHERE contado_fin IS NOT NULL
             AND abs(no_explicado - (contado_fin - esperado)) > 0.01)::int AS mal2
      FROM analytics.mv_erp_count_rollforward`)).rows;
  t('esperado = inicio + compras + recibido − vendido − enviado, en TODAS las filas',
    id.mal === 0, `${id.mal} filas no cierran`);
  t('no_explicado = contado_fin − esperado, en todas las que se recontaron',
    id.mal2 === 0, `${id.mal2} filas no cierran`);

  // ── 7. La pantalla se abre o no se usa ─────────────────────────────────────────────
  const [wh] = (await c.query(
    'SELECT warehouse_id, hasta FROM analytics.mv_erp_count_rollforward LIMIT 1')).rows;
  const Q = `SELECT * FROM analytics.mv_erp_count_rollforward
              WHERE warehouse_id = $1 AND hasta = $2
              ORDER BY abs(COALESCE(importe_no_explicado,0)) DESC LIMIT 100`;
  await c.query(Q, [wh.warehouse_id, wh.hasta]);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now(); await c.query(Q, [wh.warehouse_id, wh.hasta]);
    best = Math.min(best, Date.now() - t0);
  }
  t('leer un par responde por debajo de 1 s', best < 1000, `${best} ms, mejor de 3`);

  await c.end();
  console.log(`\n${ok} ✓ / ${fail} ✗${nomedido ? ` / ${nomedido} ⚠️ NO MEDIDO` : ''}\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
