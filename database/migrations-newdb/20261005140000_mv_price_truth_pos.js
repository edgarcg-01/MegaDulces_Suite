'use strict';
/**
 * `[VPR.4]` — **El precio de venta POR PLAZA, y con el árbitro correcto: lo que la caja cobra.**
 *
 * Reemplaza a `[VPR.1]`, que estaba construida sobre la fuente equivocada. Lo dejo escrito porque
 * el error es más instructivo que el arreglo:
 *
 * ── ⛔ Qué tenía mal la versión anterior ────────────────────────────────────────────────────
 * `v_price_truth` publicaba `kdii.c90` — el precio que Kepler **configura** — y yo la validé
 * contra la etiquetera, que da 100%. Pero **la etiquetera también sale de `c90`**: dos derivados
 * de la misma fuente coincidiendo entre sí. Es textualmente lo que ADR-059 regla 5 advierte,
 * *"un árbitro que nunca contradice es un espejo"*, y lo pasé de largo.
 *
 * La política ya estaba decidida y documentada (Edgar, 2026-08-25, cabecera de
 * `services/feeds-ingest/ods-derived.js`): **manda lo que el punto de venta COBRA**. Verificado en
 * el SKU 83041: las nueve plazas **configuran $40.49** y la caja **cobra $38.94 en 264,028 líneas**
 * contra 5,227. La versión anterior habría publicado el precio que la caja no cobra.
 *
 * ── ⭐ Y por plaza importa MUCHO más de lo que yo había medido ───────────────────────────────
 * Sobre el precio CONFIGURADO, sólo 7.8% de los SKUs difieren entre plazas. Sobre lo que la caja
 * de verdad COBRA: **1,261 de 3,262 SKUs vendidos en más de una plaza, el 38.7%**. La
 * configuración es casi uniforme en la red; el cobro no lo es. Un número único de red no puede
 * representar eso, y es la razón de fondo del reporte de campo.
 *
 * ── Las reglas son LAS MISMAS de `ods-derived`, sin reinterpretar ───────────────────────────
 * Lo único que cambia es el GRANO: `(plaza, sku)` en vez de red. Doctypes de venta del catálogo
 * `kdmm` (género U, naturaleza D: 3,5,6,7,8,9,10,12,13,45), `qty < 3` (abajo del primer escalón
 * de volumen, donde el precio es firme), sólo la unidad BASE (`kdii.c11`), documentos vigentes
 * (`kdm1.c43='N'`), 90 días, y **mínimo 5 líneas** para creerle a la moda.
 *
 * ⚠️ **La llave del documento son SIETE columnas** (`sucursal, c1..c6`), no cuatro: el folio no es
 * único entre tipos de documento. Unir de menos casa el documento equivocado — a mí me devolvió
 * 54 millones de líneas en una medición de esta misma sesión.
 *
 * RESPALDO donde no hay ventas suficientes (~la mitad del catálogo no vende 5 líneas en 90 días):
 * el PV configurado de ESA plaza, y ahí sí se valida, porque no hay con qué contrastarlo. Mismos
 * cuatro rechazos que `ods-derived`. **Lo rechazado publica NULL, nunca 0** (ADR-056).
 *
 * ── Por qué MATERIALIZADA, y no una vista ───────────────────────────────────────────────────
 * Medido contra prod: la consulta cuesta **8.5 s** sobre el catálogo completo. El gate de pantalla
 * es 1 s y `take-order` baja el catálogo entero de una plaza para el modo sin conexión. Se
 * materializa **por costo**, que es la única razón que la regla principal admite — el valor no se
 * inventa, se deriva, y se refresca desde el mismo carril que ya escribe el precio.
 *
 * ⛔ **No cambia ningún número publicado por sí sola**: el servicio todavía lee la lista de red.
 */

const MV = 'analytics.mv_price_truth';
const V = 'analytics.v_price_truth';
const BASE_LIST = '00000000-0000-0000-0000-0000c0ffee02';
const DOCS_VENTA = '3,5,6,7,8,9,10,12,13,45';
const VENTANA_DIAS = 90;
const MIN_LINEAS = 5;
const MAX_COSTO = 3;

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    WITH base_unit AS (
      -- La unidad BASE de cada (plaza, sku) y su precio CONFIGURADO. La facturacion es siempre
      -- sobre la unidad base, asi que es tambien el filtro que deja fuera las lineas en caja.
      SELECT btrim(sucursal) AS suc, btrim(c1) AS sku, btrim(c11::text) AS unidad,
             round(c90::numeric, 2) AS pv
        FROM kepler_ods.kdii
       WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c11::text,'')) <> ''
    ), docs AS MATERIALIZED (
      -- El lado de kdm1 es MINUSCULO (~19 k filas de 90 dias). Materializarlo evita que kdm2 lo
      -- busque fila por fila sobre una tabla de 493 MB.
      SELECT m1.sucursal, m1.c1, m1.c2, m1.c3, m1.c4, m1.c5, m1.c6
        FROM kepler_ods.kdm1 m1
       WHERE m1.c2 = 'U' AND m1.c3 = 'D'
         AND m1.c4 IN (${DOCS_VENTA})
         AND m1.c9::date >= current_date - ${VENTANA_DIAS}
         AND btrim(coalesce(m1.c43::text,'N')) = 'N'
    ), pos AS (
      -- LO QUE LA CAJA COBRA, por plaza. Las 7 columnas de la PK: el folio no es unico entre
      -- tipos de documento.
      SELECT btrim(m2.sucursal) AS suc, btrim(m2.c8::text) AS sku,
             mode() WITHIN GROUP (ORDER BY round(m2.c12::numeric, 2) DESC) AS precio,
             count(*)::int AS lineas
        FROM kepler_ods.kdm2 m2
        JOIN docs d ON d.sucursal = m2.sucursal AND d.c1 = m2.c1 AND d.c2 = m2.c2
                   AND d.c3 = m2.c3 AND d.c4 = m2.c4 AND d.c5 = m2.c5 AND d.c6 = m2.c6
       WHERE m2.c9::numeric < 3
         AND EXISTS (SELECT 1 FROM base_unit bu
                      WHERE bu.suc = btrim(m2.sucursal) AND bu.sku = btrim(m2.c8::text)
                        AND bu.unidad = btrim(m2.c11::text))
       GROUP BY 1, 2 HAVING count(*) >= ${MIN_LINEAS}
    ), tier AS (
      -- Escalon de volumen configurado: valida el PV de respaldo en su MISMA unidad.
      SELECT btrim(sucursal) AS suc, btrim(c1) AS sku, btrim(c2) AS present, max(c7::numeric) AS tope
        FROM kepler_ods.kdpv_prod_util
       WHERE c7::numeric > 0.05
       GROUP BY 1, 2, 3
    )
    SELECT
      w.tenant_id,
      w.id                        AS warehouse_id,
      w.code                      AS sucursal,
      pr.id                       AS product_id,
      btrim(pr.sku)               AS sku,
      -- EL PRECIO PUBLICABLE. NULL cuando el respaldo esta rechazado: lo que no se puede afirmar
      -- se declara, nunca se dibuja como cero.
      CASE WHEN pos.precio IS NOT NULL THEN pos.precio
           WHEN rech.motivo IS NULL    THEN bu.pv END       AS precio,
      CASE WHEN pos.precio IS NOT NULL THEN 'pos'
           WHEN rech.motivo IS NULL    THEN 'config'
           ELSE 'rechazado' END                             AS fuente,
      pos.lineas                                            AS lineas_pos,
      bu.pv                                                 AS precio_config,
      rech.motivo                                           AS rechazo,
      -- El de la red, al lado y no en lugar de: sin esto la divergencia es invisible.
      pp.price                                              AS precio_lista,
      CASE
        WHEN pp.price IS NULL                                     THEN 'sin_precio_lista'
        WHEN pos.precio IS NULL AND rech.motivo IS NOT NULL        THEN 'sin_precio_medible'
        WHEN abs(pp.price - COALESCE(pos.precio, bu.pv)) < 0.005   THEN 'cuadra'
        ELSE 'difiere'
      END                                                   AS veredicto
      FROM catalog.products pr
      JOIN commercial.warehouses w
        ON w.tenant_id = pr.tenant_id AND w.deleted_at IS NULL
      JOIN base_unit bu ON bu.suc = w.code AND bu.sku = btrim(pr.sku)
      LEFT JOIN pos  ON pos.suc = w.code AND pos.sku = btrim(pr.sku)
      LEFT JOIN tier t ON t.suc = w.code AND t.sku = btrim(pr.sku) AND t.present = bu.unidad
      LEFT JOIN commercial.product_prices pp
        ON pp.tenant_id = pr.tenant_id AND pp.product_id = pr.id
       AND pp.price_list_id = '${BASE_LIST}' AND pp.deleted_at IS NULL
      -- Las MISMAS cuatro validaciones de ods-derived, y en el mismo orden. Solo aplican al
      -- RESPALDO: lo que el PdV cobra ES el precio y no se valida contra nada.
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN pos.precio IS NOT NULL                               THEN NULL
                 WHEN bu.pv IS NULL OR bu.pv <= 0.05                       THEN 'sin_precio'
                 WHEN pr.cost_base > 0 AND bu.pv > pr.cost_base * ${MAX_COSTO} THEN 'sobre_costo'
                 WHEN t.tope IS NOT NULL AND bu.pv >= t.tope * 0.9         THEN NULL
                 WHEN t.tope IS NOT NULL                                   THEN 'bajo_su_escalon'
                 WHEN pr.cost_base > 0 AND bu.pv < pr.cost_base            THEN 'bajo_costo'
               END AS motivo
      ) rech ON true
     WHERE pr.deleted_at IS NULL
       AND NOT coalesce(pr.is_promo, false)
  `);

  // UNIQUE: lo exige REFRESH ... CONCURRENTLY, que es como la refresca el carril sin bloquear.
  await knex.raw(
    `CREATE UNIQUE INDEX ux_mv_price_truth ON ${MV} (tenant_id, warehouse_id, product_id)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  // La vista conserva el nombre que el servicio ya consume; el costo vive del otro lado.
  await knex.raw(`CREATE VIEW ${V} AS SELECT * FROM ${MV}`);
  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW ${MV} IS
      '[VPR.4] Precio de venta por (almacen, producto). Arbitro = lo que la CAJA COBRA (moda de '
      'kdm2.c12, >=5 lineas, qty<3, unidad base, 90 d), politica decidida 2026-08-25; respaldo = el '
      'PV configurado de ESA plaza con las 4 validaciones de ods-derived. Materializada por COSTO '
      '(8.5 s la consulta viva), no por inventar valor. Refresca el carril prices.'`);

  // ── Verificación dentro de la migración ──────────────────────────────────────────────────
  const { rows: [n] } = await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE fuente = 'pos')::int de_caja,
           count(*) FILTER (WHERE fuente = 'config')::int de_config,
           count(*) FILTER (WHERE fuente = 'rechazado')::int rechazados,
           count(DISTINCT warehouse_id)::int plazas
      FROM ${MV}`);
  if (!n.filas) throw new Error('[VPR.4] la matvista quedó vacía');
  if (!n.de_caja) {
    throw new Error('[VPR.4] NINGUNA celda resolvió por lo cobrado: el árbitro no está midiendo, ' +
      'y publicar sólo el configurado es volver al defecto que esta migración corrige');
  }
  if (n.plazas < 2) throw new Error(`[VPR.4] sólo ${n.plazas} plaza(s): el join por código se rompió`);

  // ⭐ EL CONTROL: el árbitro tiene que CONTRADECIR a la lista de red. Si coincidiera en todo,
  // sería un espejo — exactamente el error que esta migración existe para corregir.
  const { rows: [d] } = await knex.raw(`
    SELECT count(*) FILTER (WHERE veredicto = 'difiere')::int difieren,
           count(*) FILTER (WHERE veredicto = 'cuadra')::int cuadran
      FROM ${MV} WHERE fuente = 'pos'`);
  if (!d.difieren) {
    throw new Error('[VPR.4] lo que la caja cobra coincide con la lista de red en TODO: el árbitro ' +
      'no discrimina. Hay que mirarlo, no publicarlo.');
  }

  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${V}', 'SELECT') AS ok`);
  if (!g.ok) throw new Error('[VPR.4] app_runtime no puede leer la vista');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
