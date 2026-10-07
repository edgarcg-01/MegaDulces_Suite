'use strict';
/**
 * `[RD.34]` — **La foto de existencia se LEE donde vive. Se retira el importer.**
 *
 * ⭐ REGLA PRINCIPAL del proyecto: cero importers. `import-route-stock.js` copiaba
 * `mart.existencias_ruta` (runner) -> `commercial.route_counts` (prod) y habia que agendarlo.
 * Un importer que deja de correr no falla: deja la tabla vieja y nadie se entera. Es como
 * `analytics.customer_receivables` termino vacia en prod en la Fase CXC.
 *
 * ── Lo que hizo facil esto, medido el 2026-10-06 ────────────────────────────────────────────
 *
 * Los dos Postgres viven en el MISMO cluster k3s, namespace `prod`:
 *   · `pg-prod`     -> la plataforma (`railway`)
 *   · `pgvector-md` -> el runner (`kepler_consolidado`, el que afuera se ve como :5433)
 * asi que la tabla foranea ni sale del cluster. `postgres_fdw` YA estaba instalado (1.2) y no
 * habia ni un servidor foraneo definido en toda la base.
 *
 * ⛔ REQUISITO: `runner.existencias_ruta` la provisiona `FDW-RUNNER.sh` (rol de solo lectura +
 *    servidor + mapeo). NO va aca porque el mapeo lleva contrasena y este repo es PUBLICO.
 *    Esta migracion falla a proposito si no existe, en vez de seguir sin el dato.
 *
 * ── El piso de empalme, y por que NO se mide contra el ledger ───────────────────────────────
 *
 * El importer se negaba a escribir una foto con menos del 50 % de empalme. Eso es lo unico que
 * impidio que la ruta 27 anclara su inventario en **$596,312,276** (4,200 productos, 18.9 % de
 * empalme) el 2026-10-06. El piso no se puede perder.
 *
 * ⚠️ Pero medirlo contra el ledger seria CIRCULAR: el ledger consume la foto. Se mide contra
 *    `analytics.route_push_lines` (el historial de ventas de esa ruta), que no depende del ancla.
 *    Medido antes de elegirlo -- el vocabulario de ventas da entre 2.5 y 14.0 pp menos que el del
 *    ledger completo, y aun asi el peor caso real queda en **83.8 %**, muy arriba del piso:
 *
 *      ruta  21: ledger 98.8 % · ventas 93.0 %     ruta 501: ledger 90.0 % · ventas 83.8 %
 *      ruta  22: ledger 100  % · ventas 86.0 %     ruta 504: ledger 93.6 % · ventas 85.7 %
 *
 * ⚠️ Una ruta sin historial de ventas suficiente NO se ancla y se DECLARA (`motivo`), en vez de
 *    rechazarse como si estuviera mal: no poder juzgar no es lo mismo que juzgar mal (ADR-056).
 *
 * ⚠️ `current_date` NO sirve para elegir la foto: los contenedores corren en UTC y a las 18:00 de
 *    Mexico ya es el dia siguiente alla. Se toma la ULTIMA fecha por camion.
 *
 * ⚠️ La vista de la foto va SIN `security_invoker` a proposito. Con invoker, cada rol que la lea
 *    necesitaria su propio mapeo de usuario del FDW; con las reglas del dueno, `app_runtime` lee
 *    sin que haya que darle acceso al servidor foraneo. No hay RLS que preservar: el runner no
 *    tiene tenant.
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';
const FOTO = 'analytics.v_rd_route_photo';
const PISO = 0.50;
const VOCAB_MIN = 50;

/** Los rotulos de un almacen de ruta, como dato (`[RD.30]`). */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = a.tenant_id AND x.warehouse_id = a.warehouse_id`;

exports.up = async function up(knex) {
  const { rows: [fdw] } = await knex.raw(`
    SELECT to_regclass('runner.existencias_ruta') IS NOT NULL AS hay`);
  if (!fdw.hay) {
    throw new Error(
      '[RD.34] falta la tabla foranea runner.existencias_ruta. ' +
      'Correr primero, en md: bash FDW-RUNNER.sh ' +
      '(crea el rol de solo lectura en el runner, el servidor foraneo y el mapeo).');
  }

  // ── La foto, derivada: ultima por camion, con su empalme y su veredicto ───────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${FOTO} AS
    WITH ruta AS (
      SELECT i.tenant_id, i.route_no, i.warehouse_id, 'ruta_' || i.route_no AS truck
        FROM analytics.mv_rd_route_identity i
    ), ultima AS (
      SELECT r.tenant_id, r.route_no, r.warehouse_id, max(f.fecha) AS foto_fecha
        FROM ruta r
        JOIN runner.existencias_ruta f ON f.truck = r.truck
       GROUP BY 1,2,3
    ), lineas AS (
      SELECT u.tenant_id, u.route_no, u.warehouse_id, u.foto_fecha,
             btrim(f.sku)              AS sku,
             upper(btrim(f.unidad))    AS unidad,
             sum(f.existencia)         AS qty,
             max(f.costo)              AS costo_unitario,
             sum(f.importe)            AS importe
        FROM ultima u
        JOIN runner.existencias_ruta f
          ON f.truck = 'ruta_' || u.route_no AND f.fecha = u.foto_fecha
       WHERE f.existencia > 0
         AND coalesce(btrim(f.sku),'') <> '' AND coalesce(btrim(f.unidad),'') <> ''
       GROUP BY 1,2,3,4,5,6
    ), vocab AS (
      -- El vocabulario de la ruta SIN pasar por el ancla: lo que esa ruta ya vendio alguna vez.
      SELECT p.tenant_id, p.route_no, btrim(p.sku) AS sku, upper(btrim(p.unidad)) AS unidad
        FROM analytics.route_push_lines p
       WHERE coalesce(btrim(p.unidad),'') <> ''
       GROUP BY 1,2,3,4
    ), vtam AS (
      SELECT tenant_id, route_no, count(*) AS pares_vocab FROM vocab GROUP BY 1,2
    ), emp AS (
      SELECT l.tenant_id, l.route_no, l.foto_fecha,
             count(*)::int AS pares,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM vocab v
                WHERE v.tenant_id = l.tenant_id AND v.route_no = l.route_no
                  AND v.sku = l.sku AND v.unidad = l.unidad))::int AS empalman
        FROM lineas l
       GROUP BY 1,2,3
    )
    SELECT l.tenant_id, l.route_no, l.warehouse_id, l.foto_fecha,
           l.sku, l.unidad, l.qty, l.costo_unitario, l.importe,
           e.pares, e.empalman,
           round(e.empalman::numeric / nullif(e.pares,0), 4) AS empalme,
           coalesce(t.pares_vocab, 0)::int AS pares_vocab,
           (coalesce(t.pares_vocab,0) >= ${VOCAB_MIN}
            AND e.empalman::numeric / nullif(e.pares,0) >= ${PISO}) AS aceptada,
           CASE
             WHEN coalesce(t.pares_vocab,0) < ${VOCAB_MIN}
               THEN 'vocabulario insuficiente: no se puede juzgar'
             WHEN e.empalman::numeric / nullif(e.pares,0) < ${PISO}
               THEN 'empalme por debajo del piso'
             ELSE NULL
           END AS motivo
      FROM lineas l
      JOIN emp e ON e.tenant_id = l.tenant_id AND e.route_no = l.route_no
                AND e.foto_fecha = l.foto_fecha
      LEFT JOIN vtam t ON t.tenant_id = l.tenant_id AND t.route_no = l.route_no
  `);
  await knex.raw(`COMMENT ON VIEW ${FOTO} IS
    'La existencia que cada camioneta declara de si misma, leida por FDW del runner. [RD.34] Reemplaza a import-route-stock.js: no se copia, se deriva. "aceptada" es el piso de empalme que impidio que la ruta 27 anclara en 596 millones.'`);
  await knex.raw(`GRANT SELECT ON ${FOTO} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${FOTO} TO dev_ro`);

  // ── El COSTO: manda la foto ───────────────────────────────────────────────────────────────
  //
  // `v_rd_route_unit_value` elegia el costo con
  //     COALESCE(carga_imp/carga_qty, conteo, kepler)
  // o sea que valuaba la existencia de HOY con el promedio ponderado de TODO lo embarcado en la
  // vida de la ruta. Medido el 2026-10-06 contra el reporte que Kepler emite para la ruta 21:
  // de 231 pares en comun, 223 tienen el costo de la foto IDENTICO al de Kepler (96.5 %, y 3 de
  // los 8 restantes son solo el redondeo a 2 decimales del Excel -> 97.8 %).
  //
  // ⇒ El costo del camion ES el de Kepler. Pasa a mandar.
  //
  // Esto cambia la valuacion publicada de todas las rutas: la ruta 502 difiere 2.17 %
  // ($48,440 que declara el camion contra $47,387 que publicaba el promedio de carga).
  //
  // ⚠️ Se opera por CIRUGIA sobre la definicion VIVA, no incrustando la de hoy: el repo lo tocan
  //    varias sesiones y reescribir la vista entera revertiria en silencio un cambio ajeno.
  //    Cada fragmento tiene que aparecer EXACTAMENTE una vez o la migracion se detiene.
  const { rows: [vd] } = await knex.raw(
    `SELECT pg_get_viewdef('analytics.v_rd_route_unit_value'::regclass, true) AS def`);
  let nueva = vd.def;
  const PARCHES = [
    ['COALESCE(b.carga_imp / NULLIF(b.carga_qty, 0::numeric), b.conteo_imp / NULLIF(b.conteo_qty, 0::numeric), f.costo) AS costo_u',
      'COALESCE(p.costo_unitario, b.carga_imp / NULLIF(b.carga_qty, 0::numeric), b.conteo_imp / NULLIF(b.conteo_qty, 0::numeric), f.costo) AS costo_u'],
    ["WHEN (b.carga_imp / NULLIF(b.carga_qty, 0::numeric)) IS NOT NULL THEN 'ruta'::text",
      "WHEN p.costo_unitario IS NOT NULL THEN 'foto'::text\n            WHEN (b.carga_imp / NULLIF(b.carga_qty, 0::numeric)) IS NOT NULL THEN 'ruta'::text"],
    ['LEFT JOIN f ON f.sucursal = b.suc_emisor AND f.sku = b.sku AND f.unidad = b.unidad;',
      `LEFT JOIN f ON f.sucursal = b.suc_emisor AND f.sku = b.sku AND f.unidad = b.unidad\n     LEFT JOIN ${FOTO} p ON p.tenant_id = b.tenant_id AND p.route_no = b.route_no\n       AND p.sku = b.sku AND p.unidad = b.unidad AND p.aceptada;`],
  ];
  for (const [viejo, nuevoTxt] of PARCHES) {
    const veces = nueva.split(viejo).length - 1;
    if (veces !== 1) {
      throw new Error(`[RD.34] el fragmento aparece ${veces} veces (esperaba 1) en v_rd_route_unit_value: ${viejo.slice(0, 70)}`);
    }
    nueva = nueva.replace(viejo, nuevoTxt);
  }
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_rd_route_unit_value AS ${nueva.replace(/;\s*$/, '')}`);
  // ⚠️ `security_invoker` y los GRANT NO sobreviven a un CREATE OR REPLACE. Se reponen.
  await knex.raw(`ALTER VIEW analytics.v_rd_route_unit_value SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_rd_route_unit_value TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_rd_route_unit_value TO dev_ro`);

  // ── El ledger: el ancla sale de la foto, o de un conteo humano si es mas nuevo ────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH anclas AS (
      -- Un conteo capturado a mano GANA sobre la foto a igualdad de fecha.
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
      SELECT i.tenant_id, i.route_no, i.suc_emisor, i.almacen_erp, i.warehouse_id,
             i.carga_desde AS desde,
             a.fecha AS conteo_fecha, a.origen, a.conteo_id
        FROM analytics.mv_rd_route_identity i
        LEFT JOIN LATERAL (
             SELECT x.fecha, x.origen, x.conteo_id
               FROM anclas x
              WHERE x.tenant_id = i.tenant_id AND x.route_no = i.route_no
              ORDER BY x.fecha DESC, x.prioridad DESC
              LIMIT 1
        ) a ON true
    ), carga AS (
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

  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    const t0 = Date.now();
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    console.log(`  . [RD.34] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── FRENOS ────────────────────────────────────────────────────────────────────────────────

  // 1. La compuerta esta CABLEADA, no es decorativa: el veredicto coincide con el piso.
  const { rows: [g] } = await knex.raw(`
    SELECT count(DISTINCT route_no)::int rutas,
           count(DISTINCT route_no) FILTER (WHERE aceptada)::int aceptadas,
           count(DISTINCT route_no) FILTER (WHERE NOT aceptada)::int rechazadas,
           count(*) FILTER (WHERE aceptada <> (pares_vocab >= ${VOCAB_MIN} AND empalme >= ${PISO}))::int incoherentes,
           round(min(empalme),4)::float peor_empalme
      FROM ${FOTO}`);
  if (Number(g.incoherentes) > 0) {
    throw new Error(`[RD.34] la compuerta no coincide con el piso en ${g.incoherentes} renglones`);
  }
  console.log(`  . [RD.34] fotos: ${g.rutas} rutas · ${g.aceptadas} aceptadas · ${g.rechazadas} rechazadas · peor empalme ${g.peor_empalme}`);
  if (Number(g.rechazadas) === 0) {
    // ADR-056: no se dibuja como probado lo que hoy no se ejercio.
    console.log('  . [RD.34] NO MEDIDO: ninguna foto cayo bajo el piso hoy, la rama de rechazo no se ejercito');
  }

  // 2. ⭐ El ancla ancla: lo publicado es lo que la camioneta declara.
  const { rows: anclas } = await knex.raw(`
    WITH a AS (
      SELECT p.route_no, p.foto_fecha, round(sum(p.importe),2) AS declarado
        FROM ${FOTO} p WHERE p.aceptada GROUP BY 1,2
    )
    SELECT a.route_no, a.declarado::float,
           round(coalesce(sum(u.saldo_qty * coalesce(u.costo_u,0)),0),2)::float publicado,
           count(*) FILTER (WHERE u.saldo_qty < 0)::int negativos,
           (SELECT count(*) FROM analytics.mv_rd_route_ledger l
             WHERE l.route_no = a.route_no AND l.business_date > a.foto_fecha)::int mov_post,
           (SELECT count(*) FROM analytics.mv_rd_route_ledger l
             WHERE l.route_no = a.route_no AND l.clase = 'carga')::int carga,
           (SELECT count(*) FROM analytics.mv_rd_route_ledger l
             WHERE l.route_no = a.route_no AND l.clase = 'venta')::int venta
      FROM a LEFT JOIN analytics.mv_rd_route_unit_value u ON u.route_no = a.route_no
     GROUP BY a.route_no, a.declarado, a.foto_fecha`);

  if (!anclas.length) throw new Error('[RD.34] ninguna foto quedo aceptada: el ancla no quedo cableada');
  for (const a of anclas) {
    if (!Number(a.carga) || !Number(a.venta)) {
      throw new Error(`[RD.34] ruta ${a.route_no}: el ancla borro la historia (carga=${a.carga} venta=${a.venta})`);
    }
    if (Number(a.mov_post) > 0) {
      console.log(`  . [RD.34] ruta ${a.route_no}: ${a.mov_post} renglones posteriores a la foto -> cuadre exacto NO MEDIDO (publicado=${a.publicado})`);
      continue;
    }
    // Con el costo de la foto mandando, esto tiene que dar CASI exacto: lo que sobra es el
    // redondeo de costo_unitario por par. 0.5 % es holgado; si no entra, algo mas cambio.
    const dif = Math.abs(a.publicado - a.declarado);
    if (dif > Math.max(1, Math.abs(a.declarado) * 0.005)) {
      throw new Error(`[RD.34] ruta ${a.route_no}: el ancla NO ancla. declarado=${a.declarado} publicado=${a.publicado} dif=${dif.toFixed(2)}`);
    }
    if (Number(a.negativos) > 0) {
      throw new Error(`[RD.34] ruta ${a.route_no}: ${a.negativos} pares en negativo sin movimiento posterior a la foto`);
    }
    console.log(`  . [RD.34] ruta ${a.route_no}: declarado=${a.declarado} publicado=${a.publicado} negativos=0 OK`);
  }

  // 3. Una ruta SIN foto aceptada ni conteo humano no puede tener ajustes.
  const { rows: [s] } = await knex.raw(`
    SELECT count(*)::int n FROM analytics.mv_rd_route_ledger l
     WHERE l.clase = 'conteo'
       AND NOT EXISTS (SELECT 1 FROM ${FOTO} p WHERE p.route_no = l.route_no AND p.aceptada)
       AND NOT EXISTS (SELECT 1 FROM commercial.route_counts rc
                        JOIN analytics.mv_rd_route_identity i
                          ON i.warehouse_id = rc.warehouse_id AND i.tenant_id = rc.tenant_id
                       WHERE i.route_no = l.route_no AND rc.status = 'active'
                         AND rc.deleted_at IS NULL AND rc.source <> 'kepler')`);
  if (Number(s.n) > 0) throw new Error(`[RD.34] ${s.n} ajustes en rutas sin ancla`);
};

exports.down = async function down() {
  throw new Error('[RD.34] no tiene reversa automatica: volver reinstala la dependencia del importer');
};
