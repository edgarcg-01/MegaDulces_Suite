'use strict';
/**
 * `[RD.33.1]` — **El ajuste del conteo no cubria los pares que el conteo NO lista.**
 *
 * ⛔ Defecto de `[RD.33]` (batch 742), medido en prod minutos despues de aplicarla. La historia
 * volvio —la ruta 22 recupero 4,636 pares de carga y 7,979 de venta— pero el ancla dejo de anclar:
 *
 * | | antes de RD.33 | con RD.33 | esperado |
 * |---|---|---|---|
 * | saldo publicado ruta 22 | $65,100.76 | **$48,510.27** | $65,100.76 |
 * | pares en negativo | **0** | **149** | 0 |
 * | renglones de ajuste | — | **179** | ~903 |
 *
 * ── La causa ────────────────────────────────────────────────────────────────────────────────
 *
 * El `FULL JOIN` se hacia contra el resultado de `ancla a LEFT JOIN route_count_lines l`. Cuando
 * un par existia en `previo` pero NO en el conteo, el full join devolvia la fila con **`a.*` en
 * NULL**, y el `WHERE a.conteo_id IS NOT NULL` la descartaba.
 *
 * ⇒ La rama que pone en CERO los pares fantasma —lo unico bueno que tenia `[RD.31]`— no se
 *   emitia nunca. Sobrevivian los saldos inventados y, con ellos, los negativos.
 *
 * ⭐ La leccion no es el `FULL JOIN`: es que **`[RD.33]` paso sus propios frenos**. Verificaban
 * que la ruta 22 tuviera carga y venta (cierto) y que la 21 no ganara ajustes (cierto), pero
 * **ninguno comprobaba lo que la fase existe para lograr**: que el saldo publicado sea el contado
 * y que no queden negativos. Un freno que no mide el proposito deja pasar justo el fallo que
 * importa. Esta migracion los agrega.
 *
 * ── El arreglo ──────────────────────────────────────────────────────────────────────────────
 *
 * Se construye primero el UNIVERSO de pares (los del conteo UNION los que la reconstruccion
 * creia) y recien contra el se buscan las dos cantidades. Asi ninguna rama puede perderse por el
 * lado del join del que venga.
 *
 *     ajuste = contado - lo_que_se_creia      (negativo = el camion trae menos: correcto)
 *
 * ⚠️ La unidad se normaliza con `upper(btrim(...))` en AMBOS lados del cruce. El conteo la guarda
 *    en mayusculas (lo hace el importador) y el ERP la trae como venga; hoy coinciden, pero
 *    depender de eso es depender de una casualidad.
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';

/** Los rotulos de un almacen de ruta, como dato (`[RD.30]`). */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = a.tenant_id AND x.warehouse_id = a.warehouse_id`;

const VISTA = `
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH ancla AS (
      SELECT i.tenant_id, i.route_no, i.suc_emisor, i.almacen_erp, i.warehouse_id,
             i.carga_desde AS desde,
             k.id AS conteo_id, k.count_date AS conteo_fecha
        FROM analytics.mv_rd_route_identity i
        LEFT JOIN LATERAL (
             SELECT rc.id, rc.count_date
               FROM commercial.route_counts rc
              WHERE rc.tenant_id = i.tenant_id AND rc.warehouse_id = i.warehouse_id
                AND rc.status = 'active' AND rc.deleted_at IS NULL
              ORDER BY rc.count_date DESC LIMIT 1
        ) k ON true
    ), carga AS (
      -- Historia COMPLETA: no se recorta por el ancla.
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
      -- Lo que la reconstruccion creia AL CIERRE del dia del conteo, por par.
      SELECT a.tenant_id, a.route_no, m.sku, m.unidad, sum(m.q) AS saldo_previo
        FROM ancla a
        JOIN LATERAL (
             SELECT c.sku, c.unidad, c.qty AS q FROM carga c
              WHERE c.route_no = a.route_no AND c.business_date <= a.conteo_fecha
             UNION ALL
             SELECT v.sku, v.unidad, -v.qty FROM venta v
              WHERE v.route_no = a.route_no AND v.business_date <= a.conteo_fecha
        ) m ON true
       WHERE a.conteo_id IS NOT NULL
       GROUP BY 1,2,3,4
    ), contado AS (
      SELECT a.tenant_id, a.route_no, a.conteo_fecha,
             btrim(l.sku) AS sku, upper(btrim(l.unidad)) AS unidad,
             sum(l.qty)              AS qty,
             max(l.costo_unitario)   AS costo_unitario,
             sum(l.importe)          AS importe
        FROM ancla a
        JOIN commercial.route_count_lines l
          ON l.tenant_id = a.tenant_id AND l.count_id = a.conteo_id
       WHERE a.conteo_id IS NOT NULL
       GROUP BY 1,2,3,4,5
    ), pares AS (
      -- ⭐ El UNIVERSO primero. Antes el full join perdia esta mitad y los fantasmas sobrevivian.
      SELECT tenant_id, route_no, conteo_fecha, sku, unidad FROM contado
      UNION
      SELECT p.tenant_id, p.route_no, a.conteo_fecha, p.sku, p.unidad
        FROM previo p
        JOIN ancla a ON a.tenant_id = p.tenant_id AND a.route_no = p.route_no
                    AND a.conteo_id IS NOT NULL
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
`;

exports.up = async function up(knex) {
  await knex.raw(VISTA);
  await knex.raw(`ALTER VIEW ${LEDGER} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO app_runtime`);

  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    const t0 = Date.now();
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    console.log(`  . [RD.33.1] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── FRENOS ────────────────────────────────────────────────────────────────────────────────
  // Los de RD.33 miraban que hubiera historia. Estos miran el PROPOSITO: que el ancla ancle.

  // 1. La historia sigue ahi (lo que RD.33 si logro, no se puede perder al arreglar lo otro).
  const { rows: [h] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE clase='carga')::int carga,
           count(*) FILTER (WHERE clase='venta')::int venta
      FROM analytics.mv_rd_route_ledger WHERE route_no='22'`);
  if (!Number(h.carga) || !Number(h.venta)) {
    throw new Error(`[RD.33.1] la ruta 22 se quedo sin historia (carga=${h.carga} venta=${h.venta})`);
  }

  // 2. Una ruta SIN conteo no puede tener ajustes.
  const { rows: [s] } = await knex.raw(`
    SELECT count(*)::int n FROM analytics.mv_rd_route_ledger l
     WHERE l.clase='conteo'
       AND NOT EXISTS (SELECT 1 FROM commercial.route_counts rc
                        JOIN analytics.mv_rd_route_identity i
                          ON i.warehouse_id=rc.warehouse_id AND i.tenant_id=rc.tenant_id
                       WHERE i.route_no=l.route_no AND rc.status='active' AND rc.deleted_at IS NULL)`);
  if (Number(s.n) > 0) throw new Error(`[RD.33.1] ${s.n} ajustes en rutas sin conteo`);

  // 3. ⭐ EL FRENO QUE FALTABA: el saldo publicado tiene que SER el contado, mas lo que se movio
  //    despues del conteo. Donde no hubo movimiento posterior, tiene que dar exacto.
  const { rows: anclas } = await knex.raw(`
    SELECT i.route_no, round(rc.declared_total,2)::float declarado,
           round(coalesce(sum(u.saldo_qty * coalesce(u.costo_u,0)),0)::numeric,2)::float publicado,
           count(*) FILTER (WHERE u.saldo_qty < 0)::int negativos,
           (SELECT count(*) FROM analytics.mv_rd_route_ledger l
             WHERE l.route_no=i.route_no AND l.business_date > rc.count_date)::int mov_post
      FROM commercial.route_counts rc
      JOIN analytics.mv_rd_route_identity i
        ON i.warehouse_id=rc.warehouse_id AND i.tenant_id=rc.tenant_id
      LEFT JOIN analytics.mv_rd_route_unit_value u ON u.route_no=i.route_no AND u.tenant_id=i.tenant_id
     WHERE rc.status='active' AND rc.deleted_at IS NULL
     GROUP BY i.route_no, rc.declared_total, rc.count_date`);

  if (!anclas.length) {
    // ADR-056: lo que no se puede medir se DECLARA, no se da por bueno.
    console.log('  . [RD.33.1] NO MEDIDO: ninguna ruta anclada todavia (el freno del ancla no corrio)');
  }
  for (const a of anclas) {
    if (Number(a.mov_post) > 0) {
      console.log(`  . [RD.33.1] ruta ${a.route_no}: ${a.mov_post} renglones posteriores al conteo -> cuadre exacto NO MEDIDO (publicado=${a.publicado})`);
      continue;
    }
    const dif = Math.abs(a.publicado - a.declarado);
    const tol = Math.max(1, Math.abs(a.declarado) * 0.01);
    if (dif > tol) {
      throw new Error(`[RD.33.1] ruta ${a.route_no}: el ancla NO ancla. declarado=${a.declarado} publicado=${a.publicado} dif=${dif.toFixed(2)}`);
    }
    if (Number(a.negativos) > 0) {
      throw new Error(`[RD.33.1] ruta ${a.route_no}: ${a.negativos} pares en negativo sin movimiento posterior al conteo`);
    }
    console.log(`  . [RD.33.1] ruta ${a.route_no}: declarado=${a.declarado} publicado=${a.publicado} negativos=${a.negativos} OK`);
  }
};

exports.down = async function down() {
  // Sin vuelta atras a proposito: revertir reinstala el defecto que esta migracion corrige
  // (el ancla dejaba de anclar). Para volver a la forma anterior esta RD.33 en el historial.
  throw new Error('[RD.33.1] no tiene reversa: volver reinstala un ancla que no ancla');
};
