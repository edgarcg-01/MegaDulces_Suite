'use strict';
/**
 * `[RD.37]` — **La cuenta arranca en el PRIMER EMBARQUE. Se dejan de tirar $303,294 documentados.**
 *
 * Lo pidio Edgar: *"no puede existir tanta diferencia"*. Tenia razon, y una parte era nuestra.
 *
 * `[RD.30]` fijo `carga_desde = GREATEST(primer embarque, primera venta)`. La intencion era no
 * contar carga sin poder ver su venta; el efecto es que **el ledger descarta embarque que SI
 * esta documentado**. Medido el 2026-10-07 sobre las seis rutas de Padre Hidalgo:
 *
 *   ruta 21: 560 renglones · 5,841 uds · $113,566     ruta 26: 479 · 6,276 uds · $115,057
 *   ruta 23: 115 renglones · 1,076 uds ·  $18,669     ruta 27: 112 · 1,720 uds ·  $33,054
 *   ruta 22:  79 renglones ·   747 uds ·  $16,243     ruta 28:  36 ·   287 uds ·   $6,704
 *   ────────────────────────────────────────────────────────────── TOTAL  **$303,294**
 *
 * ── Lo que esto NO arregla, y hay que decirlo ───────────────────────────────────────────────
 *
 * Las ventas de esa ventana **no existen en ninguna fuente**: ni el push, ni la replica de la
 * sucursal, ni el ODS. Y no es que las rutas no vendieran: cargaron **6 dias distintos cada una,
 * a 1.11x y 1.18x de su ritmo normal** (21 y 26). Un camion que se abastece para arrancar carga
 * una o dos veces, fuerte; cargar seis dias al ritmo de siempre es estar operando.
 *
 * ⇒ Al sumar la carga sin sus ventas, **la 21 y la 26 se dan vuelta**: pasan de traer de mas a
 *   traer de menos. Eso es correcto y es informacion: el signo deja de ser decorativo.
 *       positivo = llego sin papel  ·  negativo = salio sin papel
 *
 * ⛔ **NO se estiman las ventas faltantes.** Cerrarian la cuenta a costa de inventar el numero
 *    que falta. El hueco se declara con lo medido: `v_rd_route_opening.dias_ciegos` ya dice
 *    cuantos dias lleva cada ruta sin una sola venta registrada al arranque.
 *
 * ⚠️ El saldo publicado NO cambia: sigue siendo lo que el camion declara. Lo unico que se mueve
 *    es de que esta hecho el residuo.
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';
const FOTO = 'analytics.v_rd_route_photo';

/** Los rotulos de un almacen de ruta, como dato (`[RD.30]`). */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = a.tenant_id AND x.warehouse_id = a.warehouse_id`;

exports.up = async function up(knex) {
  // ⛔ No se reescribe a ciegas: si otra sesion cambio el ledger, esta migracion lo revertiria
  //    en silencio. Se exige encontrar las marcas que dejo [RD.34].
  const { rows: [cur] } = await knex.raw(
    `SELECT pg_get_viewdef('${LEDGER}'::regclass, true) AS def`);
  for (const marca of ['v_rd_route_photo', 'pares AS', 'apertura AS']) {
    if (!cur.def.includes(marca)) {
      throw new Error(`[RD.37] el ledger no tiene la marca "${marca}" de [RD.34]/[RD.36]: otra sesion lo cambio. Parar y revisar.`);
    }
  }


  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH anclas AS (
      SELECT i.tenant_id, i.route_no, rc.count_date AS fecha,
             'conteo'::text AS origen, rc.id AS conteo_id, 2 AS prioridad
        FROM analytics.mv_rd_route_identity i
        JOIN commercial.route_counts rc
          ON rc.tenant_id = i.tenant_id AND rc.warehouse_id = i.warehouse_id
         AND rc.status = 'active' AND rc.deleted_at IS NULL
         AND rc.source <> 'kepler'
      UNION ALL
      SELECT p.tenant_id, p.route_no, p.foto_fecha,
             'foto'::text, NULL::uuid, 1
        FROM ${FOTO} p
       WHERE p.aceptada
       GROUP BY 1,2,3,4,5,6
    ), ancla AS (
      -- ⭐ La cuenta arranca en el PRIMER EMBARQUE, no en la primera venta. Ver la cabecera.
      SELECT i.tenant_id, i.route_no, i.suc_emisor, i.almacen_erp, i.warehouse_id,
             LEAST(i.carga_desde, coalesce(o.primer_embarque, i.carga_desde)) AS desde,
             a.fecha AS conteo_fecha, a.origen, a.conteo_id
        FROM analytics.mv_rd_route_identity i
        LEFT JOIN analytics.v_rd_route_opening o
          ON o.tenant_id = i.tenant_id AND o.route_no = i.route_no
        LEFT JOIN LATERAL (
             SELECT x.fecha, x.origen, x.conteo_id
               FROM anclas x
              WHERE x.tenant_id = i.tenant_id AND x.route_no = i.route_no
              ORDER BY x.fecha DESC, x.prioridad DESC
              LIMIT 1
        ) a ON true
    ), embarque AS (
      SELECT a.tenant_id, a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, upper(btrim(d.c11)) AS unidad,
             sum(d.c9::numeric)  AS qty,
             sum(d.c13::numeric) AS costo_doc
        FROM ancla a
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = a.suc_emisor AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 41
         AND h.c9::date >= a.desde
         AND h.c10 IN (${ROTULOS})
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','')
       GROUP BY 1,2,3,4,5
    ), apertura AS (
      -- El conteo fisico del almacen de la ruta, ANTERIOR a su arranque: lo que ya traia arriba.
      SELECT a.tenant_id, a.route_no, v.fecha AS business_date,
             btrim(v.sku) AS sku, upper(btrim(v.unidad_erp)) AS unidad,
             sum(CASE WHEN v.signo = 'faltante' THEN -v.cantidad ELSE v.cantidad END) AS qty,
             sum(CASE WHEN v.signo = 'faltante' THEN -v.importe  ELSE v.importe  END) AS costo_doc
        FROM ancla a
        JOIN analytics.mv_erp_physical_count_variance v
          ON v.kepler_sucursal = a.suc_emisor
         AND v.kepler_almacen  = a.almacen_erp
         AND v.fecha < a.desde
       WHERE a.almacen_erp IS NOT NULL
         AND coalesce(btrim(v.sku),'') <> '' AND coalesce(btrim(v.unidad_erp),'') <> ''
       GROUP BY 1,2,3,4,5
    ), carga AS (
      SELECT tenant_id, route_no, business_date, sku, unidad,
             sum(qty) AS qty, sum(costo_doc) AS costo_doc
        FROM (SELECT * FROM embarque UNION ALL SELECT * FROM apertura) u
       GROUP BY 1,2,3,4,5
    ), costo_erp AS (
      SELECT a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, upper(btrim(d.c11)) AS unidad,
             sum(d.c62::numeric) AS costo_erp
        FROM ancla a
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = a.suc_emisor AND h.c1 = a.almacen_erp
         AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4 = 10 AND h.c9::date >= a.desde
        JOIN kepler_ods.kdm2 d
          ON d.sucursal = h.sucursal AND d.c1 = h.c1 AND d.c2 = h.c2 AND d.c3 = h.c3
         AND d.c4 = h.c4 AND d.c5 = h.c5 AND d.c6 = h.c6
       WHERE a.almacen_erp IS NOT NULL AND nullif(btrim(d.c62),'') IS NOT NULL
       GROUP BY 1,2,3,4
    ), venta AS (
      SELECT p.tenant_id, a.route_no, p.business_date,
             btrim(p.sku) AS sku, upper(btrim(p.unidad)) AS unidad,
             sum(p.qty)     AS qty,
             sum(p.importe) AS venta_doc
        FROM ancla a
        JOIN analytics.route_push_lines p
          ON p.route_no = a.route_no AND p.tenant_id = a.tenant_id
         AND p.business_date >= a.desde
       WHERE coalesce(btrim(p.unidad),'') <> ''
       GROUP BY 1,2,3,4,5
    ), previo AS (
      SELECT a.tenant_id, a.route_no, m.sku, m.unidad, sum(m.q) AS saldo_previo
        FROM ancla a
        JOIN LATERAL (
             SELECT c.sku, c.unidad, c.qty AS q FROM carga c
              WHERE c.route_no = a.route_no AND c.business_date <= a.conteo_fecha
             UNION ALL
             SELECT v.sku, v.unidad, -v.qty FROM venta v
              WHERE v.route_no = a.route_no AND v.business_date <= a.conteo_fecha
        ) m ON true
       WHERE a.conteo_fecha IS NOT NULL
       GROUP BY 1,2,3,4
    ), contado AS (
      SELECT a.tenant_id, a.route_no, a.conteo_fecha,
             btrim(l.sku) AS sku, upper(btrim(l.unidad)) AS unidad,
             sum(l.qty) AS qty, max(l.costo_unitario) AS costo_unitario, sum(l.importe) AS importe
        FROM ancla a
        JOIN commercial.route_count_lines l
          ON l.tenant_id = a.tenant_id AND l.count_id = a.conteo_id
       WHERE a.origen = 'conteo'
       GROUP BY 1,2,3,4,5
      UNION ALL
      SELECT a.tenant_id, a.route_no, a.conteo_fecha,
             p.sku, p.unidad, p.qty, p.costo_unitario, p.importe
        FROM ancla a
        JOIN ${FOTO} p
          ON p.tenant_id = a.tenant_id AND p.route_no = a.route_no
         AND p.foto_fecha = a.conteo_fecha
       WHERE a.origen = 'foto'
    ), pares AS (
      SELECT tenant_id, route_no, conteo_fecha, sku, unidad FROM contado
      UNION
      SELECT p.tenant_id, p.route_no, a.conteo_fecha, p.sku, p.unidad
        FROM previo p
        JOIN ancla a ON a.tenant_id = p.tenant_id AND a.route_no = p.route_no
                    AND a.conteo_fecha IS NOT NULL
    ), conteo AS (
      SELECT pa.tenant_id, pa.route_no, pa.conteo_fecha AS business_date, pa.sku, pa.unidad,
             coalesce(c.qty,0) - coalesce(p.saldo_previo,0) AS qty,
             (coalesce(c.qty,0) - coalesce(p.saldo_previo,0))
               * coalesce(c.costo_unitario, c.importe / nullif(c.qty,0), 0) AS costo_doc
        FROM pares pa
        LEFT JOIN contado c
          ON c.tenant_id = pa.tenant_id AND c.route_no = pa.route_no
         AND c.sku = pa.sku AND c.unidad = pa.unidad
        LEFT JOIN previo p
          ON p.tenant_id = pa.tenant_id AND p.route_no = pa.route_no
         AND p.sku = pa.sku AND p.unidad = pa.unidad
       WHERE coalesce(c.qty,0) - coalesce(p.saldo_previo,0) <> 0
    )
    SELECT tenant_id, route_no, business_date, 'conteo'::text AS clase, sku, unidad,
           qty, costo_doc, NULL::numeric AS venta_doc, NULL::numeric AS costo_erp
      FROM conteo
    UNION ALL
    SELECT tenant_id, route_no, business_date, 'carga'::text, sku, unidad,
           qty, costo_doc, NULL::numeric, NULL::numeric
      FROM carga
    UNION ALL
    SELECT v.tenant_id, v.route_no, v.business_date, 'venta'::text, v.sku, v.unidad,
           v.qty, NULL::numeric, v.venta_doc, e.costo_erp
      FROM venta v
      LEFT JOIN costo_erp e
        ON e.route_no = v.route_no AND e.business_date = v.business_date
       AND e.sku = v.sku AND e.unidad = v.unidad
  `);
  await knex.raw(`ALTER VIEW ${LEDGER} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO dev_ro`);

  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    const t0 = Date.now();
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    console.log(`  . [RD.37] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── FRENOS ────────────────────────────────────────────────────────────────────────────────
  //
  // ⚠️ Los frenos NO comparan un antes contra un despues. El ODS es una fuente VIVA y las
  //    camionetas cargan mientras esto corre: el primer intento fallo porque la ruta 503 cargo
  //    1,124 uds entre el refresco de la migracion anterior y el de esta. Un delta contra una
  //    fuente que se mueve no mide lo que uno cree. Estos afirman sobre el RESULTADO.

  // 1. ⭐ El embarque que se tiraba ya ESTA en el ledger, y cuadra con lo que el ODS declara.
  const { rows: cuadre } = await knex.raw(`
    WITH esperado AS (
      SELECT i.route_no, round(sum(x.c9::numeric),2) uds
        FROM analytics.mv_rd_route_identity i
        JOIN analytics.v_rd_route_opening o ON o.route_no = i.route_no
        JOIN kepler_ods.kdm1 h ON h.sucursal = i.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
         AND h.c9::date >= o.primer_embarque AND h.c9::date < o.carga_desde
         AND h.c10 IN (SELECT m.dest_code FROM analytics.transfer_dest_map m
                        WHERE m.tenant_id = i.tenant_id AND m.warehouse_id = i.warehouse_id)
        JOIN kepler_ods.kdm2 x ON x.sucursal=h.sucursal AND x.c1=h.c1 AND x.c2=h.c2 AND x.c3=h.c3
         AND x.c4=h.c4 AND x.c5=h.c5 AND x.c6=h.c6
       WHERE coalesce(btrim(x.c11),'') NOT IN ('SER','')
       GROUP BY 1
    ), en_ledger AS (
      SELECT l.route_no, round(sum(l.qty),2) uds
        FROM analytics.mv_rd_route_ledger l
        JOIN analytics.v_rd_route_opening o ON o.route_no = l.route_no
       WHERE l.clase='carga' AND l.business_date >= o.primer_embarque
         AND l.business_date < o.carga_desde
       GROUP BY 1
    )
    SELECT e.route_no, e.uds::float ods, coalesce(g.uds,0)::float ledger
      FROM esperado e LEFT JOIN en_ledger g ON g.route_no = e.route_no ORDER BY 1`);
  if (!cuadre.length) {
    console.log('  . [RD.37] NO MEDIDO: ninguna ruta tenia embarque fuera de ventana');
  }
  for (const c of cuadre) {
    // El conteo de apertura de [RD.36] tambien cae en esta ventana en la ruta 28: el ledger
    // puede traer MAS que el ODS, nunca menos.
    if (Number(c.ledger) + 1 < Number(c.ods)) {
      throw new Error(`[RD.37] ruta ${c.route_no}: el ODS tiene ${c.ods} uds de embarque fuera de ventana y el ledger solo ${c.ledger}`);
    }
    console.log(`  . [RD.37] ruta ${c.route_no}: ${c.ods} uds de embarque recuperadas (ledger ${c.ledger})`);
  }

  // 2. ⭐ El ancla NO se movio: el saldo publicado sigue siendo lo que el camion declara.
  const { rows: anclas } = await knex.raw(`
    WITH f AS (SELECT route_no, round(sum(importe),2) declarado FROM ${FOTO} WHERE aceptada GROUP BY 1)
    SELECT f.route_no, f.declarado::float,
           round(coalesce(sum(u.saldo_qty * coalesce(u.costo_u,0)),0),2)::float publicado,
           count(*) FILTER (WHERE u.saldo_qty < 0)::int negativos
      FROM f LEFT JOIN analytics.mv_rd_route_unit_value u ON u.route_no = f.route_no
     GROUP BY f.route_no, f.declarado ORDER BY 1`);
  if (!anclas.length) throw new Error('[RD.37] se quedo sin rutas ancladas');
  for (const a of anclas) {
    if (Math.abs(a.publicado - a.declarado) > Math.max(1, Math.abs(a.declarado) * 0.005)) {
      throw new Error(`[RD.37] ruta ${a.route_no}: el ancla se rompio. declarado=${a.declarado} publicado=${a.publicado}`);
    }
    if (Number(a.negativos) > 0) {
      throw new Error(`[RD.37] ruta ${a.route_no}: aparecieron ${a.negativos} pares en negativo`);
    }
  }
  console.log(`  . [RD.37] el ancla sigue firme en ${anclas.length} rutas, 0 negativos`);

  // 3. PRUEBA NEGATIVA, sobre el resultado: una ruta SIN ventana ciega no puede tener carga
  //    anterior a su arranque -- salvo su conteo de apertura, que es legitimo ([RD.36]).
  const { rows: [fuga] } = await knex.raw(`
    SELECT count(*)::int n
      FROM analytics.mv_rd_route_ledger l
      JOIN analytics.v_rd_route_opening o ON o.route_no = l.route_no
     WHERE l.clase = 'carga' AND o.dias_ciegos = 0 AND l.business_date < o.carga_desde
       AND NOT EXISTS (
         SELECT 1 FROM analytics.mv_erp_physical_count_variance v
           JOIN analytics.mv_rd_route_identity i
             ON i.suc_emisor = v.kepler_sucursal AND i.almacen_erp = v.kepler_almacen
          WHERE i.route_no = l.route_no AND v.fecha = l.business_date)`);
  if (Number(fuga.n) > 0) {
    throw new Error(`[RD.37] ${fuga.n} renglones de carga previos al arranque en rutas sin ventana ciega`);
  }
  console.log('  . [RD.37] prueba negativa OK: sin ventana ciega no hay carga anterior al arranque');

  // 4. El residuo cambia de composicion -- se DECLARA, no se juzga.
  const { rows: resid } = await knex.raw(`
    SELECT l.route_no, round(sum(l.qty) FILTER (WHERE l.clase='conteo'),0)::float uds, o.dias_ciegos
      FROM analytics.mv_rd_route_ledger l
      JOIN analytics.v_rd_route_opening o ON o.route_no = l.route_no
     GROUP BY l.route_no, o.dias_ciegos ORDER BY 1`);
  for (const r of resid) {
    if (r.uds === null) continue;
    const s = Number(r.uds) >= 0 ? 'llego sin papel' : 'SALIO sin papel';
    const nota = Number(r.dias_ciegos) > 0
      ? ` (${r.dias_ciegos} dias al arranque sin una sola venta registrada)` : '';
    console.log(`  . [RD.37] ruta ${r.route_no}: ${Math.round(Number(r.uds))} uds ${s}${nota}`);
  }
};

exports.down = async function down() {
  throw new Error('[RD.37] no tiene reversa automatica: volver vuelve a descartar 303,294 pesos de embarque documentado');
};
