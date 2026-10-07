'use strict';
/**
 * `[RD.36]` — **El conteo de apertura de la ruta ENTRA al ledger. Tenía documento y nadie lo leía.**
 *
 * Lo preguntó Edgar: *"a las rutas tambien se les hizo un inventario fisico"*. Lo tenía.
 *
 * ── Lo medido el 2026-10-07 ─────────────────────────────────────────────────────────────────
 *
 * `analytics.mv_erp_physical_count_variance` (Fase IC) ve **un almacén de ruta**: `01-006`, que es
 * la ruta 28. Un conteo del **26-jun**, 324 renglones, **2,973 uds / $47,596.87**, tipificado
 * `carga_inicial` con `teorico = 0` — o sea mercancía que ya estaba arriba del camión.
 *
 * La ruta 28 embarcó por primera vez el **27-jun** y su ledger arranca el **29-jun**
 * (`carga_desde = GREATEST(primer embarque, primera venta)`). El conteo es ANTERIOR a las dos
 * fechas, así que nunca entró a la cuenta.
 *
 * ⇒ Y es casi exactamente la brecha que la pantalla publicaba como "llegó sin embarque":
 *
 *       conteo de apertura  2,973 uds
 *       brecha de la 28     3,159 uds      ->  **94 %**
 *
 * **Lo que se llamaba "mercancía sin documento" tenía documento.** Lo que faltaba era leerlo.
 *
 * ── Cómo entra ──────────────────────────────────────────────────────────────────────────────
 *
 * Como `clase='carga'`, junto al embarque `U-D-41`. No es un capricho de nombre: el servicio hace
 * `saldo = carga + conteo − venta`, así que para que el ancla siga dando lo contado, la apertura
 * tiene que viajar dentro de uno de esos tres. Y económicamente **es carga**: mercancía que entró
 * al camión, documentada por un conteo en vez de por un embarque.
 *
 * Efecto en cadena, todo deseado:
 *   · `previo` (lo que la reconstrucción creía al día del conteo) la incluye;
 *   · el ajuste del ancla se achica en esa cantidad -> "llegó sin embarque" baja a lo que de
 *     verdad no tiene papel;
 *   · el saldo publicado NO se mueve: sigue siendo lo que el camión declara.
 *
 * ⚠️ **Sólo se toma lo ANTERIOR a `carga_desde`.** Un conteo posterior ya está recogido por la
 *    foto del día, y sumarlo lo contaría dos veces. Medido: hoy no existe ninguno posterior.
 *
 * ⚠️ `faltante` resta y `sobrante` suma. Hoy las rutas sólo tienen `sobrante`, pero depender de
 *    eso sería depender de una casualidad del dato de hoy.
 *
 * ⚠️ Las otras diez rutas NO tienen conteo de apertura en la sucursal. Su brecha queda igual, y
 *    eso es lo correcto: pasa de "no sabemos de dónde salió" a **"a esta ruta no se le hizo
 *    conteo de apertura"**, que es un hueco con nombre (ADR-056).
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
  // ⛔ No se reescribe a ciegas: si otra sesion cambio el ledger, esta migracion lo revertiria
  //    en silencio. Se exige encontrar las marcas que dejo [RD.34].
  const { rows: [cur] } = await knex.raw(
    `SELECT pg_get_viewdef('${LEDGER}'::regclass, true) AS def`);
  for (const marca of ['v_rd_route_photo', 'pares AS', 'route_counts']) {
    if (!cur.def.includes(marca)) {
      throw new Error(`[RD.36] el ledger no tiene la marca "${marca}" de [RD.34]: otra sesion lo cambio. Parar y revisar.`);
    }
  }

  // Lo que hay HOY, para poder afirmar el cambio con un antes y un despues.
  const { rows: [antes] } = await knex.raw(`
    SELECT round(coalesce(sum(qty) FILTER (WHERE clase='carga'),0),2)::float carga28,
           round(coalesce(sum(qty) FILTER (WHERE clase='conteo'),0),2)::float ajuste28
      FROM analytics.mv_rd_route_ledger WHERE route_no='28'`);

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
    console.log(`  . [RD.36] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── FRENOS ────────────────────────────────────────────────────────────────────────────────

  // 1. La apertura ENTRO, y entro donde debia: la ruta 28 gana exactamente el conteo del 26-jun.
  const { rows: [ap] } = await knex.raw(`
    SELECT count(*)::int renglones,
           round(coalesce(sum(CASE WHEN signo='faltante' THEN -cantidad ELSE cantidad END),0),2)::float uds
      FROM analytics.mv_erp_physical_count_variance v
      JOIN analytics.mv_rd_route_identity i
        ON i.suc_emisor = v.kepler_sucursal AND i.almacen_erp = v.kepler_almacen
      JOIN analytics.v_rd_route_opening o ON o.route_no = i.route_no
     WHERE v.fecha < o.carga_desde`);
  const { rows: [despues] } = await knex.raw(`
    SELECT round(coalesce(sum(qty) FILTER (WHERE clase='carga'),0),2)::float carga28,
           round(coalesce(sum(qty) FILTER (WHERE clase='conteo'),0),2)::float ajuste28
      FROM analytics.mv_rd_route_ledger WHERE route_no='28'`);
  const gano = Number((despues.carga28 - antes.carga28).toFixed(2));
  if (!ap.renglones) {
    console.log('  . [RD.36] NO MEDIDO: ninguna ruta tiene conteo de apertura, el cambio no se ejercito');
  } else if (Math.abs(gano - Number(ap.uds)) > 1) {
    throw new Error(`[RD.36] la carga de la 28 crecio ${gano} uds y el conteo de apertura vale ${ap.uds}`);
  } else {
    console.log(`  . [RD.36] ruta 28: carga ${antes.carga28} -> ${despues.carga28} (+${gano} uds, el conteo del 26-jun)`);
    console.log(`  . [RD.36] ruta 28: lo que NO tiene papel baja de ${antes.ajuste28} a ${despues.ajuste28} uds`);
  }

  // 2. ⭐ El ancla NO se movio: el saldo publicado sigue siendo lo que el camion declara.
  const { rows: anclas } = await knex.raw(`
    WITH f AS (SELECT route_no, round(sum(importe),2) declarado FROM ${FOTO} WHERE aceptada GROUP BY 1)
    SELECT f.route_no, f.declarado::float,
           round(coalesce(sum(u.saldo_qty * coalesce(u.costo_u,0)),0),2)::float publicado,
           count(*) FILTER (WHERE u.saldo_qty < 0)::int negativos
      FROM f LEFT JOIN analytics.mv_rd_route_unit_value u ON u.route_no = f.route_no
     GROUP BY f.route_no, f.declarado ORDER BY 1`);
  if (!anclas.length) throw new Error('[RD.36] se quedo sin rutas ancladas');
  for (const a of anclas) {
    const dif = Math.abs(a.publicado - a.declarado);
    if (dif > Math.max(1, Math.abs(a.declarado) * 0.005)) {
      throw new Error(`[RD.36] ruta ${a.route_no}: el ancla se rompio. declarado=${a.declarado} publicado=${a.publicado}`);
    }
    if (Number(a.negativos) > 0) {
      throw new Error(`[RD.36] ruta ${a.route_no}: aparecieron ${a.negativos} pares en negativo`);
    }
  }
  console.log(`  . [RD.36] el ancla sigue firme en ${anclas.length} rutas, 0 negativos`);

  // 3. PRUEBA NEGATIVA: una ruta SIN conteo de apertura no puede haber ganado carga.
  const { rows: [sin] } = await knex.raw(`
    SELECT count(*)::int n FROM analytics.mv_rd_route_ledger l
     WHERE l.clase = 'carga'
       AND EXISTS (SELECT 1 FROM analytics.v_rd_route_opening o
                    WHERE o.route_no = l.route_no AND l.business_date < o.carga_desde)
       AND NOT EXISTS (
         SELECT 1 FROM analytics.mv_erp_physical_count_variance v
           JOIN analytics.mv_rd_route_identity i
             ON i.suc_emisor = v.kepler_sucursal AND i.almacen_erp = v.kepler_almacen
          WHERE i.route_no = l.route_no)`);
  if (Number(sin.n) > 0) {
    throw new Error(`[RD.36] ${sin.n} renglones de carga previos al arranque en rutas SIN conteo de apertura`);
  }
  console.log('  . [RD.36] prueba negativa OK: ninguna ruta sin conteo gano carga de la nada');
};

exports.down = async function down() {
  throw new Error('[RD.36] no tiene reversa automatica: volver esconde otra vez el conteo de apertura de la ruta 28');
};
