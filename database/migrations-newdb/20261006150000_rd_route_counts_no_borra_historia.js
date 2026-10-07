'use strict';
/**
 * `[RD.33]` — **El conteo NEUTRALIZA el saldo anterior; no borra la historia.**
 *
 * ⛔ Defecto introducido por `[RD.31]` y medido en vivo el 2026-10-06, en cuanto la primera
 * camioneta empezó a mandar su foto: para anclar, el ledger **excluía todo lo anterior al
 * conteo**. El saldo quedaba perfecto —la ruta 22 publicó $65,100.76 con **cero** productos en
 * negativo, que era justo el objetivo— pero a cambio:
 *
 * | ruta | carga | venta | conteo |
 * |---|---|---|---|
 * | 21 (sin anclar) | 6,113 pares | 8,655 pares | — |
 * | **22 (anclada)** | **0** | **0** | 357 |
 *
 * ⇒ La pantalla perdió de esa ruta *cuánto cargó*, *cuánto vendió*, *cuándo fue la última vez* y
 * la serie entera. **El ledger sirve a dos preguntas distintas y yo optimicé una rompiendo la
 * otra.** Lo señaló Edgar en una línea: *«necesitamos existencia y ventas»*.
 *
 * ⚠️ La venta **no se perdió**: sigue entrando por `analytics.route_push_lines` y por
 * `analytics.sales_daily` (medido el mismo día: 26 tickets / $15,332 en el carril, $30,468 en el
 * fact). El daño estaba acotado a esta vista — pero esta vista es la que contesta la pregunta.
 *
 * ── El arreglo, y por qué NO necesita tocar el servicio ──────────────────────────────────────
 *
 * El conteo deja de emitirse como *la cantidad contada* y pasa a emitirse como **la diferencia
 * contra lo que la reconstrucción creía en ese momento**:
 *
 *     ajuste = contado − (cargado hasta el conteo − vendido hasta el conteo)
 *
 * Con eso, y **conservando carga y venta completas**, la cuenta que el servicio ya hace sale sola:
 *
 *     saldo = Σcarga − Σventa + ajuste
 *           = (carga_antes + carga_después) − (venta_antes + venta_después)
 *             + contado − carga_antes + venta_antes
 *           = **contado + carga_después − venta_después**
 *
 * ⭐ Es exactamente el ancla que se buscaba, y el servicio **no cambia**: ya suma la clase
 * `conteo` dentro del saldo (`cq + kq − vq`). Cero redeploy.
 *
 * ⚠️ `ajuste` puede ser **negativo**, y eso es correcto: significa que la reconstrucción
 * atribuía al camión más de lo que el camión declara. No se recorta a cero — recortarlo
 * volvería a dibujar un número que el conteo contradice.
 *
 * ⚠️ `costo_doc` del renglón de conteo se prorratea al mismo unitario que declara el conteo, para
 * que un ajuste negativo reste dinero y no sólo piezas.
 *
 * ── Lo que cambia y lo que no ───────────────────────────────────────────────────────────────
 *
 * · `carga` y `venta` vuelven a arrancar en `carga_desde` (toda la historia). ✅
 * · `clase='conteo'` pasa a ser **el ajuste**, fechado el día del conteo.
 * · Un par que el conteo **no lista** recibe un ajuste que lo manda a **cero**: el reseteo se
 *   conserva, que era lo bueno de `[RD.31]`. Sin esto los fantasmas volverían.
 * · Sin conteo registrado, la vista publica exactamente lo mismo que antes.
 *
 * @param { import("knex").Knex } knex
 */

const LEDGER = 'analytics.v_rd_route_ledger';

/** Los rótulos de un almacén de ruta, como dato (`[RD.30]`). */
const ROTULOS = `
  SELECT x.dest_code FROM analytics.transfer_dest_map x
   WHERE x.tenant_id = a.tenant_id AND x.warehouse_id = a.warehouse_id`;

exports.up = async function up(knex) {
  await knex.raw(`
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
      -- Historia COMPLETA. [RD.33]: ya no se recorta por el ancla -- recortarla fue el defecto.
      SELECT a.tenant_id, a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
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
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
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
             btrim(p.sku) AS sku, btrim(p.unidad) AS unidad,
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
    ), conteo AS (
      -- El AJUSTE: contado menos lo que se creia. Un par que el conteo no lista entra con
      -- "contado = 0" y su ajuste lo manda a cero -- el reseteo se conserva.
      SELECT a.tenant_id, a.route_no, a.conteo_fecha AS business_date,
             coalesce(l.sku, p.sku)       AS sku,
             coalesce(l.unidad, p.unidad) AS unidad,
             coalesce(l.qty,0) - coalesce(p.saldo_previo,0) AS qty,
             (coalesce(l.qty,0) - coalesce(p.saldo_previo,0))
               * coalesce(l.costo_unitario, l.importe / nullif(l.qty,0), 0) AS costo_doc
        FROM ancla a
        LEFT JOIN (
             SELECT tenant_id, count_id, btrim(sku) AS sku, upper(btrim(unidad)) AS unidad,
                    sum(qty) AS qty, max(costo_unitario) AS costo_unitario, sum(importe) AS importe
               FROM commercial.route_count_lines GROUP BY 1,2,3,4
        ) l ON l.tenant_id = a.tenant_id AND l.count_id = a.conteo_id
        FULL JOIN previo p
          ON p.tenant_id = a.tenant_id AND p.route_no = a.route_no
         AND p.sku = l.sku AND p.unidad = l.unidad
       WHERE a.conteo_id IS NOT NULL
         AND coalesce(l.qty,0) - coalesce(p.saldo_previo,0) <> 0
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
  await knex.raw(`COMMENT ON VIEW ${LEDGER} IS
    'RD.33 - carga y venta COMPLETAS (la historia que la pantalla necesita) mas la clase conteo,
     que NO es la cantidad contada sino el AJUSTE contra lo que la reconstruccion creia. Asi
     saldo = contado + movimientos posteriores, sin recortar la historia. RD.31 la recortaba y
     dejaba a la ruta anclada sin carga ni venta.'`);

  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    const t0 = Date.now();
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
    console.log(`  · [RD.33] ${mv} refrescada en ${Date.now() - t0} ms`);
  }

  // ── Frenos ────────────────────────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(`
    SELECT count(*) FILTER (WHERE clase='carga'  AND route_no='22')::int AS carga_22,
           count(*) FILTER (WHERE clase='venta'  AND route_no='22')::int AS venta_22,
           count(*) FILTER (WHERE clase='conteo' AND route_no='22')::int AS ajuste_22,
           count(*) FILTER (WHERE clase='carga'  AND route_no='21')::int AS carga_21
      FROM analytics.mv_rd_route_ledger`);
  const r = rows[0];
  // La ruta anclada TIENE que recuperar su historia: ese es el defecto que esta migracion corrige.
  if (Number(r.carga_22) === 0 || Number(r.venta_22) === 0) {
    throw new Error(`[RD.33] la ruta 22 sigue sin historia (carga=${r.carga_22} venta=${r.venta_22})`);
  }
  // Y la NO anclada no puede haber ganado ajustes de la nada.
  const { rows: s } = await knex.raw(`
    SELECT count(*)::int n FROM analytics.mv_rd_route_ledger WHERE clase='conteo' AND route_no='21'`);
  if (Number(s[0].n) > 0) throw new Error(`[RD.33] la ruta 21 no tiene conteo y le salieron ${s[0].n} ajustes`);
  console.log(`  · [RD.33] ruta 22: carga=${r.carga_22} venta=${r.venta_22} ajuste=${r.ajuste_22} · ruta 21 (sin anclar): carga=${r.carga_21}, ajustes=0`);
};

exports.down = async function down(knex) {
  // Vuelve a la forma de RD.31 (recorta la historia en el ancla). Se deja por completitud;
  // no se recomienda: es justo el defecto que RD.33 corrige.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${LEDGER} AS
    WITH ancla AS (
      SELECT i.tenant_id, i.route_no, i.suc_emisor, i.almacen_erp, i.warehouse_id,
             k.id AS conteo_id, k.count_date AS conteo_fecha,
             GREATEST(i.carga_desde, coalesce(k.count_date + 1, i.carga_desde)) AS desde
        FROM analytics.mv_rd_route_identity i
        LEFT JOIN LATERAL (
             SELECT rc.id, rc.count_date FROM commercial.route_counts rc
              WHERE rc.tenant_id = i.tenant_id AND rc.warehouse_id = i.warehouse_id
                AND rc.status = 'active' AND rc.deleted_at IS NULL
              ORDER BY rc.count_date DESC LIMIT 1) k ON true
    ), conteo AS (
      SELECT a.tenant_id, a.route_no, a.conteo_fecha AS business_date,
             btrim(l.sku) AS sku, btrim(l.unidad) AS unidad,
             sum(l.qty) AS qty, sum(l.importe) AS costo_doc
        FROM ancla a JOIN commercial.route_count_lines l
          ON l.tenant_id = a.tenant_id AND l.count_id = a.conteo_id
       WHERE a.conteo_id IS NOT NULL AND l.qty > 0
       GROUP BY 1,2,3,4,5
    ), carga AS (
      SELECT a.tenant_id, a.route_no, h.c9::date AS business_date,
             btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c9::numeric) AS qty, sum(d.c13::numeric) AS costo_doc
        FROM ancla a
        JOIN kepler_ods.kdm1 h ON h.sucursal=a.suc_emisor AND h.c2='U' AND h.c3='D' AND h.c4=41
         AND h.c9::date >= a.desde AND h.c10 IN (${ROTULOS})
        JOIN kepler_ods.kdm2 d ON d.sucursal=h.sucursal AND d.c1=h.c1 AND d.c2=h.c2 AND d.c3=h.c3
         AND d.c4=h.c4 AND d.c5=h.c5 AND d.c6=h.c6
       WHERE coalesce(btrim(d.c11),'') NOT IN ('SER','') GROUP BY 1,2,3,4,5
    ), costo_erp AS (
      SELECT a.route_no, h.c9::date AS business_date, btrim(d.c8) AS sku, btrim(d.c11) AS unidad,
             sum(d.c62::numeric) AS costo_erp
        FROM ancla a
        JOIN kepler_ods.kdm1 h ON h.sucursal=a.suc_emisor AND h.c1=a.almacen_erp
         AND h.c2='U' AND h.c3='D' AND h.c4=10 AND h.c9::date >= a.desde
        JOIN kepler_ods.kdm2 d ON d.sucursal=h.sucursal AND d.c1=h.c1 AND d.c2=h.c2 AND d.c3=h.c3
         AND d.c4=h.c4 AND d.c5=h.c5 AND d.c6=h.c6
       WHERE a.almacen_erp IS NOT NULL AND nullif(btrim(d.c62),'') IS NOT NULL GROUP BY 1,2,3,4
    ), venta AS (
      SELECT p.tenant_id, a.route_no, p.business_date, btrim(p.sku) AS sku, btrim(p.unidad) AS unidad,
             sum(p.qty) AS qty, sum(p.importe) AS venta_doc
        FROM ancla a JOIN analytics.route_push_lines p
          ON p.route_no=a.route_no AND p.tenant_id=a.tenant_id AND p.business_date >= a.desde
       WHERE coalesce(btrim(p.unidad),'') <> '' GROUP BY 1,2,3,4,5
    )
    SELECT tenant_id, route_no, business_date, 'conteo'::text AS clase, sku, unidad,
           qty, costo_doc, NULL::numeric AS venta_doc, NULL::numeric AS costo_erp FROM conteo
    UNION ALL
    SELECT tenant_id, route_no, business_date, 'carga'::text, sku, unidad,
           qty, costo_doc, NULL::numeric, NULL::numeric FROM carga
    UNION ALL
    SELECT v.tenant_id, v.route_no, v.business_date, 'venta'::text, v.sku, v.unidad,
           v.qty, NULL::numeric, v.venta_doc, e.costo_erp
      FROM venta v LEFT JOIN costo_erp e
        ON e.route_no=v.route_no AND e.business_date=v.business_date
       AND e.sku=v.sku AND e.unidad=v.unidad
  `);
  await knex.raw(`ALTER VIEW ${LEDGER} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${LEDGER} TO app_runtime`);
  for (const mv of ['analytics.mv_rd_route_ledger', 'analytics.mv_rd_route_unit_value']) {
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
  }
};
