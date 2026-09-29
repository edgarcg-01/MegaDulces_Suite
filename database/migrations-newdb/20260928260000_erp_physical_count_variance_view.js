'use strict';
/**
 * [IC.0] analytics.v_erp_physical_count_variance — EL DESCUADRE DEL CONTEO FÍSICO, VISIBLE.
 *
 * Kepler hace el inventario completo cada trimestre y genera el ajuste. El dato existe desde
 * nov-2025 y NO se ve en ninguna pantalla: medido en sep-2026, $6.60M de sobrante contra
 * $2.26M de faltante sobre $34.1M contados, y el sobrante va de 6.5% a 31% del valor contado
 * según la sucursal. Nadie lo mira porque no hay dónde.
 *
 * Derivar-no-copiar (regla principal del proyecto): es una VISTA sobre kepler_ods, sin
 * importer y sin tabla. La alimenta el CDC que ya corre.
 *
 * ── Decode (docs/ERP_KEPLER + FASE_IC §1.2) ─────────────────────────────────────────────
 *   N-A-45-1  Captura inventario físico  → lo contado (NO trae el teórico ni la diferencia)
 *   N-A-30-1  Entrada inventario físico  → ajuste SOBRANTE
 *   N-D-30-1  Salida  inventario físico  → ajuste FALTANTE
 * La diferencia SÓLO existe en los documentos de ajuste. Esta vista sale de ahí.
 *   kdm2: c8=SKU · c9=cantidad · c10=descripcion · c11=unidad · c12=costo · c13=importe
 *
 * ── Tres trampas que esta vista tiene que respetar, todas medidas ───────────────────────
 *  1. EL JOIN LLEVA c1 (el almacén). El folio no es único entre almacenes de la misma
 *     sucursal: la 01 tiene dos cabeceras con folio 0000001, una de la Ruta 28 (c1='01-006')
 *     y otra de la sucursal. Sin c1 las líneas se duplican -- el sobrante de la 01 pasaba de
 *     897 SKUs a 1,221 (27% de más). Y el join lleva TAMBIÉN c2 y c3: sin ellos, las líneas
 *     entran desde cualquier doctype que comparta (c4,c5,c6) -- la entrada de la 01 pasaba
 *     de 897 a 2,220 porque se colaban la salida N-D-30 y un X-A-30 de otro género.
 *  2. UNA CARGA INICIAL NO ES UN DESCUADRE. Cuando una sucursal migra de Wincaja a Kepler
 *     emite, el día antes del corte, una captura y una entrada que coinciden línea por línea
 *     con faltante cero. Son $18.8M en 06/07/08 que contaminarían cualquier promedio. La
 *     vista los CLASIFICA por esa firma y expone la columna; no los borra -- son un hecho
 *     real, simplemente no son descuadre.
 *  3. LA SUCURSAL 00 DE KEPLER ES OFICINAS, no el CEDIS, y su existencia es un artefacto
 *     (122.8M de unidades, de las cuales 108.8M son el pseudo-SKU contable 00001 VENTAS AL
 *     0%). Se excluye igual que en v_erp_stock_on_hand. El CEDIS real migra aparte.
 *
 * Aditiva y reversible: sólo crea una vista.
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS analytics');

  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL
        AND to_regclass('kepler_ods.kdm2') IS NOT NULL
        AND to_regclass('commercial.warehouses') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  falta kepler_ods.kdm1/kdm2 o commercial.warehouses — vista omitida');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_physical_count_variance
      WITH (security_invoker = true) AS
    WITH doc AS (
      -- Un renglón por documento (sucursal, ALMACEN, fecha, doctype). El almacen es parte de
      -- la identidad: sin el, dos documentos distintos con el mismo folio se funden.
      -- ⛔ SIN el folio en el GROUP BY: un mismo evento puede traer DECENAS de folios del
      -- mismo doctype (medido: 64 en la 02 del 2026-01-08, 62 en nov-2025). Agrupando por
      -- folio y sacando despues max() se compara el folio MAS GRANDE de captura contra el
      -- mas grande de entrada, en vez del total del evento -- y la firma de carga inicial
      -- deja de significar lo que dice. Lo destapo el candado cruzado con IC.3.
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha, m.c3 AS nat, m.c4 AS tipo_doc,
             count(l.*)::int AS lineas
        FROM kepler_ods.kdm1 m
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
         AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
       WHERE m.c2 = 'N' AND m.c4 IN ('30', '45') AND m.c3 IN ('A', 'D')
       -- ⛔ ANTI-REPLICA: el almacen tiene que PERTENECER a la sucursal. Medido: la
       -- sucursal 03 arrastra 220 cabeceras del almacen 02 (nov-2025 a ene-2026), el mismo
       -- fenomeno que kdil ya documenta. Sin este filtro se atribuyen a 8ESQ documentos que
       -- son de La Piedad. El LIKE conserva los SUB-ALMACENES legitimos (01-006 = Ruta 28).
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
       GROUP BY 1, 2, 3, 4, 5
    ),
    firma AS (
      -- CARGA INICIAL: la entrada replica la captura (mas menos una linea) y no hay faltante.
      -- Un conteo trimestral deja la entrada muy por debajo de la captura.
      SELECT d.sucursal, d.almacen, d.fecha,
             max(d.lineas) FILTER (WHERE d.tipo_doc = '45' AND d.nat = 'A') AS cap,
             max(d.lineas) FILTER (WHERE d.tipo_doc = '30' AND d.nat = 'A') AS ent,
             coalesce(max(d.lineas) FILTER (WHERE d.tipo_doc = '30' AND d.nat = 'D'), 0) AS sal
        FROM doc d GROUP BY 1, 2, 3
    )
    SELECT w.tenant_id,
           w.id                                   AS warehouse_id,
           w.code                                 AS warehouse_code,
           w.name                                 AS warehouse_name,
           m.sucursal                             AS kepler_sucursal,
           m.c1                                   AS kepler_almacen,
           m.c9::date                             AS fecha,
           m.c6                                   AS folio,
           CASE WHEN f.cap IS NOT NULL AND f.ent IS NOT NULL
                     AND abs(f.cap - f.ent) <= 1 AND f.sal = 0
                THEN 'carga_inicial' ELSE 'conteo' END                 AS tipo_evento,
           CASE WHEN m.c3 = 'A' THEN 'sobrante' ELSE 'faltante' END    AS signo,
           pr.id                                  AS product_id,
           btrim(l.c8)                            AS sku,
           l.c10                                  AS descripcion,
           l.c11                                  AS unidad_erp,
           l.c9::numeric                          AS cantidad,
           l.c12::numeric                         AS costo_unitario,
           l.c13::numeric                         AS importe
      FROM kepler_ods.kdm1 m
      JOIN kepler_ods.kdm2 l
        ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
       AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
      JOIN firma f
        ON f.sucursal = m.sucursal AND f.almacen = m.c1 AND f.fecha = m.c9::date
      JOIN commercial.warehouses w
        ON w.kepler_code = m.sucursal
       AND w.kepler_code <> '00'   -- OFICINAS, no el CEDIS: su existencia es un artefacto
       AND w.deleted_at IS NULL
      LEFT JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id AND pr.sku = btrim(l.c8) AND pr.deleted_at IS NULL
     WHERE m.c2 = 'N' AND m.c4 = '30' AND m.c3 IN ('A', 'D')
       -- ⛔ ANTI-REPLICA: el almacen tiene que PERTENECER a la sucursal. Medido: la
       -- sucursal 03 arrastra 220 cabeceras del almacen 02 (nov-2025 a ene-2026), el mismo
       -- fenomeno que kdil ya documenta. Sin este filtro se atribuyen a 8ESQ documentos que
       -- son de La Piedad. El LIKE conserva los SUB-ALMACENES legitimos (01-006 = Ruta 28).
       AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
       AND btrim(l.c8) <> ALL (ARRAY['00001', '00002', '00022'])
  `);

  await knex.raw('GRANT SELECT ON analytics.v_erp_physical_count_variance TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_erp_physical_count_variance IS
    'IC.0 - Descuadre del conteo fisico de Kepler, por (almacen, fecha, SKU). Derivada de kepler_ods.kdm1/kdm2: N-A-30 sobrante y N-D-30 faltante. tipo_evento distingue conteo de carga_inicial (esta ultima NO es descuadre: es la migracion de una sucursal de Wincaja a Kepler, y son 18.8M de pesos en 06/07/08 que contaminarian cualquier promedio). El join lleva c1 (almacen) y c2/c3 (genero y naturaleza): sin c1 se duplican lineas entre almacenes con el mismo folio, y sin c2/c3 se cuelan doctypes ajenos. Excluye la sucursal 00 (OFICINAS, no el CEDIS) y los pseudo-SKUs contables.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_physical_count_variance');
};
