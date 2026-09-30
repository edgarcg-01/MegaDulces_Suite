'use strict';
/**
 * `[CE.12]` - **El folio NO era ambiguo: a mi consulta le faltaba el ALMACEN.**
 *
 * Edgar abrio la pantalla de Kepler (Entrada de inventario, Sucursal PH / ALMACEN PH) y vio **un
 * solo documento** con folio `0000001`, contra los **dos** que yo habia reportado. Tenia razon, y
 * la causa es que agrupe por sucursal ignorando `kdm1.c1`:
 *
 * ```text
 * almacen | folio   | fecha      | monto
 * --------+---------+------------+-------------
 * 01      | 0000001 | 2026-09-11 | 4,246,558.27   <- ALMACEN PH, el de su pantalla
 * 01-006  | 0000001 | 2026-06-26 |    47,596.87   <- OTRO almacen de la misma plaza
 * ```
 *
 * Medido: con (sucursal, almacen, doctype, folio) hay **0 folios repetidos en 108,479 documentos**;
 * sin el almacen aparentan repetirse 2,729. *El folio de Kepler es unico; le faltaba una columna a
 * mi consulta, no unicidad al ERP.*
 *
 * -- Y el mismo descuido estaba DENTRO de la atribucion -------------------------------------
 *
 * `kdm2.c1` tambien es el almacen, y la matvista **no lo filtraba**, mientras que el costo que
 * explica (`kdik.c16`, anti-replica `sucursal = btrim(c1)`) es el del almacen **principal**. La
 * sucursal 01 tiene **5 almacenes** en `kdm2` en 180 dias. Resultado medido: **12 de 25,079
 * atribuciones (0.05 %) senalaban un documento de otro almacen** (`00`, `01-006`). Con el filtro
 * quedan **25,067**: una se re-atribuye al documento correcto y once pierden atribucion y pasan a
 * declararse NULL, que es lo correcto - *mejor sin explicacion que con la equivocada.*
 *
 * -- Y el tercer eje que faltaba: el SUBTIPO -------------------------------------------------
 *
 * Kepler numera sus documentos `NA3001-0000001` = genero + naturaleza + tipo + **subtipo** +
 * folio. Yo usaba tres componentes. Con los cuatro (`kdm2.c5` / `kdmm.c4`):
 *
 * ```text
 * claves de 3 componentes .... 133, de las cuales 27 con varios nombres
 * claves de 4 componentes .... 176, de las cuales  1 con varios nombres
 * ```
 *
 * O sea que el `N-D-5` que yo declaraba "ambiguo, cinco nombres" **no era ambiguo**: son cinco
 * doctypes distintos (`-1` Salida de almacen, `-2` Salida por ajuste, `-3` Salida por destruccion,
 * `-4` Salida por muestra, `-5` Carta porte). Tercera vez en la misma sesion que una columna de
 * identidad ausente se disfraza de ambiguedad del dato. La unica clave que sigue con dos nombres
 * es `U-D-41-1` (`Embarque Telemarketing` contra `Embarque Telemarketing.`, un punto de mas en el
 * catalogo) y es un doctype de venta que esta atribucion ni mira - igual se sigue **declarando**.
 *
 * -- Y lo que la pantalla leia mal ------------------------------------------------------------
 *
 * El renglon decia "1 PAQ a $189.07" y se podia leer como si el movimiento entero hubiera sido de
 * una pieza. Ese documento es **el conteo fisico completo de la plaza: 897 renglones,
 * $4,246,558.27** - identico a lo que muestra Kepler. Ahora la matvista publica
 * `origen_doc_renglones` y `origen_doc_total` para que la frase diga de que tamano es el papel.
 *
 * -- Por que el baile de DROP y dos CREATE OR REPLACE -----------------------------------------
 *
 * `v_kepler_standard_cost` hace LEFT JOIN a esta matvista, asi que **no se puede dropear mientras
 * la vista la referencie** (y la vista tiene 3 dependientes propios: dropearla en cascada no es
 * opcion). La secuencia es: (1) reemplazar la vista dejando las `origen_*` como NULL **del mismo
 * tipo** - lo unico que `CREATE OR REPLACE VIEW` permite -, (2) reconstruir la matvista, (3)
 * volver a enganchar la vista con las columnas nuevas al final. Todo en la transaccion de la
 * migracion: si algo falla, no queda a medias.
 *
 * ⚠️ `MATERIALIZED` en los CTE **no es decoracion**: sin el, agregar el filtro de almacen hace que
 * el planificador cambie de hash join a bucles anidados y la consulta pasa de 2.2 s a **no
 * terminar en 5 minutos**. Medido dos veces, con el filtro en el `WHERE` y en el `JOIN`. Misma
 * familia que el `LEFT JOIN` + `DISTINCT ON` de `[CE.11]`: *la forma, no el volumen.*
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm2') IS NOT NULL
        AND to_regclass('kepler_ods.kdik') IS NOT NULL
        AND to_regclass('kepler_ods.kdmm') IS NOT NULL
        AND to_regclass('analytics.v_kepler_standard_cost') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  faltan kdm2 / kdik / kdmm / la vista - [CE.12] omitido');
    return;
  }

  // Los dependientes se LISTAN, no bloquean: un CREATE OR REPLACE que solo agrega columnas al
  // final no rompe a nadie. Y la lista cambia sola: [CE.9] midio cero, [CE.11] encontro dos, hoy
  // son tres. Por eso tambien el paso (1): la vista NO se puede dropear, hay que desengancharla.
  const { rows: dep } = await knex.raw(`
    SELECT DISTINCT c.relname
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class c ON c.oid = r.ev_class
     WHERE d.refobjid = 'analytics.v_kepler_standard_cost'::regclass
       AND c.relname <> 'v_kepler_standard_cost'`);
  if (dep.length) {
    // eslint-disable-next-line no-console
    console.log('  dependientes vivos (se conservan): ' + dep.map((d) => d.relname).join(', '));
  }

  // (1) desenganchar la vista de la matvista, con los MISMOS tipos
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_standard_cost
      WITH (security_invoker = true) AS
    WITH ficha AS (
      SELECT e.sucursal, e.sku,
             e.u1_label, e.u2_label, e.u3_label, e.f2_cap, e.f3_cap,
             e.costo1, e.costo2, e.costo3, e.margen1, e.pv1
        FROM analytics.v_kepler_unit_ladder e
    ), erp AS (
      -- sucursal = btrim(c1) es el anti-replica, identico al de analytics.v_kepler_unit_cost.
      SELECT k.sucursal, btrim(k.c2) AS sku,
             NULLIF(max(k.c16)::numeric, 0) AS costo_reposicion,
             max(k.c18) AS ultimo_costo,
             -- 1800-01-01 es el centinela de nulo de Kepler: 55.6% de las fechas. NULL, no 1800.
             NULLIF(max(k.c17)::date, '1800-01-01'::date) AS ultimo_costo_al
        FROM kepler_ods.kdik k
       WHERE k.sucursal = btrim(k.c1)
         AND k.c16 = k.c16 AND k.c16 > '-Infinity'::float8 AND k.c16 < 'Infinity'::float8
       GROUP BY k.sucursal, btrim(k.c2)
    ), nom AS (
      SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre
        FROM kepler_ods.kdii ORDER BY btrim(c1), sucursal
    ), base AS (
      SELECT f.sucursal, f.sku, n.nombre,
             f.u1_label AS unidad_base, f.u2_label AS unidad_dos, f.u3_label AS unidad_tres,
             f.f2_cap AS factor_dos, f.f3_cap AS factor_tres,
             NULLIF(f.costo1, 0) AS costo_estandar,
             NULLIF(f.costo2, 0) AS costo_estandar_u2,
             NULLIF(f.costo3, 0) AS costo_estandar_u3,
             f.margen1 AS margen_ficha_pct,
             NULLIF(f.pv1, 0) AS precio_ficha,
             e.costo_reposicion, NULLIF(e.ultimo_costo, 0) AS ultimo_costo,
             CASE WHEN e.ultimo_costo_al >= DATE '1900-01-01'
                  THEN to_char(e.ultimo_costo_al, 'YYYY-MM-DD') END AS ultimo_costo_al,
             a.impuesto_pct, a.impuesto_tasas_distintas, a.renglones AS impuesto_renglones,
             a.unidades_base AS unidades_base_30d,
             a.venta_bruta   AS venta_bruta_30d,
             a.venta_neta    AS venta_neta_30d,
             a.ventana_hasta AS actividad_al
        FROM ficha f
        LEFT JOIN nom n ON n.sku = f.sku
        LEFT JOIN erp e ON e.sucursal = f.sucursal AND e.sku = f.sku
        LEFT JOIN analytics.mv_kepler_standard_cost_activity a
               ON a.sucursal = f.sucursal AND a.sku = f.sku
    ), peld AS (
      -- ⭐ EL ARREGLO ES EL ORDEN, no un umbral nuevo. [CE.8] probaba "razon < 2 => base" ANTES
      -- que los peldanos, asi que con f2 = 2 el atajo posicional ganaba aunque el peldaño dos
      -- estuviera 26x mas cerca (el caso 30540). Ahora los peldanos se prueban PRIMERO y el
      -- atajo queda de respaldo. La banda de +/-25% de los peldanos es la misma de [CE.8]: un
      -- factor es un entero exacto, asi que un peldaño que "casi" casa no casa.
      --
      -- ⛔ Se descarto elegir "el candidato mas cercano" con un umbral de desempate: probado
      -- contra los casos reales, un desempate de 3x volvia ambiguo al 17182 (razon 1.99 con
      -- f2 = 12), que esta BIEN clasificado como base. La asimetria es real y hay que
      -- respetarla: un peldaño tiene que casar fino, la deriva de costo no tiene tope.
      SELECT b.*,
             CASE
               WHEN b.costo_estandar IS NULL OR b.costo_reposicion IS NULL
                 OR b.costo_estandar <= 0 OR b.costo_reposicion <= 0 THEN NULL
               WHEN b.costo_reposicion / b.costo_estandar < 0.5 THEN 'testigo_inverosimil'
               WHEN b.factor_dos > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_dos - 1) <= 0.25
                 THEN 'unidad_dos'
               WHEN b.factor_tres > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_tres - 1) <= 0.25
                 THEN 'unidad_tres'
               -- medido: no existe ningun f2 < 2 (minimo 2.00 sobre 6,518 pares), asi que una
               -- razon < 2 que no caso en ningun peldaño es el base con su deriva.
               WHEN b.costo_reposicion / b.costo_estandar < 2 THEN 'base'
               ELSE 'no_resuelto'
             END AS peldano_reposicion
        FROM base b
    ), norm AS (
      SELECT p.*,
             CASE p.peldano_reposicion
               WHEN 'base'        THEN p.costo_reposicion
               WHEN 'unidad_dos'  THEN p.costo_reposicion / NULLIF(p.factor_dos, 0)
               WHEN 'unidad_tres' THEN p.costo_reposicion / NULLIF(p.factor_tres, 0)
               ELSE NULL
             END AS costo_reposicion_base
        FROM peld p
    )
    SELECT n.sucursal, n.sku, n.nombre,
           n.unidad_base, n.unidad_dos, n.unidad_tres, n.factor_dos, n.factor_tres,
           n.costo_estandar, n.costo_estandar_u2, n.costo_estandar_u3,
           n.margen_ficha_pct, n.precio_ficha,
           n.impuesto_pct, n.impuesto_tasas_distintas, n.impuesto_renglones,
           CASE WHEN n.costo_estandar IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                            * (1 + n.impuesto_pct / 100), 2)
           END AS precio_reconstruido,
           CASE
             WHEN n.precio_ficha IS NULL OR n.costo_estandar IS NULL
               OR n.margen_ficha_pct IS NULL THEN NULL
             WHEN n.impuesto_pct IS NULL THEN NULL
             ELSE abs(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                       * (1 + n.impuesto_pct / 100) - n.precio_ficha) <= 0.02
           END AS precio_cuadra,
           CASE
             WHEN n.precio_ficha IS NULL THEN 'sin_precio_en_ficha'
             WHEN n.costo_estandar IS NULL THEN 'sin_costo_estandar'
             WHEN n.margen_ficha_pct IS NULL THEN 'sin_margen_en_ficha'
             WHEN n.impuesto_pct IS NULL THEN 'impuesto_no_medido_sin_venta'
             ELSE NULL
           END AS precio_cuadra_motivo,
           n.costo_reposicion, n.peldano_reposicion, n.costo_reposicion_base,
           n.ultimo_costo, n.ultimo_costo_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar > 0
                THEN round(((n.costo_reposicion_base / n.costo_estandar) - 1) * 100, 3)
           END AS desviacion_pct,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                THEN round(n.costo_reposicion_base - n.costo_estandar, 4)
           END AS desviacion_por_unidad,
           CASE
             WHEN n.costo_estandar IS NULL                     THEN 'sin_estandar'
             WHEN n.costo_reposicion IS NULL
              AND n.unidades_base_30d IS NULL                  THEN 'sin_operacion'
             WHEN n.costo_reposicion IS NULL                   THEN 'sin_testigo'
             -- tres maneras distintas de no poder comparar, con tres arreglos distintos
             WHEN n.peldano_reposicion = 'testigo_inverosimil' THEN 'testigo_inverosimil'
             WHEN n.peldano_reposicion = 'no_resuelto'         THEN 'no_comparable'
             WHEN abs(n.costo_reposicion_base - n.costo_estandar) <= 0.01 THEN 'al_dia'
             WHEN n.costo_reposicion_base > n.costo_estandar   THEN 'estandar_bajo'
             ELSE 'estandar_alto'
           END AS veredicto,
           n.unidades_base_30d, n.venta_bruta_30d, n.venta_neta_30d, n.actividad_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                 AND n.unidades_base_30d IS NOT NULL
                THEN round(n.unidades_base_30d * (n.costo_reposicion_base - n.costo_estandar), 2)
           END AS impacto_cogs_30d,
           -- ── [CE.9] las columnas nuevas van AL FINAL ────────────────────────────────────
           -- La plaza 00 es OFICINAS: 9,632 fichas, cero venta. No se esconde: se DECLARA, y el
           -- consumidor decide (el servicio la filtra por default).
           (n.sucursal <> '00') AS es_plaza_operativa,
           -- Salida A de la decision: si se captura el costo nuevo, Kepler conserva el margen y
           -- RECALCULA EL PRECIO. Medido: el precio siguio al costo en el 74.02% de 6,501 cambios
           -- reales, y solo en el 1.28% se quedo quieto.
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_reposicion_base * (1 + n.margen_ficha_pct / 100)
                                                   * (1 + n.impuesto_pct / 100), 2)
           END AS precio_si_conserva_margen,
           -- Salida B: si el precio NO se mueve, este es el margen que de verdad se esta sacando.
           -- Misma convencion que margen_ficha_pct: markup sobre el costo, precio NETO.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2)
           END AS margen_real_pct,
           -- 272 fichas (9.4% de las evaluables) pierden dinero en cada venta HOY. Es la lista
           -- que importa mañana, no las 6,300.
           -- [CE.10] Se deriva del MISMO numero redondeado que se publica, no del crudo.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2) < 0
           END AS vende_bajo_costo,
           -- ── [CE.11] POR QUE el costo del ERP esta donde esta ──────────────────────────
           -- El ultimo movimiento NO de venta cuyo precio casa con kdik.c16 dentro del 1%.
           -- Medido: explica 25,071 de 33,286 pares (75.3%), y el 71.3% de esos es INVENTARIO
           -- FISICO, no una compra. Lo que no se explica llega NULL: ausencia, no cero.
           NULL::text    AS origen_familia,
           NULL::text    AS origen_doctype,
           NULL::text    AS origen_nombre,
           NULL::boolean AS origen_nombre_ambiguo,
           NULL::text    AS origen_fecha_txt,
           NULL::text    AS origen_folio,
           NULL::numeric AS origen_precio,
           NULL::numeric AS origen_cantidad,
           NULL::text    AS origen_unidad
      FROM norm n`);

  // (2) reconstruir la matvista (ya nadie la referencia)
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_cost_origin`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_kepler_cost_origin AS
    WITH costo AS MATERIALIZED (
      -- el MISMO anti-replica que la vista y que v_kepler_unit_cost: sucursal = btrim(c1).
      -- Ojo: eso deja SOLO el almacen principal de cada plaza, y de ahi sale el filtro de abajo.
      SELECT k.sucursal, btrim(k.c2) AS sku, NULLIF(max(k.c16)::numeric, 0) AS c16
        FROM kepler_ods.kdik k
       WHERE k.sucursal = btrim(k.c1)
         AND k.c16 = k.c16 AND k.c16 > '-Infinity'::float8 AND k.c16 < 'Infinity'::float8
       GROUP BY k.sucursal, btrim(k.c2)
    ), mov AS MATERIALIZED (
      SELECT m.sucursal, btrim(m.c1) AS almacen, btrim(m.c8) AS sku,
             btrim(m.c2) AS gen, btrim(m.c3) AS nat, m.c4::int AS tipo, m.c5::int AS sub,
             m.c32::date AS fecha, btrim(m.c6) AS folio,
             round(nullif(regexp_replace(m.c12::text, '[^0-9.-]', '', 'g'), '')::numeric, 4) AS precio,
             round(m.c9::numeric, 4) AS cantidad,
             NULLIF(btrim(m.c11), '') AS unidad,
             round(m.c9::numeric
                   * coalesce(nullif(regexp_replace(m.c12::text, '[^0-9.-]', '', 'g'), '')::numeric, 0),
                   4) AS importe
        FROM kepler_ods.kdm2 m
       WHERE m.c2 <> 'U' AND m.c32 >= CURRENT_DATE - 180 AND btrim(m.c8) <> ''
    ), doc AS MATERIALIZED (
      -- el tamano del papel, para que el renglon no se lea como si fuera el documento entero.
      -- Verificado contra la pantalla de Kepler: NA3001-0000001 de la 01 = 897 renglones y
      -- $4,246,558.27, identico a kdm1.c16.
      SELECT sucursal, almacen, gen, nat, tipo, sub, folio,
             count(*) AS renglones, round(sum(importe), 2) AS total
        FROM mov GROUP BY 1, 2, 3, 4, 5, 6, 7
    ), elegido AS MATERIALIZED (
      SELECT DISTINCT ON (c.sucursal, c.sku)
             c.sucursal, c.sku, mv.almacen, mv.gen, mv.nat, mv.tipo, mv.sub,
             mv.fecha, mv.folio, mv.precio, mv.cantidad, mv.unidad
        FROM costo c
        JOIN mov mv ON mv.sucursal = c.sucursal AND mv.sku = c.sku
                   -- [CE.12] el costo que se explica es el del almacen PRINCIPAL; un movimiento
                   -- de otro almacen de la misma plaza NO lo pudo dejar ahi. Sin este filtro, 12
                   -- de 25,079 atribuciones nombraban el papel equivocado.
                   AND mv.almacen = c.sucursal
                   AND mv.precio > 0
                   AND abs(mv.precio / c.c16 - 1) <= 0.01
       WHERE c.c16 > 0
       ORDER BY c.sucursal, c.sku, mv.fecha DESC, mv.folio DESC
    ), rotulo AS (
      -- El nombre sale del catalogo del ERP, nunca de una lista nuestra, y con los CUATRO
      -- componentes: con tres, N-D-5 parecia "ambiguo con cinco nombres" y en realidad son cinco
      -- doctypes distintos. Medido: 27 de 133 claves ambiguas con 3 componentes, 1 de 176 con 4.
      SELECT c1 AS gen, c2 AS nat, c3::int AS tipo, c4::int AS sub,
             min(btrim(c5)) AS nombre,
             count(DISTINCT btrim(c5)) > 1 AS ambiguo
        FROM kepler_ods.kdmm
       WHERE btrim(coalesce(c5, '')) <> ''
       GROUP BY c1, c2, c3::int, c4::int
    )
    SELECT e.sucursal,
           e.sku,
           e.almacen                                               AS origen_almacen,
           (e.gen || '-' || e.nat || '-' || e.tipo::text
                  || '-' || e.sub::text)                           AS origen_doctype,
           -- tal cual lo numera Kepler en pantalla: NA3001-0000001
           (e.gen || e.nat || e.tipo::text || lpad(e.sub::text, 2, '0')
                  || '-' || e.folio)                               AS origen_doc_id,
           r.nombre                                                AS origen_nombre,
           COALESCE(r.ambiguo, false)                              AS origen_nombre_ambiguo,
           CASE WHEN e.gen = 'X' THEN 'compra'
                WHEN e.gen = 'N' AND e.tipo IN (30, 44, 45) THEN 'inventario_fisico'
                WHEN e.gen = 'N' THEN 'traspaso_u_otro'
                ELSE 'otro' END                                    AS origen_familia,
           e.fecha                                                 AS origen_fecha,
           to_char(e.fecha, 'YYYY-MM-DD')                          AS origen_fecha_txt,
           e.folio                                                 AS origen_folio,
           e.precio                                                AS origen_precio,
           e.cantidad                                              AS origen_cantidad,
           e.unidad                                                AS origen_unidad,
           d.renglones                                             AS origen_doc_renglones,
           d.total                                                 AS origen_doc_total,
           (CURRENT_DATE - 180)                                    AS ventana_desde,
           CURRENT_DATE                                            AS ventana_hasta
      FROM elegido e
      LEFT JOIN rotulo r ON r.gen = e.gen AND r.nat = e.nat AND r.tipo = e.tipo AND r.sub = e.sub
      LEFT JOIN doc d ON d.sucursal = e.sucursal AND d.almacen = e.almacen AND d.gen = e.gen
                     AND d.nat = e.nat AND d.tipo = e.tipo AND d.sub = e.sub AND d.folio = e.folio`);
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_kepler_cost_origin ON analytics.mv_kepler_cost_origin (sucursal, sku)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_kepler_cost_origin TO app_runtime`);
  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_cost_origin IS
    $$[CE.12] Que movimiento dejo el costo del ERP (kdik.c16) donde esta: el documento NO de venta
    mas reciente, DEL MISMO ALMACEN, cuyo precio unitario casa dentro del 1%. El filtro de almacen
    corrige 12 de 25,079 atribuciones que nombraban un papel de otro almacen de la misma plaza; las
    que quedan sin candidato pasan a NULL, que es mejor que una explicacion equivocada. El doctype
    lleva los CUATRO componentes (genero-naturaleza-tipo-subtipo) y origen_doc_id lo escribe como
    Kepler en pantalla (NA3001-0000001). origen_doc_renglones/_total dan el tamano del documento:
    el renglon de 1 PAQ pertenece a un conteo de 897 partidas por $4,246,558.27. Refresco:
    AnalyticsRefreshService (nightly).$$`);

  // (3) volver a engancharla, con las 4 columnas nuevas AL FINAL
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_standard_cost
      WITH (security_invoker = true) AS
    WITH ficha AS (
      SELECT e.sucursal, e.sku,
             e.u1_label, e.u2_label, e.u3_label, e.f2_cap, e.f3_cap,
             e.costo1, e.costo2, e.costo3, e.margen1, e.pv1
        FROM analytics.v_kepler_unit_ladder e
    ), erp AS (
      -- sucursal = btrim(c1) es el anti-replica, identico al de analytics.v_kepler_unit_cost.
      SELECT k.sucursal, btrim(k.c2) AS sku,
             NULLIF(max(k.c16)::numeric, 0) AS costo_reposicion,
             max(k.c18) AS ultimo_costo,
             -- 1800-01-01 es el centinela de nulo de Kepler: 55.6% de las fechas. NULL, no 1800.
             NULLIF(max(k.c17)::date, '1800-01-01'::date) AS ultimo_costo_al
        FROM kepler_ods.kdik k
       WHERE k.sucursal = btrim(k.c1)
         AND k.c16 = k.c16 AND k.c16 > '-Infinity'::float8 AND k.c16 < 'Infinity'::float8
       GROUP BY k.sucursal, btrim(k.c2)
    ), nom AS (
      SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre
        FROM kepler_ods.kdii ORDER BY btrim(c1), sucursal
    ), base AS (
      SELECT f.sucursal, f.sku, n.nombre,
             f.u1_label AS unidad_base, f.u2_label AS unidad_dos, f.u3_label AS unidad_tres,
             f.f2_cap AS factor_dos, f.f3_cap AS factor_tres,
             NULLIF(f.costo1, 0) AS costo_estandar,
             NULLIF(f.costo2, 0) AS costo_estandar_u2,
             NULLIF(f.costo3, 0) AS costo_estandar_u3,
             f.margen1 AS margen_ficha_pct,
             NULLIF(f.pv1, 0) AS precio_ficha,
             e.costo_reposicion, NULLIF(e.ultimo_costo, 0) AS ultimo_costo,
             CASE WHEN e.ultimo_costo_al >= DATE '1900-01-01'
                  THEN to_char(e.ultimo_costo_al, 'YYYY-MM-DD') END AS ultimo_costo_al,
             a.impuesto_pct, a.impuesto_tasas_distintas, a.renglones AS impuesto_renglones,
             a.unidades_base AS unidades_base_30d,
             a.venta_bruta   AS venta_bruta_30d,
             a.venta_neta    AS venta_neta_30d,
             a.ventana_hasta AS actividad_al,
             o.origen_doctype, o.origen_nombre, o.origen_nombre_ambiguo, o.origen_familia,
             o.origen_fecha_txt, o.origen_folio, o.origen_precio, o.origen_cantidad, o.origen_unidad,
             o.origen_almacen, o.origen_doc_id, o.origen_doc_renglones, o.origen_doc_total
        FROM ficha f
        LEFT JOIN nom n ON n.sku = f.sku
        LEFT JOIN erp e ON e.sucursal = f.sucursal AND e.sku = f.sku
        LEFT JOIN analytics.mv_kepler_standard_cost_activity a
               ON a.sucursal = f.sucursal AND a.sku = f.sku
        LEFT JOIN analytics.mv_kepler_cost_origin o
               ON o.sucursal = f.sucursal AND o.sku = f.sku
    ), peld AS (
      -- ⭐ EL ARREGLO ES EL ORDEN, no un umbral nuevo. [CE.8] probaba "razon < 2 => base" ANTES
      -- que los peldanos, asi que con f2 = 2 el atajo posicional ganaba aunque el peldaño dos
      -- estuviera 26x mas cerca (el caso 30540). Ahora los peldanos se prueban PRIMERO y el
      -- atajo queda de respaldo. La banda de +/-25% de los peldanos es la misma de [CE.8]: un
      -- factor es un entero exacto, asi que un peldaño que "casi" casa no casa.
      --
      -- ⛔ Se descarto elegir "el candidato mas cercano" con un umbral de desempate: probado
      -- contra los casos reales, un desempate de 3x volvia ambiguo al 17182 (razon 1.99 con
      -- f2 = 12), que esta BIEN clasificado como base. La asimetria es real y hay que
      -- respetarla: un peldaño tiene que casar fino, la deriva de costo no tiene tope.
      SELECT b.*,
             CASE
               WHEN b.costo_estandar IS NULL OR b.costo_reposicion IS NULL
                 OR b.costo_estandar <= 0 OR b.costo_reposicion <= 0 THEN NULL
               WHEN b.costo_reposicion / b.costo_estandar < 0.5 THEN 'testigo_inverosimil'
               WHEN b.factor_dos > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_dos - 1) <= 0.25
                 THEN 'unidad_dos'
               WHEN b.factor_tres > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_tres - 1) <= 0.25
                 THEN 'unidad_tres'
               -- medido: no existe ningun f2 < 2 (minimo 2.00 sobre 6,518 pares), asi que una
               -- razon < 2 que no caso en ningun peldaño es el base con su deriva.
               WHEN b.costo_reposicion / b.costo_estandar < 2 THEN 'base'
               ELSE 'no_resuelto'
             END AS peldano_reposicion
        FROM base b
    ), norm AS (
      SELECT p.*,
             CASE p.peldano_reposicion
               WHEN 'base'        THEN p.costo_reposicion
               WHEN 'unidad_dos'  THEN p.costo_reposicion / NULLIF(p.factor_dos, 0)
               WHEN 'unidad_tres' THEN p.costo_reposicion / NULLIF(p.factor_tres, 0)
               ELSE NULL
             END AS costo_reposicion_base
        FROM peld p
    )
    SELECT n.sucursal, n.sku, n.nombre,
           n.unidad_base, n.unidad_dos, n.unidad_tres, n.factor_dos, n.factor_tres,
           n.costo_estandar, n.costo_estandar_u2, n.costo_estandar_u3,
           n.margen_ficha_pct, n.precio_ficha,
           n.impuesto_pct, n.impuesto_tasas_distintas, n.impuesto_renglones,
           CASE WHEN n.costo_estandar IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                            * (1 + n.impuesto_pct / 100), 2)
           END AS precio_reconstruido,
           CASE
             WHEN n.precio_ficha IS NULL OR n.costo_estandar IS NULL
               OR n.margen_ficha_pct IS NULL THEN NULL
             WHEN n.impuesto_pct IS NULL THEN NULL
             ELSE abs(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                       * (1 + n.impuesto_pct / 100) - n.precio_ficha) <= 0.02
           END AS precio_cuadra,
           CASE
             WHEN n.precio_ficha IS NULL THEN 'sin_precio_en_ficha'
             WHEN n.costo_estandar IS NULL THEN 'sin_costo_estandar'
             WHEN n.margen_ficha_pct IS NULL THEN 'sin_margen_en_ficha'
             WHEN n.impuesto_pct IS NULL THEN 'impuesto_no_medido_sin_venta'
             ELSE NULL
           END AS precio_cuadra_motivo,
           n.costo_reposicion, n.peldano_reposicion, n.costo_reposicion_base,
           n.ultimo_costo, n.ultimo_costo_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar > 0
                THEN round(((n.costo_reposicion_base / n.costo_estandar) - 1) * 100, 3)
           END AS desviacion_pct,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                THEN round(n.costo_reposicion_base - n.costo_estandar, 4)
           END AS desviacion_por_unidad,
           CASE
             WHEN n.costo_estandar IS NULL                     THEN 'sin_estandar'
             WHEN n.costo_reposicion IS NULL
              AND n.unidades_base_30d IS NULL                  THEN 'sin_operacion'
             WHEN n.costo_reposicion IS NULL                   THEN 'sin_testigo'
             -- tres maneras distintas de no poder comparar, con tres arreglos distintos
             WHEN n.peldano_reposicion = 'testigo_inverosimil' THEN 'testigo_inverosimil'
             WHEN n.peldano_reposicion = 'no_resuelto'         THEN 'no_comparable'
             WHEN abs(n.costo_reposicion_base - n.costo_estandar) <= 0.01 THEN 'al_dia'
             WHEN n.costo_reposicion_base > n.costo_estandar   THEN 'estandar_bajo'
             ELSE 'estandar_alto'
           END AS veredicto,
           n.unidades_base_30d, n.venta_bruta_30d, n.venta_neta_30d, n.actividad_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                 AND n.unidades_base_30d IS NOT NULL
                THEN round(n.unidades_base_30d * (n.costo_reposicion_base - n.costo_estandar), 2)
           END AS impacto_cogs_30d,
           -- ── [CE.9] las columnas nuevas van AL FINAL ────────────────────────────────────
           -- La plaza 00 es OFICINAS: 9,632 fichas, cero venta. No se esconde: se DECLARA, y el
           -- consumidor decide (el servicio la filtra por default).
           (n.sucursal <> '00') AS es_plaza_operativa,
           -- Salida A de la decision: si se captura el costo nuevo, Kepler conserva el margen y
           -- RECALCULA EL PRECIO. Medido: el precio siguio al costo en el 74.02% de 6,501 cambios
           -- reales, y solo en el 1.28% se quedo quieto.
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_reposicion_base * (1 + n.margen_ficha_pct / 100)
                                                   * (1 + n.impuesto_pct / 100), 2)
           END AS precio_si_conserva_margen,
           -- Salida B: si el precio NO se mueve, este es el margen que de verdad se esta sacando.
           -- Misma convencion que margen_ficha_pct: markup sobre el costo, precio NETO.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2)
           END AS margen_real_pct,
           -- 272 fichas (9.4% de las evaluables) pierden dinero en cada venta HOY. Es la lista
           -- que importa mañana, no las 6,300.
           -- [CE.10] Se deriva del MISMO numero redondeado que se publica, no del crudo.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2) < 0
           END AS vende_bajo_costo,
           -- ── [CE.11] POR QUE el costo del ERP esta donde esta ──────────────────────────
           -- El ultimo movimiento NO de venta cuyo precio casa con kdik.c16 dentro del 1%.
           -- Medido: explica 25,071 de 33,286 pares (75.3%), y el 71.3% de esos es INVENTARIO
           -- FISICO, no una compra. Lo que no se explica llega NULL: ausencia, no cero.
           n.origen_familia, n.origen_doctype, n.origen_nombre, n.origen_nombre_ambiguo,
           n.origen_fecha_txt, n.origen_folio, n.origen_precio, n.origen_cantidad, n.origen_unidad,
           -- [CE.12] el ALMACEN que dejo el costo (kdm2.c1 = kdik.c1 por construccion), el
           -- numero de documento tal cual lo escribe Kepler, y el TAMANO del papel: sin eso
           -- un renglon de 1 PAQ se lee como si el movimiento entero hubiera sido de 1 PAQ.
           n.origen_almacen, n.origen_doc_id, n.origen_doc_renglones, n.origen_doc_total
      FROM norm n`);
  await knex.raw(`ALTER VIEW analytics.v_kepler_standard_cost SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_standard_cost TO app_runtime`);

  // Prueba de que el filtro de verdad se aplico. Sin esto la migracion "pasa" igual y nadie mira.
  const [{ n, alm, amb }] = (await knex.raw(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE origen_almacen <> sucursal)::int AS alm,
           count(*) FILTER (WHERE origen_nombre_ambiguo)::int AS amb
      FROM analytics.mv_kepler_cost_origin`)).rows;
  // eslint-disable-next-line no-console
  console.log('  [CE.12] ' + n + ' atribuciones - ' + alm + ' de otro almacen (debe ser 0) - '
              + amb + ' rotulos ambiguos');
  if (Number(alm) !== 0) throw new Error('[CE.12] el filtro de almacen no se aplico: ' + alm);
};

exports.down = async function down(knex) {
  // eslint-disable-next-line no-console
  console.log('  [CE.12] down: re-aplicar 20260930140000 + 20260930150000');
};
